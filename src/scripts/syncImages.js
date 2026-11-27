require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const { syncPendingImages } = require('../services/imageStorageService');

function parseArgs() {
  const args = process.argv.slice(2);
  let source = 'all';
  let limit = null;

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1].trim().toLowerCase();
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.split('=')[1]);
    } else if (/^\d+$/.test(arg)) {
      limit = Number(arg);
    } else if (['hisale', 'salepro', 'vhub'].includes(arg.toLowerCase())) {
      source = arg.toLowerCase();
    }
  }

  return { source, limit };
}

async function main() {
  await connectDB();

  const { source, limit } = parseArgs();

  let isTerminating = false;
  process.on('SIGINT', () => {
    console.log('\n🛑 Nhận tín hiệu dừng (Ctrl+C). Đang hoàn tất batch hiện tại trước khi thoát...');
    isTerminating = true;
  });

  try {
    if (limit) {
      await syncPendingImages({ source, limit });
    } else {
      let batchNumber = 0;
      let totalProcessed = 0;
      let totalSuccess = 0;
      const batchSize = Number(process.env.IMAGE_SYNC_BATCH_SIZE || 20);

      console.log(`\n====================================================================`);
      console.log(`🚀 [CONTINUOUS SYNC] ĐỒNG BỘ LIÊN TỤC TOÀN BỘ QUỸ CĂN (${source.toUpperCase()})`);
      console.log(`   - Kích thước mỗi batch: ${batchSize} căn`);
      console.log(`   - Tiến độ được cập nhật liên tục vào CSDL & Google Drive`);
      console.log(`   - Nhấn Ctrl+C bất cứ lúc nào để dừng an toàn`);
      console.log(`====================================================================\n`);

      while (!isTerminating) {
        batchNumber++;
        console.log(`\n--- [Batch #${batchNumber}] Đang lấy ${batchSize} căn tiếp theo... ---`);
        const res = await syncPendingImages({ source, limit: batchSize });
        if (!res || res.total === 0) {
          console.log('\n🎉 Đã đồng bộ hoàn tất toàn bộ quỹ căn (không còn căn nào chờ xử lý)!');
          break;
        }
        totalProcessed += res.total || 0;
        totalSuccess += res.success || 0;
        console.log(`📈 Tiến độ phiên hiện tại: Đã xử lý ${totalProcessed} căn (Thành công: ${totalSuccess} căn)`);
      }
    }
  } catch (err) {
    console.error('[Sync Script] ❌ Lỗi:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main().catch(async (e) => {
  console.error('[Sync Script Fatal]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
