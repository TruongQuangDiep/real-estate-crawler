require('dotenv').config();
const cron = require('node-cron');
const { connectDB } = require('./db');
const { crawlAllHisaleProjects } = require('./crawlers/hisaleCrawler');
const { crawlAllSaleProProjects } = require('./crawlers/saleproCrawler');
const { crawlAllSaleProHighRiseProjects } = require('./crawlers/saleproHighRiseCrawler');
const { sendNotificationEmail } = require('./mailer');
const CrawlLog = require('./models/CrawlLog');

/**
 * Hàm điều phối toàn bộ chu trình cào dữ liệu cho 1 nguồn cụ thể
 */
async function runCrawlerForSource(sourceName, crawlFn, projectId, isInitialSync) {
  const startedAt = new Date();
  const log = new CrawlLog({
    started_at: startedAt,
    source: sourceName,
    project_id: projectId,
    status: 'RUNNING'
  });
  await log.save();

  try {
    const stats = await crawlFn(projectId, isInitialSync);

    log.total_scanned = stats.totalScanned;
    log.new_units_count = stats.newUnitsCount;
    log.updated_units_count = stats.updatedUnitsCount;
    log.status = 'SUCCESS';
    log.finished_at = new Date();
    await log.save();

    return stats;
  } catch (error) {
    console.error(`[Job ${sourceName}] ❌ Lỗi:`, error.message);
    log.status = 'FAILED';
    log.error_message = error.message;
    log.finished_at = new Date();
    await log.save();
    return { totalScanned: 0, newUnitsCount: 0, updatedUnitsCount: 0, error: error.message };
  }
}

/**
 * Hàm điều phối toàn bộ chu trình: Cào dữ liệu cả 2 web -> Lưu DB -> Gửi Mail
 * @param {boolean} isInitialSync - Chế độ lần đầu (không gửi mail)
 * @param {string|null} targetSource - Chỉ định nguồn cào ('hisale' hoặc 'salepro', null = cào cả 2)
 */
async function runJob(isInitialSync = false, targetSource = null) {
  console.log(`\n====================================================================`);
  console.log(`🚀 [RUNNER] BẮT ĐẦU PHIÊN CÀO RỔ HÀNG TỰ ĐỘNG - ${new Date().toLocaleString('vi-VN')}`);
  console.log(`====================================================================`);

  let totalNewAll = 0;

  // 1. CÀO HISALE (tự động quét & cào toàn bộ dự án đang mở bán khi HISALE_PROJECT_IDS=ALL hoặc theo danh sách ID)
  if (!targetSource || targetSource === 'hisale') {
    const hisaleScope = (process.env.HISALE_PROJECT_IDS || process.env.HISALE_PROJECT_ID || 'ALL').trim();
    const hisaleStats = await runCrawlerForSource(
      'hisale',
      (_, initSync) => crawlAllHisaleProjects(initSync),
      hisaleScope,
      isInitialSync
    );
    totalNewAll += hisaleStats.newUnitsCount;
  }

  // 2. CÀO SALEPRO (cào toàn bộ dự án đang mở bán khi SALEPRO_PROJECT_IDS=ALL hoặc theo danh sách ID)
  if (!targetSource || targetSource === 'salepro') {
    const saleproScope = (process.env.SALEPRO_PROJECT_IDS || process.env.SALEPRO_PROJECT_ID || 'ALL').trim();
    const saleproStats = await runCrawlerForSource(
      'salepro',
      async (_, initSync) => {
        const lowRes = (await crawlAllSaleProProjects(initSync)) || {};
        let highRes = { totalScanned: 0, newUnitsCount: 0, updatedUnitsCount: 0 };
        try {
          highRes = (await crawlAllSaleProHighRiseProjects(initSync)) || highRes;
        } catch (hrErr) {
          console.error('[SalePro Cao tầng] ❌ Lỗi không mong muốn:', hrErr.message);
        }

        return {
          ...lowRes,
          totalScanned: (Number(lowRes.totalScanned) || 0) + (Number(highRes.totalScanned) || 0),
          newUnitsCount: (Number(lowRes.newUnitsCount) || 0) + (Number(highRes.newUnitsCount) || 0),
          updatedUnitsCount:
            (Number(lowRes.updatedUnitsCount) || 0) + (Number(highRes.updatedUnitsCount) || 0),
        };
      },
      saleproScope,
      isInitialSync
    );
    totalNewAll += saleproStats.newUnitsCount;
  }

  // 3. GỬI EMAIL NẾU CÓ CĂN MỚI
  if (!isInitialSync && totalNewAll > 0) {
    console.log(`\n[Job] 🔔 Phát hiện tổng cộng ${totalNewAll} căn mới từ các nguồn! Đang gửi mail cho sếp...`);
    await sendNotificationEmail();
  } else if (isInitialSync) {
    console.log(`\n[Job] ✅ Chế độ --init: Đã nạp dữ liệu thành công và đánh dấu đã thông báo (không spam mail).`);
  } else {
    console.log(`\n[Job] ℹ️ Không có căn mới phát sinh trong phiên quét này.`);
  }

  console.log(`\n====================================================================`);
  console.log(`🏁 [RUNNER] HOÀN TẤT TOÀN BỘ PHIÊN CÀO LÚC ${new Date().toLocaleTimeString('vi-VN')}!`);
  console.log(`====================================================================\n`);
}

async function main() {
  await connectDB();

  const args = process.argv.slice(2);
  const isInit = args.includes('--init');
  const isNow = args.includes('--now');

  // Kiểm tra cờ lọc nguồn nếu có (ví dụ: --source=salepro hoặc --source=hisale)
  let targetSource = null;
  const sourceArg = args.find((a) => a.startsWith('--source='));
  if (sourceArg) {
    targetSource = sourceArg.split('=')[1].toLowerCase();
  }

  if (isInit) {
    console.log(`[Runner] Chế độ --init: Khởi tạo dữ liệu ${targetSource ? `cho [${targetSource}]` : 'cho CẢ 2 NGUỒN (HiSale & SalePro)'}...`);
    await runJob(true, targetSource);
    process.exit(0);
  } else if (isNow) {
    console.log(`[Runner] Chế độ --now: Cào ngay lập tức ${targetSource ? `cho [${targetSource}]` : 'cho CẢ 2 NGUỒN'} và gửi mail nếu có căn mới...`);
    await runJob(false, targetSource);
    process.exit(0);
  } else {
    // Chế độ lập lịch hằng ngày
    const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
    console.log(`[Scheduler] ⏰ Bot đã khởi động và lên lịch tự động: [${schedule}]`);
    console.log(`[Scheduler] Bot sẽ tự động thức dậy mỗi ngày để quét CẢ 2 WEBSITE (HiSale + SalePro) và gửi mail.`);
    console.log(`(Mẹo: Muốn chạy test ngay lập tức cả 2 web, gõ: npm run crawl:now)\n`);

    cron.schedule(schedule, async () => {
      console.log(`\n[Cron] 🔔 Đến giờ hẹn [${schedule}], bắt đầu kích hoạt job cào cả 2 nguồn...`);
      await runJob(false, null);
    });
  }
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
