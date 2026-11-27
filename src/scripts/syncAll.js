require('dotenv').config();
const { connectDB } = require('../db');
const Project = require('../models/Project');
const Unit = require('../models/Unit');
const { syncSaleProProjectMedia, syncPendingImages } = require('../services/imageStorageService');
const { withLock } = require('../services/lockService');

let isTerminating = false;
process.on('SIGINT', () => {
  console.log('\n\n🛑 Nhận tín hiệu dừng (Ctrl+C). Đang hoàn tất tác vụ hiện tại trước khi thoát...');
  isTerminating = true;
});

async function main() {
  await connectDB();

  console.log('\n====================================================================');
  console.log('🚀 [DRIVE SYNC MASTER] ĐỒNG BỘ TOÀN BỘ HÌNH ẢNH LÊN GOOGLE DRIVE');
  console.log('   - Sàn SalePro: Tất cả dự án (Banner, Mặt bằng tầng, Layout từng loại căn)');
  console.log('   - Sàn HiSale:  Tất cả căn hộ & nhà phố/biệt thự có hình ảnh thực tế');
  console.log('   - Thư mục gốc: Google Drive sếp (đã cấp quyền)');
  console.log('   - Nhấn Ctrl+C bất kỳ lúc nào để dừng an toàn (tiến độ được lưu liên tục)');
  console.log('====================================================================\n');

  // 1. Thống kê sơ bộ trong CSDL
  const saleproTotalProjects = await Project.countDocuments({ source: 'salepro' });
  const saleproPendingProjects = await Project.countDocuments({
    source: 'salepro',
    $or: [
      { media_schema_version: { $exists: false } },
      { media_schema_version: { $lt: 3 } },
      { drive_project_image_urls: { $exists: false } },
      { drive_project_image_urls: { $size: 0 } },
      { image_sync_status: { $in: ['PENDING', 'PARTIAL', 'FAILED'] } },
    ]
  });

  const hisaleTotalUnitsWithImg = await Unit.countDocuments({
    source: 'hisale',
    'image_urls.0': { $exists: true }
  });
  const hisalePendingUnits = await Unit.countDocuments({
    source: 'hisale',
    'image_urls.0': { $exists: true },
    $or: [
      { image_sync_status: { $nin: ['SUCCESS', 'NO_IMAGE', 'FAILED'] } },
      { image_sync_status: 'FAILED', image_sync_retries: { $lt: 3 } },
    ]
  });

  const vhubTotalUnitsWithImg = await Unit.countDocuments({
    source: 'vhub',
    'image_urls.0': { $exists: true }
  });
  const vhubPendingUnits = await Unit.countDocuments({
    source: 'vhub',
    'image_urls.0': { $exists: true },
    $or: [
      { image_sync_status: { $nin: ['SUCCESS', 'NO_IMAGE', 'FAILED'] } },
      { image_sync_status: 'FAILED', image_sync_retries: { $lt: 3 } },
    ]
  });

  console.log(`📊 [CSDL MONGODB HIỆN TẠI]:`);
  console.log(`   - SalePro: Tổng ${saleproTotalProjects} dự án (Cần xử lý: ${saleproPendingProjects} dự án)`);
  console.log(`   - HiSale:  Tổng ${hisaleTotalUnitsWithImg} căn có ảnh (Cần xử lý: ${hisalePendingUnits} căn)`);
  console.log(`   - VHub:    Tổng ${vhubTotalUnitsWithImg} căn có ảnh trực tiếp (Cần xử lý: ${vhubPendingUnits} căn)`);
  console.log('--------------------------------------------------------------------\n');

  // ==================================================================
  // PHẦN 1: ĐỒNG BỘ TOÀN BỘ DỰ ÁN SALEPRO
  // ==================================================================
  if (saleproPendingProjects > 0 && !isTerminating) {
    console.log(`\n▶️ [BƯỚC 1/2] BẮT ĐẦU ĐỒNG BỘ TOÀN BỘ DỰ ÁN SALEPRO...`);
    
    await withLock('PROJECT_MEDIA_SYNC', async (leaseId) => {
      const projects = await Project.find({
        source: 'salepro',
        $or: [
          { media_schema_version: { $exists: false } },
          { media_schema_version: { $lt: 3 } },
          { drive_project_image_urls: { $exists: false } },
          { drive_project_image_urls: { $size: 0 } },
          { image_sync_status: { $in: ['PENDING', 'PARTIAL', 'FAILED'] } },
        ]
      }).sort({ apartment_count: -1 });

      console.log(`🔍 Tìm thấy ${projects.length} dự án SalePro cần đồng bộ media.\n`);
      let count = 0;
      for (const proj of projects) {
        if (isTerminating) {
          console.log(`⚠️ Tạm dừng SalePro theo yêu cầu người dùng.`);
          break;
        }
        count++;
        console.log(`[${count}/${projects.length}] 📁 Đang đồng bộ: [ID ${proj.project_id}] ${proj.project_name}`);
        try {
          const res = await syncSaleProProjectMedia(proj);
          console.log(`   ✅ Tải lên ${res?.uploadedCount || 0} ảnh, ${res?.floorPlansUploaded || 0} mặt bằng, ${res?.layoutsUploaded || 0} layout (Gán ${res?.exactCount || 0} căn chính xác)`);
        } catch (err) {
          console.error(`   ❌ Lỗi khi đồng bộ dự án ${proj.project_name}:`, err.message);
        }
      }
    }, { timeoutMs: 30 * 60 * 1000 });
  } else if (saleproPendingProjects === 0) {
    console.log(`✅ [BƯỚC 1/2] Tất cả ${saleproTotalProjects} dự án SalePro đã được đồng bộ đầy đủ lên Google Drive trước đó.`);
  }

  async function syncUnitsInBatches(sourceKey, displayName, pendingCount, stepLabel) {
    if (pendingCount > 0 && !isTerminating) {
      console.log(`\n▶️ [${stepLabel}] BẮT ĐẦU ĐỒNG BỘ TOÀN BỘ CĂN ${displayName.toUpperCase()} CÓ ẢNH...`);
      const batchSize = Number(process.env.IMAGE_SYNC_BATCH_SIZE || 20);
      let batchIndex = 0;
      let totalProcessed = 0;
      let totalSuccess = 0;

      while (!isTerminating) {
        batchIndex++;
        console.log(`\n--- [Batch #${batchIndex}] Đang xử lý ${batchSize} căn tiếp theo... ---`);
        try {
          const result = await syncPendingImages({ source: sourceKey, limit: batchSize });
          if (!result || result.total === 0 || result.enabled === false) {
            console.log(`✨ Đã hoàn tất toàn bộ căn ${displayName}!`);
            break;
          }

          totalProcessed += result.total || 0;
          totalSuccess += result.success || 0;
          console.log(`✅ Hoàn thành batch #${batchIndex}: Thành công ${result.success}/${result.total} căn.`);
        } catch (err) {
          console.error(`❌ Lỗi batch #${batchIndex}:`, err.message);
          break;
        }
      }

      console.log(`\n🏁 Đã xử lý ${totalProcessed} căn ${displayName} (Thành công ${totalSuccess} căn).`);
    } else if (pendingCount === 0) {
      console.log(`✅ [${stepLabel}] Toàn bộ căn ${displayName} có ảnh đã được tải lên Google Drive từ trước.`);
    }
  }

  // ==================================================================
  // PHẦN 2: ĐỒNG BỘ TOÀN BỘ CĂN HISALE
  // ==================================================================
  await syncUnitsInBatches('hisale', 'HiSale', hisalePendingUnits, 'BƯỚC 2/3');

  // ==================================================================
  // PHẦN 3: ĐỒNG BỘ TOÀN BỘ CĂN VHUB
  // ==================================================================
  await syncUnitsInBatches('vhub', 'VHub', vhubPendingUnits, 'BƯỚC 3/3');

  // ==================================================================
  // TỔNG KẾT
  // ==================================================================
  console.log('\n====================================================================');
  console.log('🎉 [HOÀN TẤT] QUÁ TRÌNH ĐỒNG BỘ ĐÃ HOÀN TẤT!');
  console.log('   - Dữ liệu và hình ảnh đã được sắp xếp gọn gàng trên Google Drive của sếp.');
  console.log('   - CSDL MongoDB đã được cập nhật toàn bộ link Google Drive.');
  console.log('====================================================================\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Lỗi nghiêm trọng:', err);
  process.exit(1);
});
