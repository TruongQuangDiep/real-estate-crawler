const { getMovements } = require('./services/inventoryReport');
const nodemailer = require('nodemailer');
const Unit = require('./models/Unit');
const ReportLog = require('./models/ReportLog');
const { buildExcelReport } = require('./services/excelService');
const { buildDailyReport, escapeHtml, formatPriceVnd } = require('./services/reportService');

/**
 * Format timestamp string for email subjects.
 */
function formatEmailTimestamp(date = new Date()) {
  const timeOpts = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh',
  };
  const dateOpts = {
    timeZone: process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh',
  };
  const timeStr = date.toLocaleTimeString('vi-VN', timeOpts);
  const dateStr = date.toLocaleDateString('vi-VN', dateOpts);
  return `${timeStr} ${dateStr}`;
}

/**
 * Read and validate SMTP mail configuration from environment variables.
 */
function getSmtpConfig() {
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = process.env.SMTP_SECURE === 'true';
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const mailTo = (process.env.MAIL_TO || '').trim();
  const from = (process.env.MAIL_FROM || user).trim();

  const missingOrPlaceholder =
    !user ||
    !pass ||
    !mailTo ||
    user.includes('your_email') ||
    pass.includes('your_app_password') ||
    mailTo.includes('boss_email');

  if (missingOrPlaceholder) {
    return { valid: false };
  }

  return { valid: true, host, port, secure, user, pass, from, to: mailTo };
}

function createMailTransporter(smtpConfig) {
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass,
    },
  });
}

/**
 * Gửi email báo cáo định kỳ tổng hợp theo kết quả cào và danh sách căn mới
 * @param {Array<Object>} stats - Thống kê từng nguồn [{ source, totalScanned, newUnitsCount, status }]
 */
async function sendNotificationEmail(stats = []) {
  const mode = process.env.MAIL_REPORT_MODE || 'DAILY';
  const hasError = stats.some((s) => s.status === 'FAILED' || s.status === 'PARTIAL');

  // Lấy toàn bộ các căn chưa thông báo
  const units = await Unit.find({ is_notified: false })
    .sort({ created_at: -1, source: 1, project_name: 1, unit_code: 1 })
    .lean();

  const shouldSend =
    units.length > 0 ||
    mode === 'DAILY' ||
    (hasError && process.env.MAIL_ON_ERROR !== 'false');

  if (!shouldSend) {
    console.log('[Mailer] Không có căn mới và chế độ gửi chỉ định không yêu cầu gửi mail.');
    return { sent: false, count: 0 };
  }

  const smtpConfig = getSmtpConfig();
  if (!smtpConfig.valid) {
    console.warn(
      `[Mailer] ⚠️ Chưa cấu hình SMTP_USER, SMTP_PASS và MAIL_TO hợp lệ trong .env! Bỏ qua gửi email.`
    );
    return { sent: false, count: units.length, reason: 'NO_CONFIG' };
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('vi-VN', {
    timeZone: process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh',
  });

  const allFailed = stats.length > 0 && stats.every((s) => s.status === 'FAILED');
  const hasPartialOrError = stats.some((s) => s.status === 'FAILED' || s.status === 'PARTIAL');

  const movements = await getMovements(new Date(now.getTime() - 24 * 3600000), now);
  const statusText = allFailed
    ? '❌ ĐỒNG BỘ THẤT BẠI'
    : hasPartialOrError
      ? '⚠️ DỮ LIỆU CHƯA ĐẦY ĐỦ'
      : units.length > 0
        ? `+${units.length} CĂN MỚI`
        : movements.rows.length > 0 ? 'CÓ BIẾN ĐỘNG GIÁ/TRẠNG THÁI' : 'ĐỒNG BỘ ỔN ĐỊNH';

  const subject = `[RỔ HÀNG BĐS] ${dateStr} - ${statusText} (${formatEmailTimestamp(now)})`;
  const html = buildDailyReport({ stats, units, generatedAt: now, movements });

  const attachments = [];
  if (units.length > 0 || movements.rows.length > 0) {
    const excelBuffer = await buildExcelReport(units, { movements });
    attachments.push({
      filename: `Bao_cao_ro_hang_${dateStr.replace(/\//g, '-')}.xlsx`,
      content: excelBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  const transporter = createMailTransporter(smtpConfig);

  try {
    const info = await transporter.sendMail({
      from: smtpConfig.from,
      to: smtpConfig.to,
      subject,
      html,
      attachments,
    });

    if (!info.accepted?.length || info.rejected?.length) {
      throw new Error(
        `SMTP chưa gửi được đầy đủ cho tất cả người nhận. Bị từ chối: ${info.rejected?.join(', ') || 'Không rõ'}`
      );
    }

    console.log(`[Mailer] ✅ Gửi email thành công tới ${smtpConfig.to}! (MessageId: ${info.messageId})`);

    // Đánh dấu đã gửi mail cho các căn đã xuất hiện trong báo cáo
    if (units.length > 0) {
      const unitIds = units.map((u) => u._id);
      await Unit.updateMany({ _id: { $in: unitIds } }, { $set: { is_notified: true } });
    }

    // Ghi nhận lịch sử gửi báo cáo ngày vào MongoDB để chống gửi trùng khi restart VPS
    const todayDateKey = now.toISOString().slice(0, 10);
    await ReportLog.findOneAndUpdate(
      { report_type: 'DAILY', period_key: todayDateKey },
      {
        report_type: 'DAILY',
        period_key: todayDateKey,
        period_start: new Date(Date.now() - 24 * 60 * 60 * 1000),
        period_end: now,
        sent_at: now,
        status: 'SUCCESS',
        total_units: units.length,
        summary: { stats, unitsCount: units.length, movements: movements.summary },
        recipients: smtpConfig.to.split(',').map((e) => e.trim()),
        excel_file_name: units.length > 0 ? `Bao_cao_ro_hang_${dateStr.replace(/\//g, '-')}.xlsx` : '',
      },
      { upsert: true, new: true }
    ).catch((err) => console.warn('[Mailer] ⚠️ Không thể lưu ReportLog:', err.message));

    return { sent: true, count: units.length, messageId: info.messageId };
  } catch (error) {
    console.error(`[Mailer] ❌ Lỗi khi gửi mail:`, error.message);
    throw error;
  }
}

/**
 * Gửi email kiểm thử mẫu (hỗ trợ cả trường hợp có căn mới và trường hợp không có căn mới)
 * @param {object} options - { isEmpty: boolean }
 */
async function sendTestEmail(options = {}) {
  const smtpConfig = getSmtpConfig();
  if (!smtpConfig.valid) {
    throw new Error('Chưa cấu hình đầy đủ SMTP_USER, SMTP_PASS hoặc MAIL_TO thật trong .env.');
  }

  const transporter = createMailTransporter(smtpConfig);
  await transporter.verify();

  const isEmpty = options.isEmpty === true || process.argv.includes('--empty');

  const sampleUnits = isEmpty
    ? []
    : [
        {
          source: 'salepro',
          unit_code: 'S6.0204.19',
          project_name: 'VINHOMES GRAND PARK',
          subdivision: 'Origami',
          building: 'S6.02',
          floor: '04',
          unit_type: 'STUDIO',
          direction: 'ĐÔNG NAM',
          area_land: 30.2,
          area_build: 33.6,
          price: 2570402896,
          price_text: '2.57 tỷ',
          price_tts: 2090684015,
          status: 'Còn hàng',
          delivery_standard: 'Bàn giao cơ bản',
          bank_support: 'Hỗ trợ vay 70%',
          price_list_url: 'https://salepro.com/project-detail/vinhomes-grand-park#quy-can-cao-tang',
          created_at: new Date(),
        },
        {
          source: 'hisale',
          unit_code: 'BE601.S13',
          project_name: 'VINHOMES GRAND PARK',
          subdivision: 'BEVERLY',
          building: 'BE601',
          floor: '01',
          unit_type: 'SHOP',
          direction: 'TÂY BẮC',
          area_land: 73.6,
          area_build: 79.6,
          price: 12593328905,
          price_text: '12.59 tỷ',
          price_tts: 12724422260,
          status: 'Còn hàng',
          delivery_standard: 'Bàn giao thô',
          bank_support: 'Ân hạn nợ gốc 24 tháng',
          price_list_url: 'https://www.hisale.com/du-an/vinhomes-grand-park',
          created_at: new Date(),
        },
        {
          source: 'hisale',
          unit_code: 'VT-01',
          project_name: 'VINHOMES GLOBAL GATE HẠ LONG',
          subdivision: 'Vịnh Tây',
          unit_type: 'Liền kề',
          delivery_standard: 'Bàn giao thô',
          direction: 'Đông Bắc',
          area_land: 80,
          area_build: 260,
          price: 15200000000,
          price_text: '15.20 tỷ',
          status: 'Còn hàng',
          created_at: new Date(),
        },
      ];

  const sampleStats = [
    { source: 'HiSale', totalScanned: 7934, newUnitsCount: isEmpty ? 0 : 2, status: 'SUCCESS' },
    { source: 'SalePro Thấp tầng', totalScanned: 5519, newUnitsCount: 0, status: 'SUCCESS' },
    { source: 'SalePro Cao tầng', totalScanned: 9874, newUnitsCount: isEmpty ? 0 : 1, status: 'SUCCESS' },
  ];

  const now = new Date();
  const dateStr = now.toLocaleDateString('vi-VN', {
    timeZone: process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh',
  });

  const subject = isEmpty
    ? `[TEST - RỔ HÀNG BĐS] ${dateStr} - ĐỒNG BỘ ỔN ĐỊNH (Không có căn mới) (${formatEmailTimestamp(now)})`
    : `[TEST - RỔ HÀNG BĐS] ${dateStr} - +3 CĂN MỚI (Kèm file Excel) (${formatEmailTimestamp(now)})`;

  const html = buildDailyReport({ stats: sampleStats, units: sampleUnits, generatedAt: now });

  const attachments = [];
  if (sampleUnits.length > 0) {
    const excelBuffer = await buildExcelReport(sampleUnits);
    attachments.push({
      filename: `Bao_cao_ro_hang_${dateStr.replace(/\//g, '-')}.xlsx`,
      content: excelBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  const info = await transporter.sendMail({
    from: smtpConfig.from,
    to: smtpConfig.to,
    subject,
    html,
    attachments,
  });

  return { sent: true, messageId: info.messageId, to: smtpConfig.to, isEmpty };
}

/**
 * Gửi email cảnh báo sự cố kỹ thuật độc lập
 * TUYỆT ĐỐI KHÔNG làm thay đổi trạng thái is_notified của các căn hộ đang chờ thông báo!
 */
async function sendErrorAlert(failedSources = [], errorMessage = '') {
  const smtpConfig = getSmtpConfig();
  if (!smtpConfig.valid) {
    console.warn('[Mailer] ⚠️ Không thể gửi email cảnh báo sự cố do thiếu cấu hình SMTP trong .env');
    return { sent: false };
  }

  const now = new Date();
  const timeStr = formatEmailTimestamp(now);
  const subject = `[CẢNH BÁO HỆ THỐNG] Sự cố đồng bộ dữ liệu rổ hàng BĐS (${timeStr})`;

  const sourceListHtml = failedSources
    .map(
      (s) => `
    <li style="margin-bottom: 6px;">
      <strong>${escapeHtml(s.source || 'Nguồn không rõ')}:</strong> 
      <span style="color: #dc2626;">${escapeHtml(s.error || s.error_message || 'Gặp sự cố kết nối trong phiên quét')}</span>
    </li>
  `
    )
    .join('');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 20px auto; border: 1px solid #fca5a5; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
      <div style="background-color: #dc2626; color: #ffffff; padding: 18px 24px;">
        <h2 style="margin: 0; font-size: 18px;">⚠️ CẢNH BÁO SỰ CỐ ĐỒNG BỘ DỮ LIỆU</h2>
        <div style="font-size: 12px; margin-top: 4px; color: #fee2e2;">Thời gian phát hiện: ${escapeHtml(timeStr)}</div>
      </div>
      <div style="padding: 20px 24px; color: #334155; line-height: 1.6; font-size: 13px;">
        <p>Hệ thống Crawler phát hiện phiên quét dữ liệu tự động gặp sự cố:</p>
        <ul style="background-color: #fef2f2; padding: 14px 24px; border-radius: 6px; border-left: 4px solid #dc2626; margin: 12px 0;">
          ${sourceListHtml || `<li>${escapeHtml(errorMessage || 'Lỗi không xác định')}</li>`}
        </ul>
        <p style="margin-top: 15px; font-size: 12px; color: #64748b;">
          <em>Ghi chú: Toàn bộ căn hộ mới thu thập trước đó vẫn được bảo toàn nguyên vẹn trong MongoDB và sẽ được tổng hợp đầy đủ trong báo cáo buổi sáng lúc 07:00.</em>
        </p>
      </div>
      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 12px 24px; text-align: center; font-size: 11px; color: #94a3b8;">
        Real Estate Inventory Crawler System · Thông báo tự động
      </div>
    </div>
  `;

  const transporter = createMailTransporter(smtpConfig);
  try {
    const info = await transporter.sendMail({
      from: smtpConfig.from,
      to: smtpConfig.to,
      subject,
      html,
    });
    console.log(`[Mailer Alert] 🚨 Đã gửi email cảnh báo sự cố tới ${smtpConfig.to}! (MessageId: ${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Mailer Alert] ❌ Không thể gửi email cảnh báo:`, err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  buildDailyReport,
  sendNotificationEmail,
  sendErrorAlert,
  sendTestEmail,
  getSmtpConfig,
  escapeHtml,
  formatPriceVnd,
};
