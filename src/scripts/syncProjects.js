require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const Project = require('../models/Project');
const { syncSaleProProjectMedia } = require('../services/imageStorageService');

function parseArgs() {
  const args = process.argv.slice(2);
  let source = 'salepro';
  let limit = 5;
  let projectIds = [];
  let force = false;

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1].trim().toLowerCase();
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--project-id=') || arg.startsWith('--project_id=') || arg.startsWith('--id=')) {
      const val = arg.split('=')[1].trim();
      projectIds = val
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n));
    } else if (arg === '--force') {
      force = true;
    } else if (/^\d+$/.test(arg)) {
      limit = Number(arg);
    }
  }

  return { source, limit, projectIds, force };
}

async function main() {
  await connectDB();
  const { source, limit, projectIds, force } = parseArgs();

  console.log('\n====================================================================');
  if (projectIds.length > 0) {
    console.log(`📁 [SYNC PROJECTS] ĐỒNG BỘ MEDIA DỰ ÁN SALEPRO THEO ID: [${projectIds.join(', ')}]`);
  } else {
    console.log(`📁 [SYNC PROJECTS] ĐỒNG BỘ MEDIA DỰ ÁN (${source.toUpperCase()}) - TỐI ĐA ${limit} DỰ ÁN`);
  }
  console.log('====================================================================');

  try {
    let query = { source };

    if (projectIds.length > 0) {
      query.project_id = { $in: projectIds };
    } else if (!force) {
      query.$or = [
        { media_schema_version: { $exists: false } },
        { media_schema_version: { $lt: 3 } },
        { drive_project_image_urls: { $exists: false } },
        { drive_project_image_urls: { $size: 0 } },
        { image_sync_status: { $in: ['PENDING', 'PARTIAL', 'FAILED'] } },
      ];
    }

    const projects = await Project.find(query)
      .sort({ media_schema_version: 1, apartment_count: -1 })
      .limit(projectIds.length > 0 ? projectIds.length : limit);

    if (projects.length === 0) {
      console.log(`✨ Không tìm thấy dự án ${source.toUpperCase()} nào thỏa mãn điều kiện đồng bộ.`);
      return;
    }

    console.log(`🔍 Tìm thấy ${projects.length} dự án cần xử lý đồng bộ media...\n`);

    const summaryReport = [];
    let count = 0;

    for (const proj of projects) {
      count++;
      console.log(`--------------------------------------------------------------------`);
      console.log(`[${count}/${projects.length}] Đang xử lý: [ID ${proj.project_id}] ${proj.project_name}`);

      const result = await syncSaleProProjectMedia(proj);
      const updated = await Project.findById(proj._id).lean();

      const itemReport = {
        projectId: proj.project_id,
        projectName: proj.project_name,
        segment: result?.segment || 'N/A',
        driveFolder: updated.drive_folder_url || 'Chưa có',
        totalFetched: result?.totalFetched || 0,
        uploadedCount: result?.uploadedCount || 0,
        duplicateCount: result?.duplicateCount || 0,
        errorCount: result?.errorCount || 0,
        floorPlansUploaded: result?.floorPlansUploaded || 0,
        layoutsUploaded: result?.layoutsUploaded || 0,
        documentUrls: updated.document_urls?.length || 0,
        unitCount: result?.unitCount || 0,
        exactCount: result?.exactCount || 0,
        typeMatchCount: result?.typeMatchCount || 0,
        unmatchedCount: result?.unmatchedCount || 0,
      };

      summaryReport.push(itemReport);
    }

    // Hiển thị bảng tổng kết nghiệm thu
    console.log('\n====================================================================');
    console.log('📊 TỔNG KẾT KẾT QUẢ ĐỒNG BỘ MEDIA DỰ ÁN (SALEPRO V3)');
    console.log('====================================================================');

    for (const item of summaryReport) {
      console.log(`\n📌 [ID ${item.projectId}] ${item.projectName} (${item.segment}):`);
      console.log(`   - Thư mục Google Drive: ${item.driveFolder}`);
      console.log(`   - Tổng media thu thập từ API: ${item.totalFetched}`);
      console.log(`   - Upload Google Drive thành công: ${item.uploadedCount}`);
      console.log(`   - Ảnh trùng lặp (SHA-256 deduplicated): ${item.duplicateCount}`);
      console.log(`   - Lỗi tải / upload: ${item.errorCount}`);
      console.log(`   - Mặt bằng (_FloorPlans): ${item.floorPlansUploaded} link`);
      console.log(`   - Layout thiết kế (_Layouts): ${item.layoutsUploaded} link`);
      console.log(`   - Tài liệu liên quan (CSBH/Bảng giá/Pháp lý): ${item.documentUrls} link`);
      console.log(`   - Tổng số căn trong MongoDB: ${item.unitCount}`);
      console.log(`   - Khớp layout chính xác (EXACT): ${item.exactCount}`);
      console.log(`   - Khớp layout tham khảo (TYPE_MATCH): ${item.typeMatchCount}`);
      console.log(`   - Chưa liên kết được (UNMATCHED): ${item.unmatchedCount}`);
    }

    console.log('\n🏁 [SYNC PROJECTS] HOÀN TẤT ĐỒNG BỘ TẤT CẢ DỰ ÁN!');
    console.log('====================================================================\n');
  } catch (err) {
    console.error('❌ Lỗi đồng bộ dự án:', err.message);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main().catch(async (e) => {
  console.error('[Sync Projects Fatal]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
