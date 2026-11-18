const nodemailer = require('nodemailer');
const Unit = require('./models/Unit');

const EMAIL_UNIT_LIMIT = 200;

/**
 * Escape HTML special characters before interpolating scraped text into email markup.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

function formatPriceVnd(price) {
  const num = Number(price);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)} tỷ`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(0)} triệu`;
  return `${num.toLocaleString('vi-VN')} đ`;
}

/**
 * Format timestamp string for email subjects and bodies to avoid Gmail thread trimming.
 */
function formatEmailTimestamp(date = new Date(), includeSeconds = true) {
  const timeOpts = includeSeconds
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: false };
  const timeStr = date.toLocaleTimeString('vi-VN', timeOpts);
  const dateStr = date.toLocaleDateString('vi-VN');
  return `${timeStr} ${dateStr}`;
}

/**
 * Format subdivision + tower/floor display for both low-rise and high-rise units.
 */
function formatLocationHtml(unit) {
  const sub = unit.subdivision ? String(unit.subdivision).trim() : '';
  const rawBuilding = unit.building ? String(unit.building).trim() : '';
  const rawFloor = unit.floor ? String(unit.floor).trim() : '';

  const buildingLabel = rawBuilding
    ? /^t[oò]a\b/i.test(rawBuilding)
      ? rawBuilding
      : `Tòa ${rawBuilding}`
    : '';
  const floorLabel = rawFloor
    ? /^t[aầ]ng\b/i.test(rawFloor)
      ? rawFloor
      : `Tầng ${rawFloor}`
    : '';

  const towerFloor = [buildingLabel, floorLabel].filter(Boolean).join(' · ');

  if (sub && towerFloor) {
    return `${escapeHtml(sub)}<br><span style="color: #475569; font-size: 11px;">${escapeHtml(towerFloor)}</span>`;
  }
  if (sub) return escapeHtml(sub);
  if (towerFloor) return escapeHtml(towerFloor);
  return '-';
}

/**
 * Format unit type and delivery standard cleanly without hiding either field.
 */
function formatUnitTypeHtml(unit) {
  const type = unit.unit_type ? String(unit.unit_type).trim() : '';
  const standard = unit.delivery_standard ? String(unit.delivery_standard).trim() : '';

  if (type && standard && type.toLowerCase() !== standard.toLowerCase()) {
    return `${escapeHtml(type)}<br><span style="color: #64748b; font-size: 11px;">${escapeHtml(standard)}</span>`;
  }
  return escapeHtml(type || standard) || '-';
}

/**
 * Format land/carpet and built-up area based on whether the unit has tower/floor metadata.
 */
function formatAreaHtml(unit) {
  const areaLand = unit.area_land ? Number(unit.area_land) : null;
  const areaBuild = unit.area_build ? Number(unit.area_build) : null;
  const isHighRise = Boolean(unit.building || unit.floor);

  if (areaLand && areaBuild && areaLand !== areaBuild) {
    const primaryLabel = isHighRise ? `TT: ${areaLand} m²` : `Đất: ${areaLand} m²`;
    const secondaryLabel = isHighRise ? `Tim tường: ${areaBuild} m²` : `XD: ${areaBuild} m²`;
    return `${primaryLabel}<br><span style="color: #64748b; font-size: 11px;">${secondaryLabel}</span>`;
  }

  if (areaLand) return `${areaLand} m²`;
  if (areaBuild) return `${areaBuild} m²`;
  return '-';
}

/**
 * Format primary price and optional early-payment (TTS) price.
 */
function formatPriceHtml(unit) {
  const primaryText =
    (unit.price_text && String(unit.price_text).trim()) || formatPriceVnd(unit.price) || '-';
  const ttsText = unit.price_tts ? formatPriceVnd(unit.price_tts) : '';

  if (ttsText) {
    return `${escapeHtml(primaryText)}<br><span style="color: #0f766e; font-size: 11px; font-weight: normal;">TTS: ${escapeHtml(ttsText)}</span>`;
  }
  return escapeHtml(primaryText);
}

/**
 * Tạo bảng HTML danh sách căn hộ / nhà phố mới phát hiện
 */
function buildHtmlEmail(units, totalPendingCount = units.length, generatedAt = new Date()) {
  const timestamp = formatEmailTimestamp(generatedAt, true);
  const rows = units
    .map((unit, index) => {
      const detailHref = isSafeHttpUrl(unit.price_list_url)
        ? unit.price_list_url.trim()
        : Array.isArray(unit.image_urls) && isSafeHttpUrl(unit.image_urls[0])
          ? unit.image_urls[0].trim()
          : '';
      const detailLabel = isSafeHttpUrl(unit.price_list_url) ? 'Xem bảng giá' : 'Xem ảnh';

      return `
    <tr style="background-color: ${index % 2 === 0 ? '#ffffff' : '#f9fbfd'};">
      <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${index + 1}</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">
        <span style="font-weight: bold; color: ${unit.source === 'hisale' ? '#0284c7' : '#ea580c'}; text-transform: uppercase; font-size: 11px;">
          ${escapeHtml(unit.source)}
        </span>
      </td>
      <td style="padding: 10px; border: 1px solid #e2e8f0; font-weight: bold; color: #1e3a8a;">${escapeHtml(unit.unit_code)}</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">${escapeHtml(unit.project_name)}</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">${formatLocationHtml(unit)}</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0;">${formatUnitTypeHtml(unit)}</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">${escapeHtml(unit.direction) || '-'}</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: right; white-space: nowrap;">${formatAreaHtml(unit)}</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: right; font-weight: bold; color: #dc2626; white-space: nowrap;">${formatPriceHtml(unit)}</td>
      <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">
        <span style="background-color: #dcfce7; color: #15803d; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">
          ${escapeHtml(unit.status) || 'Còn hàng'}
        </span>
      </td>
      <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;">
        ${
          detailHref
            ? `<a href="${escapeHtml(detailHref)}" target="_blank" style="color: #2563eb; text-decoration: underline;">${detailLabel}</a>`
            : '-'
        }
      </td>
    </tr>
  `;
    })
    .join('');

  const introLine =
    totalPendingCount > units.length
      ? `Hệ thống tự động phát hiện <strong>${totalPendingCount}</strong> căn mới vừa được bổ sung vào rổ hàng (hiển thị <strong>${units.length}</strong> căn đầu tiên trong email này):`
      : `Hệ thống tự động phát hiện <strong>${units.length}</strong> căn mới vừa được bổ sung vào rổ hàng:`;

  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 1200px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1e3a8a; border-bottom: 2px solid #2563eb; padding-bottom: 8px;">
        📢 BÁO CÁO CĂN MỚI TRONG RỔ HÀNG
      </h2>
      <p style="margin: 0 0 8px; color: #475569; font-size: 12px;">Phiên cập nhật: <strong>${escapeHtml(timestamp)}</strong></p>
      <p>${introLine}</p>

      <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px;">
        <thead>
          <tr style="background-color: #2563eb; color: #ffffff;">
            <th style="padding: 10px; border: 1px solid #2563eb;">STT</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Nguồn</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Mã Căn</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Dự Án</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Phân Khu / Tòa - Tầng</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Loại Căn / Tiêu Chuẩn</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Hướng</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Diện Tích</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Giá Bán</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Trạng Thái</th>
            <th style="padding: 10px; border: 1px solid #2563eb;">Chi Tiết</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <p style="margin-top: 25px; font-size: 12px; color: #64748b; font-style: italic;">
        Email được tạo tự động bởi Crawler Bot vào lúc ${escapeHtml(timestamp)}.
      </p>
    </div>
  `;
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
 * Kiểm tra các căn chưa thông báo (is_notified = false) và gửi email tổng hợp
 */
async function sendNotificationEmail() {
  const totalPending = await Unit.countDocuments({ is_notified: false });
  if (!totalPending) {
    console.log('[Mailer] Không có căn mới nào cần gửi mail.');
    return { sent: false, count: 0 };
  }

  const newUnits = await Unit.find({ is_notified: false })
    .sort({ source: 1, project_name: 1, unit_code: 1 })
    .limit(EMAIL_UNIT_LIMIT)
    .lean();

  if (!newUnits || newUnits.length === 0) {
    console.log('[Mailer] Không có căn mới nào cần gửi mail.');
    return { sent: false, count: 0 };
  }

  console.log(`[Mailer] Phát hiện ${totalPending} căn mới chưa thông báo (lấy ${newUnits.length} căn cho email).`);

  const smtpConfig = getSmtpConfig();
  if (!smtpConfig.valid) {
    console.warn(
      `[Mailer] ⚠️ Chưa cấu hình SMTP_USER, SMTP_PASS và MAIL_TO thật trong .env! Bỏ qua gửi email thực tế.`
    );
    console.log(
      `[Mailer] Danh sách căn mới phát hiện:`,
      newUnits.slice(0, 20).map((u) => `${u.unit_code} (${u.price_text || formatPriceVnd(u.price)})`)
    );
    return { sent: false, count: totalPending, reason: 'NO_CONFIG' };
  }

  const now = new Date();
  const transporter = createMailTransporter(smtpConfig);
  const subject = `[RỔ HÀNG BĐS] Có ${totalPending} căn mới cập nhật (${formatEmailTimestamp(now, false)})`;
  const html = buildHtmlEmail(newUnits, totalPending, now);

  try {
    const info = await transporter.sendMail({
      from: smtpConfig.from,
      to: smtpConfig.to,
      subject,
      html,
    });

    console.log(`[Mailer] ✅ Gửi email thành công tới ${smtpConfig.to}! MessageId: ${info.messageId}`);

    // Đánh dấu đã gửi mail thành công cho các căn đã đưa vào email
    const unitIds = newUnits.map((u) => u._id);
    await Unit.updateMany({ _id: { $in: unitIds } }, { $set: { is_notified: true } });

    return { sent: true, count: newUnits.length, totalPending };
  } catch (error) {
    console.error(`[Mailer] ❌ Lỗi khi gửi mail:`, error.message);
    throw error;
  }
}

/**
 * Send a one-off sample email to verify SMTP credentials and template rendering without touching MongoDB.
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
      project_name: 'VINHOMES GRAND PARK (MẪU TEST)',
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
      price_list_url: 'https://salepro.com/project-detail/vinhomes-grand-park#quy-can-cao-tang',
    },
    {
      source: 'hisale',
      unit_code: 'BE601.S13',
      project_name: 'VINHOMES GRAND PARK (MẪU TEST)',
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
      price_list_url: 'https://www.hisale.com/du-an/vinhomes-grand-park',
    },
    {
      source: 'hisale',
      unit_code: 'VT-01',
      project_name: 'VINHOMES GLOBAL GATE HẠ LONG (MẪU TEST)',
      subdivision: 'Vịnh Tây',
      unit_type: 'Liền kề',
      delivery_standard: 'Bàn giao thô',
      direction: 'Đông Bắc',
      area_land: 80,
      area_build: 260,
      price: 15200000000,
      price_text: '15.20 tỷ',
      status: 'Còn hàng',
    },
  ];

  const now = new Date();
  const subject = `[TEST - RỔ HÀNG BĐS] Thử nghiệm thông báo căn mới (${formatEmailTimestamp(now, true)})`;
  const html = buildHtmlEmail(sampleUnits, sampleUnits.length, now);

  const info = await transporter.sendMail({
    from: smtpConfig.from,
    to: smtpConfig.to,
    subject,
    html,
  });

  return { sent: true, messageId: info.messageId, to: smtpConfig.to };
}

module.exports = {
  buildHtmlEmail,
  sendNotificationEmail,
  sendTestEmail,
  getSmtpConfig,
  escapeHtml,
  formatLocationHtml,
  formatAreaHtml,
  formatPriceHtml,
};
