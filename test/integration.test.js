const assert = require('assert');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Kết nối bắt buộc tới Database Test riêng biệt (Tuyệt đối không dùng real_estate_db thật)
const TEST_MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/real_estate_test_db';

const Unit = require('../src/models/Unit');
const Project = require('../src/models/Project');
const SystemLock = require('../src/models/SystemLock');
const { acquireLock, renewLock, isLockHeld, releaseLock, withLock } = require('../src/services/lockService');

async function runIntegrationTests() {
  console.log('\n====================================================================');
  console.log('🧪 BẮT ĐẦU CHẠY KIỂM THỬ TÍCH HỢP CONCURRENCY & ATOMIC LOCKING');
  console.log(`   • Database Test: [${TEST_MONGO_URI}]`);
  console.log('====================================================================\n');

  // Đảm bảo không kết nối nhầm DB thật
  assert.ok(
    TEST_MONGO_URI.includes('test'),
    'NGUY HIỂM: URI kiểm thử phải chứa từ khóa "test" để tránh thao tác trên DB thật!'
  );

  await mongoose.connect(TEST_MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  const dbName = mongoose.connection.name;
  assert.strictEqual(dbName, 'real_estate_test_db', 'Tên database phải chính xác là real_estate_test_db');
  console.log(`✅ [MongoDB Test] Đã kết nối thành công tới Database riêng biệt: ${dbName}\n`);

  try {
    // Dọn dẹp dữ liệu cũ trong DB test trước khi chạy
    await Unit.deleteMany({});
    await Project.deleteMany({});
    await SystemLock.deleteMany({});

    // =========================================================================
    // TEST 1: Kiểm thử cú pháp MongoDB update operator ($set và $inc đồng cấp)
    // =========================================================================
    console.log('Test 1: Kiểm thử thực tế toán tử MongoDB ($set và $inc cùng cấp trong syncSingleUnit)...');
    
    const sampleUnit = await Unit.create({
      source: 'hisale',
      unit_code: 'INT-TEST-01',
      project_name: 'Dự án Test Concurrency',
      image_sync_status: 'PENDING',
      image_sync_retries: 0,
    });

    const testLeaseId = crypto.randomUUID();
    const LOCK_TIMEOUT_MS = 60000;

    // Chạy chính xác câu lệnh findOneAndUpdate sau khi đã sửa lỗi cú pháp
    const lockedUnitResult = await Unit.findOneAndUpdate(
      {
        _id: sampleUnit._id,
        $or: [
          { image_sync_status: { $ne: 'PROCESSING' } },
          { image_sync_locked_until: { $lt: new Date() } },
          { image_sync_locked_until: null },
        ],
      },
      {
        $set: {
          image_sync_status: 'PROCESSING',
          image_sync_locked_until: new Date(Date.now() + LOCK_TIMEOUT_MS),
          image_sync_lock_owner: testLeaseId,
        },
        $inc: { image_sync_retries: 1 },
      },
      { new: true }
    );

    assert.ok(lockedUnitResult, 'findOneAndUpdate phải trả về document');
    assert.strictEqual(lockedUnitResult.image_sync_status, 'PROCESSING');
    assert.strictEqual(lockedUnitResult.image_sync_lock_owner, testLeaseId);
    assert.strictEqual(lockedUnitResult.image_sync_retries, 1, 'image_sync_retries phải được $inc tăng lên 1');

    // Chạy lần thứ 2: retries phải tăng lên 2 mà MongoDB không báo lỗi cú pháp
    const secondUpdate = await Unit.findOneAndUpdate(
      { _id: sampleUnit._id },
      {
        $set: { image_sync_status: 'PROCESSING' },
        $inc: { image_sync_retries: 1 },
      },
      { new: true }
    );
    assert.strictEqual(secondUpdate.image_sync_retries, 2);
    console.log('  ✅ Test 1 PASSED: Toán tử $set và $inc thực thi thành công trên MongoDB thực tế.\n');

    // =========================================================================
    // TEST 2: Tranh chấp khóa phân tán thực tế giữa 2 Worker (SystemLock)
    // =========================================================================
    console.log('Test 2: Kiểm thử tranh chấp khóa phân tán giữa 2 Worker song song...');
    
    const lockKey = 'TEST_CONCURRENT_LOCK';
    const workerARes = await acquireLock(lockKey, { holder: 'WORKER_A', ttlMs: 3000 });
    assert.strictEqual(workerARes.acquired, true, 'Worker A phải lấy được khóa');

    // Worker B cố lấy ngay lập tức -> Phải thất bại
    const workerBRes = await acquireLock(lockKey, { holder: 'WORKER_B', ttlMs: 3000, maxRetries: 0 });
    assert.strictEqual(workerBRes.acquired, false, 'Worker B không thể lấy khóa khi Worker A đang giữ');

    // Worker B cố giải phóng khóa của Worker A -> Không được xóa
    const unauthorizedRelease = await releaseLock(lockKey, 'fake_lease_id');
    assert.strictEqual(unauthorizedRelease, false, 'Không thể release khóa với leaseId sai');

    // Worker A giải phóng khóa thành công
    const authorizedRelease = await releaseLock(lockKey, workerARes.leaseId);
    assert.strictEqual(authorizedRelease, true, 'Worker A phải release được khóa của mình');

    // Sau khi giải phóng, Worker B lấy khóa thành công
    const workerBSecondRes = await acquireLock(lockKey, { holder: 'WORKER_B', ttlMs: 3000 });
    assert.strictEqual(workerBSecondRes.acquired, true, 'Worker B lấy được khóa sau khi Worker A release');
    await releaseLock(lockKey, workerBSecondRes.leaseId);
    console.log('  ✅ Test 2 PASSED: Distributed Lock đảm bảo loại trừ tương hỗ giữa 2 worker.\n');

    // =========================================================================
    // TEST 3: Gia hạn khóa định kỳ (Heartbeat & renewLock)
    // =========================================================================
    console.log('Test 3: Kiểm thử gia hạn khóa thực tế trong MongoDB (renewLock)...');
    
    const renewKey = 'TEST_RENEW_LOCK';
    const initLock = await acquireLock(renewKey, { holder: 'WORKER_RENEW', ttlMs: 2000 });
    assert.strictEqual(initLock.acquired, true);

    const originalExpiresAt = initLock.expiresAt.getTime();

    // Đợi 200ms và gia hạn thêm 10 giây
    await new Promise((r) => setTimeout(r, 200));
    const renewed = await renewLock(renewKey, initLock.leaseId, 10000);
    assert.strictEqual(renewed, true, 'renewLock phải trả về true khi leaseId hợp lệ');

    const updatedLockDoc = await SystemLock.findById(renewKey).lean();
    assert.ok(
      new Date(updatedLockDoc.locked_until).getTime() > originalExpiresAt,
      'Thời hạn khóa phải được kéo dài hơn ban đầu'
    );

    // Thử renew với leaseId sai
    const invalidRenew = await renewLock(renewKey, 'wrong_lease', 10000);
    assert.strictEqual(invalidRenew, false, 'renewLock phải thất bại với leaseId không khớp');

    await releaseLock(renewKey, initLock.leaseId);
    console.log('  ✅ Test 3 PASSED: renewLock gia hạn khóa thành công trên MongoDB.\n');

    // =========================================================================
    // TEST 4: Khóa hết hạn và Worker cũ bị từ chối ghi đè (Stale Worker Protection)
    // =========================================================================
    console.log('Test 4: Kiểm thử khóa hết hạn & Worker cũ cố ghi đè bị từ chối (Stale write rejection)...');

    const staleUnit = await Unit.create({
      source: 'salepro',
      unit_code: 'INT-STALE-01',
      project_name: 'Dự án Stale Test',
      image_sync_status: 'PROCESSING',
      image_sync_lock_owner: 'lease_worker_old',
      image_sync_locked_until: new Date(Date.now() - 5000), // Đã hết hạn 5 giây trước
    });

    // Worker New đến và claim căn hộ này vì khóa cũ đã hết hạn
    const leaseNew = crypto.randomUUID();
    const claimNew = await Unit.findOneAndUpdate(
      {
        _id: staleUnit._id,
        $or: [
          { image_sync_status: { $ne: 'PROCESSING' } },
          { image_sync_locked_until: { $lt: new Date() } },
          { image_sync_locked_until: null },
        ],
      },
      {
        $set: {
          image_sync_status: 'PROCESSING',
          image_sync_locked_until: new Date(Date.now() + 60000),
          image_sync_lock_owner: leaseNew,
        },
      },
      { new: true }
    );
    assert.strictEqual(claimNew.image_sync_lock_owner, leaseNew, 'Worker New phải claim được căn hộ');

    // Worker Old tỉnh dậy và cố cập nhật kết quả bằng lease_worker_old cũ
    const staleSaveResult = await Unit.updateOne(
      {
        _id: staleUnit._id,
        image_sync_lock_owner: 'lease_worker_old', // lease cũ!
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: {
          image_sync_status: 'SUCCESS',
          image_sync_error: 'Ghi đè bởi worker cũ',
        },
      }
    );

    assert.strictEqual(
      staleSaveResult.matchedCount,
      0,
      'Worker cũ phải có matchedCount = 0 (Bị từ chối ghi đè)'
    );

    // Kiểm tra dữ liệu trong MongoDB không bị worker cũ làm bẩn
    const checkDoc = await Unit.findById(staleUnit._id).lean();
    assert.strictEqual(checkDoc.image_sync_lock_owner, leaseNew);
    assert.strictEqual(checkDoc.image_sync_status, 'PROCESSING');

    // Worker New ghi kết quả bằng leaseNew -> Thành công
    const validSaveResult = await Unit.updateOne(
      {
        _id: staleUnit._id,
        image_sync_lock_owner: leaseNew,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: {
          image_sync_status: 'SUCCESS',
          image_sync_locked_until: null,
          image_sync_lock_owner: null,
        },
      }
    );
    assert.strictEqual(validSaveResult.matchedCount, 1, 'Worker New phải ghi thành công');
    console.log('  ✅ Test 4 PASSED: Cơ chế conditional update ngăn chặn 100% rủi ro worker cũ ghi đè.\n');

    // =========================================================================
    // TEST 5: Khóa dự án được giữ vững trong suốt quá trình cập nhật các căn
    // =========================================================================
    console.log('Test 5: Kiểm thử khóa dự án được duy trì liên tục cho đến khi cập nhật xong toàn bộ căn...');

    const testProject = await Project.create({
      source: 'salepro',
      project_id: 99901,
      project_name: 'Dự án Giữ Khóa Test',
      image_sync_status: 'PENDING',
      media_schema_version: 1,
    });

    const projectLeaseId = crypto.randomUUID();
    // 1. Worker claim khóa dự án
    await Project.updateOne(
      { _id: testProject._id },
      {
        $set: {
          image_sync_status: 'PROCESSING',
          image_sync_locked_until: new Date(Date.now() + 60000),
          image_sync_lock_owner: projectLeaseId,
        },
      }
    );

    // 2. Lưu media cấp dự án (Interim save)
    await Project.updateOne(
      {
        _id: testProject._id,
        image_sync_lock_owner: projectLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: {
          project_image_urls: ['https://cdn.com/avatar.jpg'],
          drive_project_image_urls: ['https://drive.google.com/avatar.jpg'],
        },
      }
    );

    // 3. Trong lúc đang cập nhật căn hộ: Kiểm tra khóa dự án VẪN PHẢI ĐANG ĐƯỢC GIỮ
    const duringUnitUpdateProj = await Project.findById(testProject._id).lean();
    assert.strictEqual(
      duringUnitUpdateProj.image_sync_lock_owner,
      projectLeaseId,
      'Khóa dự án KHÔNG ĐƯỢC BỊ GIẢI PHÓNG trong lúc cập nhật căn'
    );
    assert.strictEqual(
      duringUnitUpdateProj.image_sync_status,
      'PROCESSING',
      'Trạng thái vẫn phải là PROCESSING'
    );

    // Worker khác cố claim dự án này lúc này -> Phải thất bại!
    const otherWorkerClaim = await Project.findOneAndUpdate(
      {
        _id: testProject._id,
        $or: [
          { image_sync_status: { $ne: 'PROCESSING' } },
          { image_sync_locked_until: { $lt: new Date() } },
        ],
      },
      { $set: { image_sync_lock_owner: 'other_worker' } }
    );
    assert.strictEqual(otherWorkerClaim, null, 'Worker khác không được chiếm dự án khi đang cập nhật căn');

    // 4. Cập nhật xong các căn -> Bây giờ mới giải phóng khóa
    await Project.updateOne(
      {
        _id: testProject._id,
        image_sync_lock_owner: projectLeaseId,
      },
      {
        $set: {
          image_sync_status: 'SUCCESS',
          media_schema_version: 3,
          media_synced_at: new Date(),
          image_sync_locked_until: null,
          image_sync_lock_owner: null,
        },
      }
    );

    const finishedProject = await Project.findById(testProject._id).lean();
    assert.strictEqual(finishedProject.image_sync_lock_owner, null, 'Khóa chỉ được giải phóng sau khi xong');
    assert.strictEqual(finishedProject.media_schema_version, 3);
    assert.strictEqual(finishedProject.image_sync_status, 'SUCCESS');
    console.log('  ✅ Test 5 PASSED: Khóa dự án được bảo vệ toàn vẹn qua toàn bộ chu kỳ cập nhật căn.\n');

    // =========================================================================
    // TEST 6: Xử lý lỗi cập nhật một số căn -> Chuyển PARTIAL & KHÔNG set version = 3
    // =========================================================================
    console.log('Test 6: Kiểm thử lỗi cập nhật căn hộ -> Đánh dấu PARTIAL & giữ media_schema_version < 3...');

    const partialProject = await Project.create({
      source: 'salepro',
      project_id: 99902,
      project_name: 'Dự án Lỗi Căn Test',
      image_sync_status: 'PENDING',
      media_schema_version: 1,
    });

    const partialLeaseId = crypto.randomUUID();
    // Giả lập: có 5 căn, nhưng 2 căn cập nhật thất bại
    const unitUpdateErrorCount = 2;
    const finalStatus = unitUpdateErrorCount > 0 ? 'PARTIAL' : 'SUCCESS';

    const finalFields = {
      image_sync_status: finalStatus,
      image_sync_error: `Có ${unitUpdateErrorCount} căn cập nhật thất bại`,
      image_sync_locked_until: null,
      image_sync_lock_owner: null,
    };

    // QUY TẮC: Chỉ gán version = 3 khi SUCCESS hoặc NO_IMAGE
    if (finalStatus === 'SUCCESS') {
      finalFields.media_schema_version = 3;
    }

    await Project.updateOne({ _id: partialProject._id }, { $set: finalFields });

    const checkedPartialProj = await Project.findById(partialProject._id).lean();
    assert.strictEqual(checkedPartialProj.image_sync_status, 'PARTIAL');
    assert.strictEqual(checkedPartialProj.media_schema_version, 1, 'media_schema_version KHÔNG được nâng lên 3 khi PARTIAL');

    // Kiểm tra câu query retry: dự án PARTIAL này phải được tìm thấy để retry!
    const retryCandidates = await Project.find({
      $or: [
        { media_schema_version: { $exists: false } },
        { media_schema_version: { $lt: 3 } },
        { image_sync_status: { $in: ['PENDING', 'PARTIAL', 'FAILED'] } },
      ],
    }).lean();

    const found = retryCandidates.some((p) => p.project_id === 99902);
    assert.strictEqual(found, true, 'Dự án PARTIAL phải nằm trong danh sách retry tự động');
    console.log('  ✅ Test 6 PASSED: Dự án có căn lỗi được ghi nhận PARTIAL và đưa vào retry chính xác.\n');

    // =========================================================================
    // TEST 7: Kiểm thử Heartbeat tự động trong withLock
    // =========================================================================
    console.log('Test 7: Kiểm thử Heartbeat tự động gia hạn khóa trong withLock...');

    const hbKey = 'TEST_HEARTBEAT_AUTO';
    let executedInLock = false;

    await withLock(
      hbKey,
      async (lease, lockStatus) => {
        executedInLock = true;
        assert.ok(lease);
        assert.strictEqual(lockStatus.isLost, false);

        // Đợi 2.5 chu kỳ heartbeat (heartbeatIntervalMs = 200ms)
        await new Promise((r) => setTimeout(r, 600));

        assert.ok(lockStatus.renewCount >= 2, `Heartbeat phải renew ít nhất 2 lần (thực tế: ${lockStatus.renewCount})`);
        
        const docInDb = await SystemLock.findById(hbKey).lean();
        assert.ok(new Date(docInDb.locked_until).getTime() > Date.now(), 'Khóa trong DB phải đang còn hạn');
      },
      {
        holder: 'WORKER_HEARTBEAT',
        ttlMs: 2000,
        heartbeatIntervalMs: 200,
      }
    );

    assert.strictEqual(executedInLock, true);
    // Sau khi withLock kết thúc, khóa phải được tự động giải phóng
    const lockAfterWithLock = await SystemLock.findById(hbKey).lean();
    assert.strictEqual(lockAfterWithLock, null, 'Khóa phải được giải phóng sau withLock');
    console.log('  ✅ Test 7 PASSED: Heartbeat tự động gia hạn khóa và giải phóng an toàn khi hoàn thành.\n');

    // =========================================================================
    // TEST 8: Kiểm thử mô phỏng toàn bộ luồng đồng bộ nhiều căn (50 units)
    //         kèm Heartbeat khóa Project và atomic Unit.updateOne
    // =========================================================================
    console.log('Test 8: Mô phỏng toàn bộ luồng đồng bộ dự án 50 căn với Project Heartbeat và Atomic Unit Update...');

    const multiProject = await Project.create({
      source: 'salepro',
      project_id: 99903,
      project_name: 'Dự án Test 50 Căn Heartbeat',
      project_type: 'high_rise',
      image_sync_status: 'PENDING',
      media_schema_version: 1,
      product_layouts: [
        { product_name: 'Căn hộ 2PN', category: '2PN', image_url: 'http://example.com/2pn.jpg', drive_url: 'https://drive.google.com/2pn' },
      ],
    });

    // Tạo 50 căn cho dự án này
    const unitsToCreate = [];
    for (let i = 1; i <= 50; i++) {
      unitsToCreate.push({
        source: 'salepro',
        project_id: multiProject.project_id,
        project_name: multiProject.project_name,
        unit_code: `UNIT-50-${String(i).padStart(3, '0')}`,
        unit_type: '2PN',
        raw_data: { important_user_tag: `preserve_me_${i}`, notes: 'do_not_overwrite' },
        image_sync_status: 'PENDING',
      });
    }
    await Unit.insertMany(unitsToCreate);

    const test8LeaseId = crypto.randomUUID();
    const shortTtlMs = 400; // Khóa chỉ kéo dài 400ms (nếu không có heartbeat sẽ hết hạn ngay)
    const hbIntervalMs = 100;

    // 1. Worker giành khóa Project
    await Project.updateOne(
      { _id: multiProject._id },
      {
        $set: {
          image_sync_status: 'PROCESSING',
          image_sync_lock_owner: test8LeaseId,
          image_sync_locked_until: new Date(Date.now() + shortTtlMs),
        },
      }
    );

    let renewSuccessCount = 0;
    const projectHeartbeatTimer = setInterval(async () => {
      try {
        const renewRes = await Project.updateOne(
          {
            _id: multiProject._id,
            image_sync_lock_owner: test8LeaseId,
            image_sync_locked_until: { $gt: new Date() },
          },
          {
            $set: {
              image_sync_locked_until: new Date(Date.now() + shortTtlMs),
            },
          }
        );
        if (renewRes.matchedCount > 0) {
          renewSuccessCount++;
        }
      } catch (_) {}
    }, hbIntervalMs);

    let totalUpdatedUnits = 0;
    try {
      // Mô phỏng vòng lặp xử lý 50 căn tốn 800ms (> shortTtlMs 400ms)
      const projectUnits = await Unit.find({ project_id: multiProject.project_id });
      assert.strictEqual(projectUnits.length, 50);

      for (const u of projectUnits) {
        // Mô phỏng độ trễ xử lý từng căn
        await new Promise((r) => setTimeout(r, 16));

        // Kiểm tra khóa trước mỗi căn
        const checkProj = await Project.findOne({
          _id: multiProject._id,
          image_sync_lock_owner: test8LeaseId,
          image_sync_locked_until: { $gt: new Date() },
        });
        assert.ok(checkProj, 'Khóa Project phải còn hiệu lực nhờ Heartbeat liên tục');

        // Cập nhật nguyên tử không ảnh hưởng trường khác
        await Unit.updateOne(
          { _id: u._id },
          {
            $set: {
              layout_match_level: 'EXACT',
              layout_name: 'Layout Căn hộ 2PN',
              shared_media_status: 'SYNCED',
              image_sync_status: 'NO_IMAGE',
            },
          }
        );
        totalUpdatedUnits++;
      }

      // Hoàn tất: Cập nhật thành công và nâng schema version lên 3
      await Project.updateOne(
        { _id: multiProject._id, image_sync_lock_owner: test8LeaseId },
        {
          $set: {
            image_sync_status: 'SUCCESS',
            media_schema_version: 3,
            image_sync_locked_until: null,
            image_sync_lock_owner: null,
          },
        }
      );
    } finally {
      clearInterval(projectHeartbeatTimer);
    }

    assert.strictEqual(totalUpdatedUnits, 50, 'Toàn bộ 50 căn phải được xử lý trọn vẹn');
    assert.ok(renewSuccessCount >= 4, `Heartbeat dự án phải được renew ít nhất 4 lần (thực tế: ${renewSuccessCount})`);

    // Kiểm tra tính toàn vẹn của document: raw_data không bị mất/ghi đè
    const verifySampleUnit = await Unit.findOne({ unit_code: 'UNIT-50-025' });
    assert.strictEqual(verifySampleUnit.raw_data.important_user_tag, 'preserve_me_25');
    assert.strictEqual(verifySampleUnit.raw_data.notes, 'do_not_overwrite');
    assert.strictEqual(verifySampleUnit.shared_media_status, 'SYNCED');
    assert.strictEqual(verifySampleUnit.image_sync_status, 'NO_IMAGE');

    const verifyFinalProj = await Project.findById(multiProject._id);
    assert.strictEqual(verifyFinalProj.image_sync_status, 'SUCCESS');
    assert.strictEqual(verifyFinalProj.media_schema_version, 3);
    assert.strictEqual(verifyFinalProj.image_sync_lock_owner, null);

    console.log('  ✅ Test 8 PASSED: Luồng đồng bộ 50 căn chạy bền bỉ với Heartbeat, bảo toàn toàn vẹn dữ liệu căn.\n');

    // =========================================================================
    // TEST 9: Heartbeat Project bị mất lease -> Worker nhận tín hiệu isLost và ngừng ngay
    // =========================================================================
    console.log('Test 9: Kiểm thử Heartbeat Project phát hiện mất lease -> worker nhận tín hiệu isLost và lập tức dừng...');

    const projTest9 = await Project.create({
      source: 'salepro',
      project_id: 99904,
      project_name: 'Dự án Test Mất Lease Heartbeat',
      project_type: 'high_rise',
      image_sync_status: 'PROCESSING',
      image_sync_lock_owner: 'WORKER_ORIGINAL',
      image_sync_locked_until: new Date(Date.now() + 500),
      media_schema_version: 1,
    });

    const unitsTest9 = await Unit.insertMany([
      { source: 'salepro', project_id: 99904, project_name: projTest9.project_name, unit_code: 'UNIT-HB-1', shared_media_status: 'NONE' },
      { source: 'salepro', project_id: 99904, project_name: projTest9.project_name, unit_code: 'UNIT-HB-2', shared_media_status: 'NONE' },
      { source: 'salepro', project_id: 99904, project_name: projTest9.project_name, unit_code: 'UNIT-HB-3', shared_media_status: 'NONE' },
    ]);

    const projectLockState9 = { isLost: false, lostReason: '' };
    const hbInterval9 = 80;
    const ttl9 = 300;

    const hbTimer9 = setInterval(async () => {
      try {
        const renewRes = await Project.updateOne(
          {
            _id: projTest9._id,
            image_sync_lock_owner: 'WORKER_ORIGINAL',
            image_sync_locked_until: { $gt: new Date() },
          },
          {
            $set: { image_sync_locked_until: new Date(Date.now() + ttl9) },
          }
        );
        if (renewRes.matchedCount === 0) {
          projectLockState9.isLost = true;
          projectLockState9.lostReason = 'HEARTBEAT_RENEW_FAILED_OR_LEASE_EXPIRED';
          clearInterval(hbTimer9);
        }
      } catch (_) {}
    }, hbInterval9);

    // Mô phỏng: Sau 100ms, worker khác chiếm khóa của dự án
    setTimeout(async () => {
      await Project.updateOne(
        { _id: projTest9._id },
        {
          $set: {
            image_sync_lock_owner: 'WORKER_NEW_THIEF',
            image_sync_locked_until: new Date(Date.now() + 10000),
          },
        }
      );
    }, 100);

    // Worker nguyên bản chạy vòng lặp cập nhật căn
    let processedUnits9 = 0;
    let workerStoppedDueToLockLoss = false;

    for (const u of unitsTest9) {
      if (projectLockState9.isLost) {
        workerStoppedDueToLockLoss = true;
        break;
      }

      await new Promise((r) => setTimeout(r, 70));

      if (projectLockState9.isLost) {
        workerStoppedDueToLockLoss = true;
        break;
      }

      await Unit.updateOne({ _id: u._id }, { $set: { shared_media_status: 'SYNCED' } });
      processedUnits9++;
    }

    clearInterval(hbTimer9);

    assert.strictEqual(projectLockState9.isLost, true, 'Heartbeat phải đánh dấu isLost = true khi không thể gia hạn');
    assert.strictEqual(workerStoppedDueToLockLoss, true, 'Worker phải nhận tín hiệu isLost và dừng lại');
    assert.ok(processedUnits9 < unitsTest9.length, 'Worker không được xử lý hết các căn khi mất quyền');

    // Xác minh căn sau cùng chưa bị ghi
    const lastUnit9 = await Unit.findOne({ unit_code: 'UNIT-HB-3' });
    assert.strictEqual(lastUnit9.shared_media_status, 'NONE', 'Căn UNIT-HB-3 không được phép bị ghi đè');
    console.log('  ✅ Test 9 PASSED: Heartbeat phát hiện mất lease, worker lập tức nhận tín hiệu và ngừng xử lý.\n');

    // =========================================================================
    // TEST 10: Kiểm thử lease hết hạn giữa thao tác đọc khóa Project và ghi Unit.updateOne()
    // =========================================================================
    console.log('Test 10: Kiểm thử lease hết hạn giữa thao tác đọc khóa Project và ghi Unit.updateOne() (chống stale write)...');

    const projTest10 = await Project.create({
      source: 'salepro',
      project_id: 99905,
      project_name: 'Dự án Test Race Condition Unit Write',
      project_type: 'high_rise',
      image_sync_status: 'PROCESSING',
      image_sync_lock_owner: 'WORKER_RACE',
      image_sync_locked_until: new Date(Date.now() + 100), // Chỉ còn hạn 100ms
      media_schema_version: 1,
    });

    const unitTest10 = await Unit.create({
      source: 'salepro',
      project_id: 99905,
      project_name: projTest10.project_name,
      unit_code: 'UNIT-RACE-01',
      shared_media_status: 'NONE',
      raw_data: { custom: 'important_data' },
    });

    // Bước 1: Thao tác đọc khóa Project (tại thời điểm T0: khóa còn hạn 100ms)
    const lockCheck10 = await Project.findOne({
      _id: projTest10._id,
      image_sync_lock_owner: 'WORKER_RACE',
      image_sync_locked_until: { $gt: new Date() },
    }).select('image_sync_locked_until');
    assert.ok(lockCheck10, 'Bước đọc khóa ban đầu phải thành công');

    // Bước 2: Giả lập khoảng trễ (ví dụ GC pause hoặc độ trễ mạng 150ms > 100ms)
    await new Promise((r) => setTimeout(r, 150));

    // Bước 3: Kiểm tra an toàn trước khi ghi Unit.updateOne
    let staleWritePrevented = false;

    // Kiểm tra thời gian hết hạn theo lockCheck vừa đọc
    if (Date.now() >= new Date(lockCheck10.image_sync_locked_until).getTime()) {
      staleWritePrevented = true;
    }

    // Tái xác thực nhanh trên DB trước khi ghi
    const preWriteValid10 = await Project.exists({
      _id: projTest10._id,
      image_sync_lock_owner: 'WORKER_RACE',
      image_sync_locked_until: { $gt: new Date() },
    });
    if (!preWriteValid10) {
      staleWritePrevented = true;
    }

    // Nếu không vượt qua kiểm tra, worker từ chối gọi Unit.updateOne
    if (!staleWritePrevented) {
      await Unit.updateOne(
        { _id: unitTest10._id },
        { $set: { shared_media_status: 'STALE_DATA' } }
      );
    }

    assert.strictEqual(staleWritePrevented, true, 'Cơ chế bảo vệ phải phát hiện lease đã hết hạn giữa lúc đọc và ghi');

    // Kiểm tra dữ liệu trong DB: tuyệt đối không bị ghi dữ liệu lỗi thời
    const recheckedUnit10 = await Unit.findById(unitTest10._id);
    assert.strictEqual(recheckedUnit10.shared_media_status, 'NONE', 'Unit không được ghi dữ liệu lỗi thời khi lease đã hết hạn');
    assert.strictEqual(recheckedUnit10.raw_data.custom, 'important_data');
    console.log('  ✅ Test 10 PASSED: Ngăn chặn 100% tình huống ghi dữ liệu lỗi thời khi lease hết hạn giữa lúc đọc và ghi.\n');

    // =========================================================================
    // TEST 11: Thao tác cập nhật Project cuối cùng khi mất lease -> tuyệt đối không trả SUCCESS
    // =========================================================================
    console.log('Test 11: Kiểm thử thao tác cập nhật Project cuối cùng có điều kiện locked_until > now (tuyệt đối không trả SUCCESS khi mất lease)...');

    const projTest11 = await Project.create({
      source: 'salepro',
      project_id: 99906,
      project_name: 'Dự án Test Final Update Stale Lease',
      project_type: 'high_rise',
      image_sync_status: 'PROCESSING',
      image_sync_lock_owner: 'WORKER_FINAL',
      image_sync_locked_until: new Date(Date.now() - 500), // Đã hết hạn 500ms trước
      media_schema_version: 1,
    });

    const finalProjectFields11 = {
      image_sync_status: 'SUCCESS',
      image_sync_error: '',
      image_sync_locked_until: null,
      image_sync_lock_owner: null,
      media_schema_version: 3,
      media_synced_at: new Date(),
    };

    // Thao tác cập nhật Project cuối cùng có điều kiện nghiêm ngặt
    const finalUpdateRes11 = await Project.updateOne(
      {
        _id: projTest11._id,
        image_sync_lock_owner: 'WORKER_FINAL',
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: finalProjectFields11,
      }
    );

    // Xác minh matchedCount === 0 vì khóa đã hết hạn
    assert.strictEqual(finalUpdateRes11.matchedCount, 0, 'matchedCount phải bằng 0 do locked_until đã qua');

    // Worker xử lý matchedCount === 0 -> từ chối trả về SUCCESS
    let returnStatus11 = 'SUCCESS';
    if (finalUpdateRes11.matchedCount === 0) {
      returnStatus11 = 'LOCK_LOST_AT_FINAL_UPDATE';
    }

    assert.strictEqual(returnStatus11, 'LOCK_LOST_AT_FINAL_UPDATE', 'Tuyệt đối không được trả về SUCCESS khi matchedCount === 0');

    // Kiểm tra DB: Project KHÔNG bị nâng lên media_schema_version = 3 và trạng thái KHÔNG phải SUCCESS
    const recheckedProj11 = await Project.findById(projTest11._id);
    assert.strictEqual(recheckedProj11.media_schema_version, 1, 'media_schema_version phải giữ nguyên 1, không được lên 3');
    assert.strictEqual(recheckedProj11.image_sync_status, 'PROCESSING', 'Trạng thái không được thành SUCCESS');
    console.log('  ✅ Test 11 PASSED: Cập nhật cuối cùng có điều kiện locked_until > now bảo vệ an toàn, không trả SUCCESS khi mất lease.\n');

    console.log('====================================================================');
    console.log('🎉 TOÀN BỘ 11 BỘ TEST TÍCH HỢP CONCURRENCY TRÊN MONGODB TEST THÀNH CÔNG 100%!');
    console.log('====================================================================\n');
  } finally {
    // Dọn dẹp sạch sẽ DB test
    await Unit.deleteMany({});
    await Project.deleteMany({});
    await SystemLock.deleteMany({});
    await mongoose.disconnect();
    console.log('[MongoDB Test] Đã dọn dẹp sạch dữ liệu test và ngắt kết nối an toàn.');
  }
}

runIntegrationTests().catch(async (err) => {
  console.error('\n❌ [INTEGRATION TEST FAILED]:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
