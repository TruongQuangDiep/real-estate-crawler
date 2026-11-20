const nodemailer = require('nodemailer');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const CrawlLog = require('../models/CrawlLog');
const ReportLog = require('../models/ReportLog');
const { buildExcelReport } = require('./excelService');
const { escapeHtml, formatPriceVnd } = require('./reportService');

/**
 * Tính toán mốc thời gian 7 ngày của tuần trước (từ 00:00 Thứ Hai tuần trước đến 00:00 Thứ Hai tuần này)
 */
function getWeeklyPeriod(targetDate = new Date()) {
  const d = new Date(targetDate);
  // Xác định ngày trong tuần (0: Chủ Nhật, 1: Thứ Hai, ..., 6: Thứ Bảy)
  const day = d.getDay();
  // Khoảng cách tới Thứ Hai tuần này
  const diffToCurrentMonday = (day === 0 ? -6 : 1) - day;
  
  const currentMonday = new Date(d);
  currentMonday.setDate(d.getDate() + diffToCurrentMonday);
  currentMonday.setHours(0, 0, 0, 0);

  const prevMonday = new Date(currentMonday);
  prevMonday.setDate(currentMonday.getDate() - 7);

  // Khóa định danh tuần, ví dụ: 2026-W47
  const year = prevMonday.getFullYear();
  const firstJan = new Date(year, 0, 1);
  const weekNum = Math.ceil(((prevMonday - firstJan) / 86400000 + firstJan.getDay() + 1) / 7);
  const periodKey = `${year}-W${String(weekNum).padStart(2, '0')}`;

  return {
    periodStart: prevMonday,
    periodEnd: currentMonday,
    periodKey,
  };
}

/**
 * Xây dựng nội dung HTML email báo cáo tuần
 */
function buildWeeklyReportHtml({
  periodStart,
  periodEnd,
  totalUnits,
  unitsBySource = {},
  topProjects = [],
  crawlStats = {},
  mediaStats = {},
  unitsByType = {},
}) {
  const dateOpts = { timeZone: process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh' };
  const startStr = periodStart.toLocaleDateString('vi-VN', dateOpts);
  const endStr = periodEnd.toLocaleDateString('vi-VN', dateOpts);

  // Bảng dự án nổi bật
  const projectRows = topProjects.slice(0, 8).map((p, idx) => `
    <tr style="border-bottom: 1px solid #f1f5f9;">
      <td style="padding: 10px 14px; text-align: center; color: #64748b; font-weight: 600;">${idx + 1}</td>
      <td style="padding: 10px 14px; font-weight: 600; color: #1e293b;">${escapeHtml(p.name)}</td>
      <td style="padding: 10px 14px; text-align: center;">
        <span style="background-color: ${p.source === 'hisale' ? '#e0f2fe' : '#ffedd5'}; color: ${p.source === 'hisale' ? '#0369a1' : '#c2410c'}; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 700;">
          ${escapeHtml(p.source.toUpperCase())}
        </span>
      </td>
      <td style="padding: 10px 14px; text-align: center; font-weight: 800; color: #dc2626;">+${p.count.toLocaleString('vi-VN')}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Báo cáo tổng hợp giỏ hàng BĐS theo tuần</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.5;">
  <div style="max-width: 820px; margin: 24px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);">
    
    <!-- HEADER -->
    <div style="background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); color: #ffffff; padding: 26px 28px;">
      <div style="font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #60a5fa; margin-bottom: 6px;">
        WEEKLY EXECUTIVE INVENTORY SUMMARY
      </div>
      <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px;">
        📊 BÁO CÁO TỔNG HỢP GIỎ HÀNG BĐS THEO TUẦN
      </h1>
      <div style="margin-top: 8px; font-size: 13px; color: #cbd5e1;">
        Chu kỳ thống kê: <strong>00:00 ${escapeHtml(startStr)}</strong> đến <strong>00:00 ${escapeHtml(endStr)}</strong>
      </div>
    </div>

    <!-- BODY CONTAINER -->
    <div style="padding: 24px 28px;">
      
      <!-- KPI STAT CARDS -->
      <table style="width: 100%; border-collapse: separate; border-spacing: 10px 0; margin-bottom: 24px;">
        <tr>
          <td style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; text-align: center; width: 25%;">
            <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase;">Căn Mới Trong Tuần</div>
            <div style="font-size: 24px; font-weight: 800; color: #dc2626; margin-top: 4px;">+${totalUnits.toLocaleString('vi-VN')}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">toàn hệ thống</div>
          </td>
          <td style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; text-align: center; width: 25%;">
            <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase;">Phiên Quét Dữ Liệu</div>
            <div style="font-size: 24px; font-weight: 800; color: #1e293b; margin-top: 4px;">${crawlStats.totalSessions || 0}</div>
            <div style="font-size: 11px; color: #15803d; margin-top: 2px;">${crawlStats.successSessions || 0} thành công</div>
          </td>
          <td style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; text-align: center; width: 25%;">
            <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase;">Ảnh Đồng Bộ Drive</div>
            <div style="font-size: 24px; font-weight: 800; color: #2563eb; margin-top: 4px;">${mediaStats.synced || 0}</div>
            <div style="font-size: 11px; color: #64748b; margin-top: 2px;">căn có ảnh Drive</div>
          </td>
          <td style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; text-align: center; width: 25%;">
            <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase;">Đang Chờ Đồng Bộ</div>
            <div style="font-size: 24px; font-weight: 800; color: #b45309; margin-top: 4px;">${mediaStats.pending || 0}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">trong hàng đợi</div>
          </td>
        </tr>
      </table>

      <!-- 1. PHÂN BỔ THEO NGUỒN VÀ LOẠI HÌNH SẢN PHẨM -->
      <h2 style="font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.5px;">
        1. Phân bổ rổ hàng theo nguồn & loại hình sản phẩm
      </h2>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <thead>
          <tr style="background-color: #f8fafc; color: #475569; font-size: 11px; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">
            <th style="padding: 10px 14px; text-align: left;">Nguồn Dữ Liệu</th>
            <th style="padding: 10px 14px; text-align: center;">Thấp Tầng</th>
            <th style="padding: 10px 14px; text-align: center;">Cao Tầng</th>
            <th style="padding: 10px 14px; text-align: center;">Tổng Căn Mới</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 14px; font-weight: 600; color: #0369a1;">HISALE</td>
            <td style="padding: 10px 14px; text-align: center;">${(unitsBySource.hisaleLow || 0).toLocaleString('vi-VN')}</td>
            <td style="padding: 10px 14px; text-align: center;">${(unitsBySource.hisaleHigh || 0).toLocaleString('vi-VN')}</td>
            <td style="padding: 10px 14px; text-align: center; font-weight: bold; color: #dc2626;">+${(unitsBySource.hisale || 0).toLocaleString('vi-VN')}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 14px; font-weight: 600; color: #c2410c;">SALEPRO</td>
            <td style="padding: 10px 14px; text-align: center;">${(unitsBySource.saleproLow || 0).toLocaleString('vi-VN')}</td>
            <td style="padding: 10px 14px; text-align: center;">${(unitsBySource.saleproHigh || 0).toLocaleString('vi-VN')}</td>
            <td style="padding: 10px 14px; text-align: center; font-weight: bold; color: #dc2626;">+${(unitsBySource.salepro || 0).toLocaleString('vi-VN')}</td>
          </tr>
        </tbody>
      </table>

      <!-- 2. TOP DỰ ÁN CÓ NHIỀU CĂN MỚI NHẤT -->
      <h2 style="font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.5px;">
        2. Top dự án bổ sung căn mới nhiều nhất trong tuần
      </h2>
      <div style="overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
          <thead>
            <tr style="background-color: #f8fafc; color: #475569; font-size: 11px; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">
              <th style="padding: 10px 14px; width: 40px; text-align: center;">STT</th>
              <th style="padding: 10px 14px;">Tên Dự Án</th>
              <th style="padding: 10px 14px; text-align: center;">Nguồn</th>
              <th style="padding: 10px 14px; text-align: center;">Số Căn Mới</th>
            </tr>
          </thead>
          <tbody>
            ${projectRows || '<tr><td colspan="4" style="padding: 16px; text-align: center; color: #94a3b8;">Không có dự án nào bổ sung căn mới trong tuần qua.</td></tr>'}
          </tbody>
        </table>
      </div>

      <!-- 3. HIỆU NĂNG VẬN HÀNH CRAWLER -->
      <h2 style="font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.5px;">
        3. Thống kê vận hành crawler & đồng bộ Google Drive
      </h2>
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 24px; font-size: 12px; color: #334155;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span>• Tổng số phiên quét tự động: <strong>${crawlStats.totalSessions || 0} phiên</strong></span>
          <span>• Tỷ lệ quét thành công: <strong>${crawlStats.successRate || 100}%</strong></span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span>• Số phiên thành công một phần (có dự án con lỗi nhẹ): <strong>${crawlStats.partialSessions || 0}</strong></span>
          <span>• Số phiên thất bại: <strong>${crawlStats.failedSessions || 0}</strong></span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>• Thư mục Google Drive tổng: <strong>${escapeHtml(process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '1QLSf5pecivmn6KfPNCrJlbUHMPRfYpuk')}</strong></span>
          <span>• Trạng thái media storage: <strong>${process.env.IMAGE_SYNC_ENABLED === 'true' ? 'Đang kích hoạt' : 'Tạm tắt'}</strong></span>
        </div>
      </div>

      <!-- EXCEL ATTACHMENT CALLOUT -->
      <div style="background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 14px 18px; margin-bottom: 10px;">
        <div style="font-weight: 700; color: #1e40af; font-size: 13px; margin-bottom: 4px;">
          📎 ĐÃ ĐÍNH KÈM FILE EXCEL TỔNG HỢP 24 CỘT CHI TIẾT
        </div>
        <div style="font-size: 12px; color: #1d4ed8; line-height: 1.4;">
          File Excel tổng hợp toàn bộ <strong>${totalUnits.toLocaleString('vi-VN')} căn mới</strong> trong tuần, bao gồm đầy đủ 24 cột thông số, link hình ảnh Google Drive riêng của căn, ảnh dự án, layout và hyperlink mở trực tiếp thư mục Drive.
        </div>
      </div>

    </div>

    <!-- FOOTER -->
    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 28px; text-align: center; font-size: 11px; color: #64748b;">
      <div>Báo cáo tuần tự động gửi lúc 06:00 sáng thứ Hai bởi <strong>Real Estate Crawler V2 Service</strong>.</div>
      <div style="margin-top: 4px; color: #94a3b8;">Hệ thống lưu trữ MongoDB Local & Media Google Drive · Bảo mật nội bộ doanh nghiệp.</div>
    </div>

  </div>
</body>
</html>
  `;
}

/**
 * Điều phối tổng hợp và gửi Báo cáo tuần (Weekly Report)
 * @param {Object} options
 * @param {boolean} options.isForced - Bỏ qua kiểm tra đã gửi trùng trong tuần (cho test)
 * @param {boolean} options.isTest - Chế độ test giao diện giả lập (không ảnh hưởng dữ liệu)
 */
async function sendWeeklyReport(options = {}) {
  const isForced = Boolean(options.isForced);
  const isTest = Boolean(options.isTest);

  console.log(`\n====================================================================`);
  console.log(`📊 [WEEKLY REPORT] BẮT ĐẦU TỔNG HỢP BÁO CÁO TUẦN - ${new Date().toLocaleString('vi-VN')}`);
  console.log(`====================================================================`);

  const { periodStart, periodEnd, periodKey } = getWeeklyPeriod(new Date());

  // 1. Kiểm tra chống gửi trùng báo cáo tuần trong MongoDB
  if (!isForced && !isTest) {
    const existingLog = await ReportLog.findOne({
      report_type: 'WEEKLY',
      period_key: periodKey,
      status: 'SUCCESS',
    });
    if (existingLog) {
      console.log(`[Weekly Report] ℹ️ Báo cáo tuần [${periodKey}] đã được gửi thành công vào lúc ${existingLog.sent_at.toLocaleString('vi-VN')}. Bỏ qua để tránh gửi trùng.`);
      return { sent: false, reason: 'ALREADY_SENT', periodKey };
    }
  }

  // 2. Thu thập danh sách căn mới trong khoảng thời gian [periodStart, periodEnd)
  // LƯU Ý NGHIỆP VỤ: Báo cáo tuần KHÔNG phụ thuộc vào is_notified và KHÔNG cập nhật trường này!
  let newUnits = [];
  if (isTest) {
    // Dữ liệu mẫu phục vụ test giao diện
    newUnits = [
      {
        source: 'hisale',
        project_name: 'VINHOMES GLOBAL GATE HA LONG',
        subdivision: 'Vịnh Hoàng Gia',
        building: '',
        floor: '',
        unit_code: 'HG12-08',
        unit_type: 'Liền kề',
        direction: 'Đông Nam',
        area_land: 85,
        area_build: 220,
        price: 18500000000,
        price_tts: 16800000000,
        status: 'Còn hàng',
        price_list_url: 'https://hisale.vn/bang-hang',
        drive_image_urls: ['https://drive.google.com/file/d/test1'],
        drive_folder_url: 'https://drive.google.com/drive/folders/testFolder',
        image_sync_status: 'SUCCESS',
        created_at: new Date(),
      },
      {
        source: 'salepro',
        project_name: 'VINHOMES GRAND PARK',
        subdivision: 'The Beverly Solari',
        building: 'BS12',
        floor: '18',
        unit_code: 'BS12.1809',
        unit_type: '2PN',
        direction: 'Tây Bắc',
        area_land: 68.5,
        area_build: 62.1,
        price: 4300000000,
        price_tts: 3950000000,
        status: 'Còn hàng',
        price_list_url: 'https://salepro.com/quy-can',
        drive_project_image_urls: ['https://drive.google.com/file/d/projectTest'],
        image_sync_status: 'NO_IMAGE',
        created_at: new Date(),
      },
    ];
  } else {
    newUnits = await Unit.find({
      created_at: { $gte: periodStart, $lt: periodEnd },
    })
      .sort({ created_at: -1 })
      .lean();
  }

  // 3. Tính toán số liệu thống kê
  const totalUnits = newUnits.length;
  const unitsBySource = {
    hisale: newUnits.filter((u) => u.source === 'hisale').length,
    salepro: newUnits.filter((u) => u.source === 'salepro').length,
    hisaleLow: newUnits.filter((u) => u.source === 'hisale' && !u.floor).length,
    hisaleHigh: newUnits.filter((u) => u.source === 'hisale' && u.floor).length,
    saleproLow: newUnits.filter((u) => u.source === 'salepro' && !u.floor).length,
    saleproHigh: newUnits.filter((u) => u.source === 'salepro' && u.floor).length,
  };

  // Thống kê theo dự án
  const projectMap = new Map();
  for (const u of newUnits) {
    const key = `${u.source}::${u.project_name}`;
    if (!projectMap.has(key)) {
      projectMap.set(key, { name: u.project_name, source: u.source, count: 0 });
    }
    projectMap.get(key).count += 1;
  }
  const topProjects = Array.from(projectMap.values()).sort((a, b) => b.count - a.count);

  // Thống kê số phiên crawl từ CrawlLog
  let crawlStats = { totalSessions: 0, successSessions: 0, partialSessions: 0, failedSessions: 0, successRate: 100 };
  if (!isTest) {
    const logsInWeek = await CrawlLog.find({
      started_at: { $gte: periodStart, $lt: periodEnd },
    }).lean();

    crawlStats.totalSessions = logsInWeek.length;
    crawlStats.successSessions = logsInWeek.filter((l) => l.status === 'SUCCESS').length;
    crawlStats.partialSessions = logsInWeek.filter((l) => l.status === 'PARTIAL').length;
    crawlStats.failedSessions = logsInWeek.filter((l) => l.status === 'FAILED').length;
    if (crawlStats.totalSessions > 0) {
      crawlStats.successRate = (
        ((crawlStats.successSessions + crawlStats.partialSessions) / crawlStats.totalSessions) *
        100
      ).toFixed(1);
    }
  }

  // Thống kê hình ảnh
  const mediaStats = {
    synced: newUnits.filter((u) => u.drive_image_urls && u.drive_image_urls.length > 0).length,
    pending: newUnits.filter((u) => u.image_sync_status === 'PENDING' || u.image_sync_status === 'PROCESSING').length,
    noImage: newUnits.filter((u) => u.image_sync_status === 'NO_IMAGE').length,
  };

  // 4. Tạo file Excel 24 cột đính kèm
  const excelBuffer = await buildExcelReport(newUnits, { sheetTitle: 'Báo cáo tuần' });
  const dateTag = periodStart.toISOString().slice(0, 10).replace(/-/g, '');
  const excelFileName = `Bao_Cao_Tuan_BDS_${periodKey}_${dateTag}.xlsx`;

  // 5. Tạo nội dung email
  const htmlContent = buildWeeklyReportHtml({
    periodStart,
    periodEnd,
    totalUnits,
    unitsBySource,
    topProjects,
    crawlStats,
    mediaStats,
  });

  // 6. Gửi email qua SMTP
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const mailTo = (process.env.MAIL_TO || '').trim();
  const from = (process.env.MAIL_FROM || user).trim();

  if (!user || !pass || !mailTo || user.includes('your_email')) {
    console.warn('[Weekly Report] ⚠️ Chưa cấu hình SMTP Gmail trong .env. Bỏ qua gửi mail.');
    return { sent: false, reason: 'NO_SMTP_CONFIG' };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });

  const subject = `[BÁO CÁO TUẦN] Rổ hàng BĐS ${periodKey} (+${totalUnits} căn mới)`;

  await transporter.sendMail({
    from,
    to: mailTo,
    subject,
    html: htmlContent,
    attachments: [
      {
        filename: excelFileName,
        content: excelBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  });

  console.log(`[Weekly Report] ✅ Đã gửi thành công báo cáo tuần [${periodKey}] tới ${mailTo}!`);

  // 7. Ghi nhận lịch sử gửi vào MongoDB để chống gửi trùng khi restart VPS
  if (!isTest) {
    await ReportLog.findOneAndUpdate(
      { report_type: 'WEEKLY', period_key: periodKey },
      {
        report_type: 'WEEKLY',
        period_key: periodKey,
        period_start: periodStart,
        period_end: periodEnd,
        sent_at: new Date(),
        status: 'SUCCESS',
        total_units: totalUnits,
        summary: {
          totalUnits,
          unitsBySource,
          crawlStats,
          mediaStats,
        },
        recipients: mailTo.split(',').map((e) => e.trim()),
        excel_file_name: excelFileName,
      },
      { upsert: true, new: true }
    );
  }

  return { sent: true, periodKey, totalUnits };
}

module.exports = {
  getWeeklyPeriod,
  buildWeeklyReportHtml,
  sendWeeklyReport,
};
