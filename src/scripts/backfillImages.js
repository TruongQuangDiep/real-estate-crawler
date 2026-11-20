require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const { syncPendingImages } = require('../services/imageStorageService');

let isTerminating = false;
process.on('SIGINT', () => {
  console.log('\n🛑 Nhận tín hiệu dừng (Ctrl+C). Đang hoàn tất căn hiện tại trước khi thoát...');
  isTerminating = true;
});

function parseArgs() {
  const args = process.argv.slice(2);
  let source = 'hisale';
  let batchSize = Number(process.env.IMAGE_SYNC_BATCH_SIZE || 20);
  let maxBatches = null;

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1].trim().toLowerCase();
    } else if (arg.startsWith('--batch-size=')) {
      batchSize = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--max-batches=')) {
      maxBatches = Number(arg.split('=')[1]);
    }
  }

  return { source, batchSize, maxBatches };
}

async function main() {
  await connectDB();
  const { source, batchSize, maxBatches } = parseArgs();

  console.log('\n====================================================================');
  console.log(`🚀 [BACKFILL] BẮT ĐẦU ĐỒNG BỘ DỮ LIỆU TỒN ĐỌNG CHO SÀN: ${source.toUpperCase()}`);
  console.log(`  - Kích thước mỗi batch: ${batchSize} căn`);
  console.log(`  - Số batch tối đa: ${maxBatches ? maxBatches : 'Không giới hạn (chạy đến khi hết)'}`);
  console.log(`  - Nhấn Ctrl+C bất cứ lúc nào để dừng an toàn (tiến độ được lưu từng ảnh)`);
  console.log('====================================================================');

  let batchCount = 0;
  let totalProcessed = 0;
  let totalSuccess = 0;

  try {
    while (!isTerminating) {
      batchCount++;
      if (maxBatches && batchCount > maxBatches) {
        console.log(`✨ Đã đạt giới hạn ${maxBatches} batches. Tạm dừng phiên backfill.`);
        break;
      }

      console.log(`\n--- [Batch #${batchCount}] Đang lấy danh sách căn cần xử lý... ---`);
      const result = await syncPendingImages({ source, limit: batchSize });

      if (!result || result.total === 0 || result.enabled === false) {
        console.log(`✨ Đã hoàn tất hoặc không còn căn nào chờ đồng bộ.`);
        break;
      }

      totalProcessed += result.total || 0;
      totalSuccess += result.success || 0;

      // Nghỉ 1 giây giữa các batch để giải phóng event loop và tránh nghẽn mạng
      await new Promise((res) => setTimeout(res, 1000));
    }
  } catch (err) {
    console.error('❌ Lỗi trong phiên backfill:', err.message);
  } finally {
    console.log('\n====================================================================');
    console.log(`🏁 [BACKFILL SUMMARY] TỔNG KẾT PHIÊN ĐỒNG BỘ TỒN ĐỌNG:`);
    console.log(`  - Số batch đã thực thi: ${batchCount}`);
    console.log(`  - Tổng căn đã xử lý:    ${totalProcessed}`);
    console.log(`  - Thành công:           ${totalSuccess}`);
    console.log('====================================================================\n');
    await mongoose.disconnect();
    process.exit(0);
  }
}

main().catch(async (e) => {
  console.error('[Backfill Fatal]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
