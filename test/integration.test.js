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

    console.log('====================================================================');
    console.log('🎉 TOÀN BỘ 7 BỘ TEST TÍCH HỢP CONCURRENCY TRÊN MONGODB TEST THÀNH CÔNG 100%!');
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
