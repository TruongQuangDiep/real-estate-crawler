require('dotenv').config();
const cron = require('node-cron');
const mongoose = require('mongoose');
const { connectDB } = require('./db');
const { crawlAllHisaleProjects } = require('./crawlers/hisaleCrawler');
const { crawlAllSaleProProjects } = require('./crawlers/saleproCrawler');
const { crawlAllSaleProHighRiseCrawler, crawlAllSaleProHighRiseProjects } = require('./crawlers/saleproHighRiseCrawler');
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
 * Hàm điều phối toàn bộ chu trình cào dữ liệu
 * @param {boolean} isInitialSync - Chế độ khởi tạo ban đầu (không gửi email)
 * @param {string|null} targetSource - Nguồn chỉ định ('hisale', 'salepro' hoặc null = cả 2)
 * @param {boolean} shouldSendMail - Có kích hoạt gửi email ngay sau phiên cào hay không
 */
async function runJob(isInitialSync = false, targetSource = null, shouldSendMail = true) {
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
    const hasError = stats.some((s) => s.status === 'FAILED');
    const mailOnError = process.env.MAIL_ON_ERROR !== 'false';

    if (!isInitialSync && (shouldSendMail || (hasError && mailOnError))) {
      console.log(`\n[Mailer] 📊 Đang tổng hợp kết quả phiên cào để tạo báo cáo Email & Excel...`);
      const mailResult = await sendNotificationEmail(stats);

      if (mailResult && mailResult.sent) {
        const logIds = stats.map((s) => s.logId).filter(Boolean);
        if (logIds.length > 0) {
          await CrawlLog.updateMany({ _id: { $in: logIds } }, { $set: { mail_sent: true } });
        }
      }
    } else if (isInitialSync) {
      console.log(`\n[Job] ✅ Chế độ --init: Đã nạp dữ liệu nền thành công và đánh dấu đã thông báo (không spam mail).`);
    } else {
      console.log(`\n[Job] ℹ️ Phiên quét định kỳ hoàn tất. Dữ liệu căn mới đã lưu vào MongoDB và chờ lịch gửi email tổng hợp buổi sáng.`);
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

/**
 * Hàm kích hoạt gửi email báo cáo tổng hợp buổi sáng (Morning Digest)
 */
async function runDailyReportDigest() {
  console.log(`\n====================================================================`);
  console.log(`📬 [MAIL DIGEST] KÍCH HOẠT BÁO CÁO ĐỊNH KỲ BUỔI SÁNG - ${new Date().toLocaleString('vi-VN')}`);
  console.log(`====================================================================`);

  try {
    // Thu thập kết quả quét mới nhất của từng nguồn trong vòng 24 giờ qua
    const recentLogs = await CrawlLog.find({
      started_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    })
      .sort({ started_at: -1 })
      .lean();

    const sourceMap = new Map();
    for (const log of recentLogs) {
      if (!sourceMap.has(log.source)) {
        sourceMap.set(log.source, {
          source: log.source,
          totalScanned: log.total_scanned || 0,
          newUnitsCount: log.new_units_count || 0,
          status: log.status || 'SUCCESS',
        });
      }
    }

    // Đảm bảo có đủ 3 nguồn dữ liệu hiển thị trên bảng thống kê
    const defaultSources = ['HiSale', 'SalePro Thấp tầng', 'SalePro Cao tầng'];
    for (const src of defaultSources) {
      if (!sourceMap.has(src)) {
        sourceMap.set(src, { source: src, totalScanned: 0, newUnitsCount: 0, status: 'SUCCESS' });
      }
    }

    const stats = Array.from(sourceMap.values());
    await sendNotificationEmail(stats);
    console.log(`[Mail Digest] ✅ Hoàn tất phiên gửi báo cáo tổng hợp buổi sáng!`);
  } catch (error) {
    console.error(`[Mail Digest] ❌ Lỗi khi gửi báo cáo tổng hợp buổi sáng:`, error.message);
  }
}

async function main() {
  await connectDB();

  const args = process.argv.slice(2);
  const isInit = args.includes('--init');
  const isNow = args.includes('--now');
  const isDigest = args.includes('--digest');

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
    const success = await runJob(true, targetSource, false);
    await mongoose.disconnect();
    process.exit(success ? 0 : 1);
  } else if (isNow) {
    console.log(`[Runner] Chế độ --now: Quét ngay lập tức ${targetSource ? `cho [${targetSource}]` : 'cho CẢ 2 NGUỒN'} và tạo báo cáo...`);
    const success = await runJob(false, targetSource, true);
    await mongoose.disconnect();
    process.exit(success ? 0 : 1);
  } else if (isDigest) {
    console.log(`[Runner] Chế độ --digest: Gửi ngay báo cáo tổng hợp kèm file Excel...`);
    await runDailyReportDigest();
    await mongoose.disconnect();
    process.exit(0);
  } else {
    // Chế độ lịch tự động (Cron Job)
    const crawlSchedule = process.env.CRON_SCHEDULE || '0 6,10,14,18,22 * * *';
    const mailSchedule = (process.env.MAIL_CRON_SCHEDULE || '0 7 * * *').trim();
    const timezone = process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh';

    if (!cron.validate(crawlSchedule)) {
      throw new Error(`CRON_SCHEDULE không hợp lệ: ${crawlSchedule}`);
    }
    if (mailSchedule && !cron.validate(mailSchedule)) {
      throw new Error(`MAIL_CRON_SCHEDULE không hợp lệ: ${mailSchedule}`);
    }

    console.log(`[Scheduler] ⏰ Bot đã khởi động dịch vụ tự động:`);
    console.log(`  - Lịch cào dữ liệu (Crawl Schedule): [${crawlSchedule}]`);
    console.log(`  - Lịch gửi báo cáo email (Mail Schedule): [${mailSchedule}]`);
    console.log(`  - Múi giờ hoạt động: ${timezone}`);
    console.log(`  - Chế độ báo cáo: ${process.env.MAIL_REPORT_MODE || 'DAILY'}`);
    console.log(`\n(Mẹo: Muốn quét và gửi email test ngay lập tức, gõ: npm run crawl:now)\n`);

    // 1. Lịch cào dữ liệu: Tích lũy căn mới vào MongoDB
    cron.schedule(
      crawlSchedule,
      async () => {
        console.log(`\n[Cron] 🔔 Đến giờ cào dữ liệu [${crawlSchedule}], bắt đầu quét...`);
        // Nếu có cấu hình mailSchedule riêng thì phiên cào định kỳ sẽ không bắn mail (trừ khi có lỗi)
        const sendMailImmediately = !mailSchedule;
        await runJob(false, null, sendMailImmediately);
      },
      { timezone }
    );

    // 2. Lịch gửi email báo cáo tổng hợp buổi sáng
    if (mailSchedule) {
      cron.schedule(
        mailSchedule,
        async () => {
          console.log(`\n[Cron Mail] 📬 Đến giờ hẹn gửi báo cáo buổi sáng [${mailSchedule}], bắt đầu tổng hợp...`);
          await runDailyReportDigest();
        },
        { timezone }
      );
    }
  }
}

main().catch(async (err) => {
  console.error('[Fatal Error]', err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
