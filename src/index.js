require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const { connectDB } = require('./db');
const { crawlAllHisaleProjects } = require('./crawlers/hisaleCrawler');
const { crawlAllSaleProProjects } = require('./crawlers/saleproCrawler');
const { crawlAllSaleProHighRiseProjects } = require('./crawlers/saleproHighRiseCrawler');
const { sendNotificationEmail } = require('./mailer');
const CrawlLog = require('./models/CrawlLog');

let isRunning = false;

/**
 * Điều phối thực thi và ghi vết lịch sử (CrawlLog) cho một nguồn cào cụ thể
 */
async function runCrawlerForSource(sourceName, crawlFn, isInitialSync = false) {
  const startedAt = new Date();
  const log = new CrawlLog({
    started_at: startedAt,
    source: sourceName,
    status: 'RUNNING',
  });
  await log.save();

  try {
    const stats = (await crawlFn(isInitialSync)) || {};

    const successProjects = Number(stats.successProjects) || 0;
    const failedProjects = Number(stats.errorProjects || stats.failedProjects) || 0;
    const skippedProjects = Number(stats.skippedProjects) || 0;
    const totalProjects = successProjects + failedProjects + skippedProjects;

    // Phân định rõ trạng thái: SUCCESS, PARTIAL (thành công 1 phần), hoặc FAILED
    let status = 'SUCCESS';
    if (failedProjects > 0 || skippedProjects > 0) {
      status = successProjects > 0 ? 'PARTIAL' : 'FAILED';
    }

    log.total_scanned = Number(stats.totalScanned) || 0;
    log.new_units_count = Number(stats.newUnitsCount) || 0;
    log.updated_units_count = Number(stats.updatedUnitsCount) || 0;
    log.success_projects = successProjects;
    log.failed_projects = failedProjects;
    log.skipped_projects = skippedProjects;
    log.total_projects = totalProjects;
    log.status = status;
    log.finished_at = new Date();
    await log.save();

    return {
      ...stats,
      source: sourceName,
      status,
      logId: log._id,
      totalScanned: log.total_scanned,
      newUnitsCount: log.new_units_count,
      updatedUnitsCount: log.updated_units_count,
    };
  } catch (error) {
    console.error(`[Job ${sourceName}] ❌ Lỗi không thể khắc phục:`, error.message);
    log.status = 'FAILED';
    log.error_message = error.message;
    log.finished_at = new Date();
    await log.save();

    return {
      source: sourceName,
      status: 'FAILED',
      totalScanned: 0,
      newUnitsCount: 0,
      updatedUnitsCount: 0,
      logId: log._id,
      error: error.message,
    };
  }
}

/**
 * Hàm điều phối toàn bộ chu trình: Cào dữ liệu -> Lưu DB -> Báo cáo Email & Excel
 * @param {boolean} isInitialSync - Chế độ khởi tạo ban đầu (không gửi email)
 * @param {string|null} targetSource - Nguồn chỉ định ('hisale', 'salepro' hoặc null = cả 2)
 */
async function runJob(isInitialSync = false, targetSource = null) {
  if (isRunning) {
    console.warn('[Runner] ⚠️ Đang có một phiên quét khác đang chạy. Bỏ qua yêu cầu mới để tránh xung đột dữ liệu.');
    return false;
  }

  isRunning = true;
  const startedAt = new Date();

  console.log(`\n====================================================================`);
  console.log(`🚀 [RUNNER] BẮT ĐẦU PHIÊN CÀO RỔ HÀNG TỰ ĐỘNG - ${startedAt.toLocaleString('vi-VN')}`);
  console.log(`====================================================================`);

  try {
    const stats = [];

    // 1. CÀO HISALE
    if (!targetSource || targetSource === 'hisale') {
      const hisaleResult = await runCrawlerForSource('HiSale', crawlAllHisaleProjects, isInitialSync);
      stats.push(hisaleResult);
    }

    // 2. CÀO SALEPRO THẤP TẦNG
    if (!targetSource || targetSource === 'salepro') {
      const saleproLowResult = await runCrawlerForSource('SalePro Thấp tầng', crawlAllSaleProProjects, isInitialSync);
      stats.push(saleproLowResult);

      // 3. CÀO SALEPRO CAO TẦNG
      const saleproHighResult = await runCrawlerForSource('SalePro Cao tầng', crawlAllSaleProHighRiseProjects, isInitialSync);
      stats.push(saleproHighResult);
    }

    // 4. BÁO CÁO QUA EMAIL & EXCEL
    if (!isInitialSync) {
      console.log(`\n[Mailer] 📊 Đang tổng hợp kết quả phiên cào để tạo báo cáo Email & Excel...`);
      const mailResult = await sendNotificationEmail(stats);

      if (mailResult && mailResult.sent) {
        const logIds = stats.map((s) => s.logId).filter(Boolean);
        if (logIds.length > 0) {
          await CrawlLog.updateMany({ _id: { $in: logIds } }, { $set: { mail_sent: true } });
        }
      }
    } else {
      console.log(`\n[Job] ✅ Chế độ --init: Đã nạp dữ liệu nền thành công và đánh dấu đã thông báo (không spam mail).`);
    }

    console.log(`\n====================================================================`);
    console.log(`🏁 [RUNNER] HOÀN TẤT TOÀN BỘ PHIÊN CÀO LÚC ${new Date().toLocaleTimeString('vi-VN')}!`);
    console.log(`====================================================================\n`);

    return stats.every((s) => s.status === 'SUCCESS');
  } catch (err) {
    console.error('[Runner] ❌ Phiên xử lý gặp lỗi nghiêm trọng:', err.message);
    return false;
  } finally {
    isRunning = false;
  }
}

async function main() {
  await connectDB();

  const args = process.argv.slice(2);
  const isInit = args.includes('--init');
  const isNow = args.includes('--now');

  // Lọc nguồn: --source=salepro hoặc --source=hisale
  let targetSource = null;
  const sourceArg = args.find((a) => a.startsWith('--source='));
  if (sourceArg) {
    targetSource = sourceArg.split('=')[1].toLowerCase();
    if (!['hisale', 'salepro'].includes(targetSource)) {
      throw new Error(`Nguồn dữ liệu không hợp lệ: [${targetSource}]. Chỉ chấp nhận 'hisale' hoặc 'salepro'.`);
    }
  }

  if (isInit) {
    console.log(`[Runner] Chế độ --init: Khởi tạo dữ liệu ${targetSource ? `cho [${targetSource}]` : 'cho CẢ 2 NGUỒN'}...`);
    const success = await runJob(true, targetSource);
    await mongoose.disconnect();
    process.exit(success ? 0 : 1);
  } else if (isNow) {
    console.log(`[Runner] Chế độ --now: Quét ngay lập tức ${targetSource ? `cho [${targetSource}]` : 'cho CẢ 2 NGUỒN'} và tạo báo cáo...`);
    const success = await runJob(false, targetSource);
    await mongoose.disconnect();
    process.exit(success ? 0 : 1);
  } else {
    // Chế độ lịch tự động (Cron Job)
    const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
    const timezone = process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh';

    if (!cron.validate(schedule)) {
      throw new Error(`CRON_SCHEDULE không hợp lệ: ${schedule}`);
    }

    console.log(`[Scheduler] ⏰ Bot đã khởi động và lên lịch tự động: [${schedule}]`);
    console.log(`[Scheduler] Múi giờ hoạt động: ${timezone}`);
    console.log(`[Scheduler] Chế độ báo cáo email: ${process.env.MAIL_REPORT_MODE || 'DAILY'}`);
    console.log(`(Mẹo: Muốn chạy thử ngay lập tức cả 2 web, gõ: npm run crawl:now)\n`);

    cron.schedule(
      schedule,
      async () => {
        console.log(`\n[Cron] 🔔 Đến giờ hẹn [${schedule}], bắt đầu kích hoạt phiên cào tự động...`);
        await runJob(false, null);
      },
      { timezone }
    );
  }
}

main().catch(async (err) => {
  console.error('[Fatal Error]', err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
