require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../db');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const { determineSegment } = require('../services/imageStorageService');
const { getDriveClient, isDriveConfigured, ensureFolderPath } = require('../services/googleDriveService');

function parseArgs() {
  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute') || args.includes('--confirm');
  const isDryRun = !isExecute || args.includes('--dry-run');
  const source = args.find((a) => a.startsWith('--source='))?.split('=')[1] || 'all';

  return { isDryRun, source };
}

async function main() {
  const { isDryRun, source } = parseArgs();

  console.log('\n====================================================================');
  console.log(`🧭 [MIGRATION SEGMENTS] RÀ SOÁT & DI CHUYỂN PHÂN KHÚC GOOGLE DRIVE`);
  console.log(`   • Chế độ: ${isDryRun ? '🟡 DRY-RUN (Chỉ kiểm tra, KHÔNG di chuyển thật)' : '🔴 EXECUTE (Thực hiện di chuyển)'}`);
  console.log(`   • Nguồn: ${source.toUpperCase()}`);
  console.log('====================================================================\n');

  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    console.error(`❌ [GoogleDrive] Dịch vụ chưa sẵn sàng: ${driveCheck.reason}`);
    process.exit(1);
  }

  await connectDB();
  const drive = await getDriveClient();

  try {
    // 1. Lọc tất cả căn hộ đã có thư mục Google Drive
    const query = {
      drive_folder_id: { $exists: true, $ne: '' },
    };
    if (source && source !== 'all') {
      query.source = source.toLowerCase();
    }

    const units = await Unit.find(query).lean();
    console.log(`🔍 Tìm thấy ${units.length} căn có thư mục Google Drive trong MongoDB...\n`);

    if (units.length === 0) {
      console.log('✨ Không có căn nào cần kiểm tra.');
      return;
    }

    const cacheFolderParents = new Map();
    async function getFolderMeta(folderId) {
      if (cacheFolderParents.has(folderId)) {
        return cacheFolderParents.get(folderId);
      }
      try {
        const res = await drive.files.get({
          fileId: folderId,
          fields: 'id, name, parents, trashed',
        });
        cacheFolderParents.set(folderId, res.data);
        return res.data;
      } catch (e) {
        return null;
      }
    }

    const migrationCandidates = [];
    let checkedCount = 0;

    for (const u of units) {
      checkedCount++;
      const expectedSegment = determineSegment(u); // 'Thap_tang' hoặc 'Cao_tang'

      const unitFolder = await getFolderMeta(u.drive_folder_id);
      if (!unitFolder || unitFolder.trashed) {
        continue;
      }

      // Parent của căn là thư mục dự án
      const projFolderId = unitFolder.parents?.[0];
      if (!projFolderId) continue;
      const projFolder = await getFolderMeta(projFolderId);
      if (!projFolder) continue;

      // Parent của dự án là thư mục phân khúc ('Cao_tang' hoặc 'Thap_tang')
      const segFolderId = projFolder.parents?.[0];
      if (!segFolderId) continue;
      const segFolder = await getFolderMeta(segFolderId);
      if (!segFolder) continue;

      const currentSegmentOnDrive = segFolder.name;

      if (currentSegmentOnDrive !== expectedSegment) {
        migrationCandidates.push({
          unitId: u._id,
          unitCode: u.unit_code,
          unitType: u.unit_type || 'N/A',
          projectName: u.project_name,
          source: u.source,
          currentSegmentOnDrive,
          expectedSegment,
          unitFolderId: u.drive_folder_id,
          unitFolderName: unitFolder.name,
          currentProjFolderId: projFolder.id,
          targetProjName: u.project_name,
        });
      }
    }

    console.log('====================================================================');
    console.log(`📊 KẾT QUẢ RÀ SOÁT PHÂN KHÚC:`);
    console.log(`   • Tổng số căn đã kiểm tra: ${checkedCount}`);
    console.log(`   • Số căn bị phân loại lệch trên Google Drive: ${migrationCandidates.length}`);
    console.log('====================================================================\n');

    if (migrationCandidates.length === 0) {
      console.log('✅ Toàn bộ các căn trên Google Drive đã nằm đúng phân khúc (Cao_tang / Thap_tang).');
      console.log('   Không có thư mục nào cần di chuyển.\n');
      return;
    }

    // Liệt kê chi tiết các căn cần di chuyển
    console.log('📋 DANH SÁCH CÁC CĂN CẦN DI CHUYỂN PHÂN KHÚC:');
    migrationCandidates.forEach((item, idx) => {
      console.log(
        `   [${idx + 1}] [${item.source.toUpperCase()}] Căn ${item.unitCode} (${item.unitType}) - Dự án: ${item.projectName}`
      );
      console.log(
        `       - Hiện tại trên Drive: [${item.currentSegmentOnDrive}]  ==>  Mục tiêu đúng: [${item.expectedSegment}]`
      );
      console.log(`       - Unit Folder ID: ${item.unitFolderId}`);
    });

    if (isDryRun) {
      console.log('\n--------------------------------------------------------------------');
      console.log('🟡 [DRY-RUN HOÀN TẤT] AN TOÀN 100%');
      console.log('   - Không có file hay thư mục nào trên Google Drive bị di chuyển.');
      console.log('   - Không có bản ghi nào trong MongoDB bị thay đổi.');
      console.log('   - Để thực hiện di chuyển thật sau khi được phê duyệt, hãy chạy:');
      console.log('     npm run drive:migrate-segments -- --execute');
      console.log('--------------------------------------------------------------------\n');
      return;
    }

    // 2. Chế độ EXECUTE: Di chuyển thư mục thật trên Google Drive
    console.log('\n🚀 Bắt đầu thực hiện di chuyển phân khúc trên Google Drive...');
    let successCount = 0;
    let errorCount = 0;

    for (const item of migrationCandidates) {
      try {
        const sourceName = item.source === 'salepro' ? 'SalePro' : 'HiSale';
        // Đảm bảo thư mục dự án đích trong phân khúc chuẩn đã tồn tại
        const targetProjFolder = await ensureFolderPath([sourceName, item.expectedSegment, item.projectName]);

        // Di chuyển thư mục căn bằng Drive API files.update (addParents & removeParents)
        await drive.files.update({
          fileId: item.unitFolderId,
          addParents: targetProjFolder.id,
          removeParents: item.currentProjFolderId,
          fields: 'id, parents',
        });

        // Cập nhật lại đường dẫn mới vào MongoDB
        await Unit.updateOne(
          { _id: item.unitId },
          {
            $set: {
              drive_folder_url: `https://drive.google.com/drive/folders/${item.unitFolderId}`,
            },
          }
        );

        console.log(`   ✅ Đã di chuyển căn [${item.unitCode}] sang [${item.expectedSegment}/${item.projectName}]`);
        successCount++;
      } catch (moveErr) {
        console.error(`   ❌ Lỗi di chuyển căn [${item.unitCode}]:`, moveErr.message);
        errorCount++;
      }
    }

    console.log('\n====================================================================');
    console.log(`🏁 HOÀN TẤT DI CHUYỂN:`);
    console.log(`   • Thành công: ${successCount} căn`);
    console.log(`   • Thất bại: ${errorCount} căn`);
    console.log('====================================================================\n');
  } catch (err) {
    console.error('❌ Lỗi tiến trình migration:', err.message);
    process.exit(1);
  } finally {
    await disconnectDB();
  }
}

main().catch(async (e) => {
  console.error('[Migration Fatal]', e.message);
  try {
    await disconnectDB();
  } catch (_) {}
  process.exit(1);
});
