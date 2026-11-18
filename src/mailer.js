const nodemailer = require('nodemailer');
const Unit = require('./models/Unit');
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

  const statusText = hasError
    ? '⚠️ CÓ LỖI KẾT NỐI'
    : units.length > 0
      ? `+${units.length} CĂN MỚI`
      : 'ĐỒNG BỘ ỔN ĐỊNH';

  const subject = `[RỔ HÀNG BĐS] ${dateStr} - ${statusText} (${formatEmailTimestamp(now)})`;
  const html = buildDailyReport({ stats, units, generatedAt: now });

  const attachments = [];
  if (units.length > 0) {
    const excelBuffer = await buildExcelReport(units);
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

    if (info.rejected && info.rejected.length > 0 && (!info.accepted || info.accepted.length === 0)) {
      throw new Error(`SMTP từ chối toàn bộ người nhận: ${info.rejected.join(', ')}`);
    }

    console.log(`[Mailer] ✅ Gửi email thành công tới ${smtpConfig.to}! (MessageId: ${info.messageId})`);

    // Đánh dấu đã gửi mail cho các căn đã xuất hiện trong báo cáo
    if (units.length > 0) {
      const unitIds = units.map((u) => u._id);
      await Unit.updateMany({ _id: { $in: unitIds } }, { $set: { is_notified: true } });
    }

    return { sent: true, count: units.length, messageId: info.messageId };
  } catch (error) {
    console.error(`[Mailer] ❌ Lỗi khi gửi mail:`, error.message);
    throw error;
  }
}

/**
 * Gửi email kiểm thử mẫu (bao gồm bảng HTML mẫu và file Excel đính kèm)
 */
async function sendTestEmail() {
  const smtpConfig = getSmtpConfig();
  if (!smtpConfig.valid) {
    throw new Error('Chưa cấu hình đầy đủ SMTP_USER, SMTP_PASS hoặc MAIL_TO thật trong .env.');
  }

  const transporter = createMailTransporter(smtpConfig);
  await transporter.verify();

  const sampleUnits = [
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
    { source: 'HiSale', totalScanned: 1131, newUnitsCount: 2, status: 'SUCCESS' },
    { source: 'SalePro Thấp tầng', totalScanned: 5397, newUnitsCount: 0, status: 'SUCCESS' },
    { source: 'SalePro Cao tầng', totalScanned: 8208, newUnitsCount: 1, status: 'SUCCESS' },
  ];

  const now = new Date();
  const dateStr = now.toLocaleDateString('vi-VN', {
    timeZone: process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh',
  });
  const subject = `[TEST - RỔ HÀNG BĐS] Kiểm thử báo cáo mới kèm file Excel (${formatEmailTimestamp(now)})`;
  const html = buildDailyReport({ stats: sampleStats, units: sampleUnits, generatedAt: now });

  const excelBuffer = await buildExcelReport(sampleUnits);
  const attachments = [
    {
      filename: `Bao_cao_ro_hang_${dateStr.replace(/\//g, '-')}.xlsx`,
      content: excelBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  ];

  const info = await transporter.sendMail({
    from: smtpConfig.from,
    to: smtpConfig.to,
    subject,
    html,
    attachments,
  });

  return { sent: true, messageId: info.messageId, to: smtpConfig.to };
}

module.exports = {
  buildDailyReport,
  sendNotificationEmail,
  sendTestEmail,
  getSmtpConfig,
  escapeHtml,
  formatPriceVnd,
};
