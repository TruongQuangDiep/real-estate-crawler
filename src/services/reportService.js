const { movementNotice } = require('./inventoryReport');
/**
 * Service xây dựng nội dung email báo cáo định kỳ (HTML template)
 * Tối ưu hiển thị responsive, giao diện chuẩn doanh nghiệp (Executive / SaaS style).
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

function formatPriceVnd(price) {
  const num = Number(price);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)} tỷ`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(0)} triệu`;
  return `${num.toLocaleString('vi-VN')} đ`;
}

function buildDailyReport({ stats = [], units = [], generatedAt = new Date(), movements }) {
  const maxPreview = Math.max(1, Number(process.env.MAIL_MAX_PREVIEW_UNITS) || 15);
  const totalScanned = stats.reduce((sum, s) => sum + (s.totalScanned || 0), 0);
  const totalNewInRun = stats.reduce((sum, s) => sum + (s.newUnitsCount || 0), 0);
  const pendingUnitsCount = units.length;

  // Phân loại chính xác 3 cấp độ trạng thái hệ thống:
  const allFailed = stats.length > 0 && stats.every((s) => s.status === 'FAILED');
  const hasPartialOrError = stats.some((s) => s.status === 'FAILED' || s.status === 'PARTIAL');

  let systemStatusText = '✅ HOÀN TẤT';
  let systemStatusColor = '#15803d';
  let systemStatusBg = '#f0fdf4';
  let systemStatusBorder = '#bbf7d0';
  let systemStatusSub = 'đồng bộ trọn vẹn';

  if (allFailed) {
    systemStatusText = '❌ ĐỒNG BỘ THẤT BẠI';
    systemStatusColor = '#b91c1c';
    systemStatusBg = '#fef2f2';
    systemStatusBorder = '#fecaca';
    systemStatusSub = 'cần kiểm tra kết nối';
  } else if (hasPartialOrError) {
    systemStatusText = '⚠️ DỮ LIỆU CHƯA ĐẦY ĐỦ';
    systemStatusColor = '#b45309';
    systemStatusBg = '#fffbeb';
    systemStatusBorder = '#fde68a';
    systemStatusSub = 'có một số dự án lỗi';
  }

  const dateStr = generatedAt.toLocaleDateString('vi-VN', {
    timeZone: process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh',
  });
  const timeStr = generatedAt.toLocaleTimeString('vi-VN', {
    timeZone: process.env.CRON_TIMEZONE || 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // 1. Thống kê theo từng nguồn (HiSale, SalePro thấp tầng, SalePro cao tầng)
  const sourceRows = stats
    .map((s) => {
      const isSuccess = s.status === 'SUCCESS';
      const statusColor = isSuccess ? '#15803d' : s.status === 'PARTIAL' ? '#b45309' : '#b91c1c';
      const statusBg = isSuccess ? '#dcfce7' : s.status === 'PARTIAL' ? '#fef3c7' : '#fee2e2';
      const statusText = isSuccess ? 'Thành công' : s.status === 'PARTIAL' ? 'Một phần (Có lỗi nhỏ)' : 'Thất bại';

      return `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 14px; font-weight: 600; color: #1e293b;">${escapeHtml(s.source)}</td>
          <td style="padding: 10px 14px; text-align: center; color: #475569;">${(s.totalScanned || 0).toLocaleString('vi-VN')}</td>
          <td style="padding: 10px 14px; text-align: center; font-weight: bold; color: ${s.newUnitsCount > 0 ? '#dc2626' : '#64748b'};">
            ${s.newUnitsCount > 0 ? `+${(s.newUnitsCount || 0).toLocaleString('vi-VN')}` : '0'}
          </td>
          <td style="padding: 10px 14px; text-align: center;">
            <span style="background-color: ${statusBg}; color: ${statusColor}; padding: 3px 10px; border-radius: 9999px; font-size: 11px; font-weight: 600;">
              ${statusText}
            </span>
          </td>
        </tr>
      `;
    })
    .join('');

  // 2. Bảng xem trước top các căn mới tiêu biểu
  const previewUnits = units.slice(0, maxPreview);
  const unitRows = previewUnits
    .map((u, index) => {
      const srcLower = (u.source || '').toLowerCase();
      const sourceBg = srcLower === 'hisale' ? '#e0f2fe' : srcLower === 'vhub' ? '#dcfce7' : '#ffedd5';
      const sourceColor = srcLower === 'hisale' ? '#0369a1' : srcLower === 'vhub' ? '#15803d' : '#c2410c';

      const locationParts = [];
      if (u.subdivision) locationParts.push(u.subdivision);
      if (u.building) locationParts.push(u.building.startsWith('Tòa') ? u.building : `Tòa ${u.building}`);
      if (u.floor) locationParts.push(u.floor.startsWith('Tầng') ? u.floor : `Tầng ${u.floor}`);
      const locationText = locationParts.join(' · ') || '-';

      const areaText = u.area_land ? `${u.area_land} m²` : u.area_build ? `${u.area_build} m²` : '-';
      const priceText = u.price_text || formatPriceVnd(u.price) || '-';
      const detailHref = u.price_list_url && /^https?:\/\//i.test(u.price_list_url) ? u.price_list_url.trim() : '';

      return `
        <tr style="border-bottom: 1px solid #f1f5f9; background-color: ${index % 2 === 0 ? '#ffffff' : '#f8fafc'};">
          <td style="padding: 10px 8px; text-align: center; color: #64748b; font-size: 11px;">${index + 1}</td>
          <td style="padding: 10px 8px; text-align: center;">
            <span style="background-color: ${sourceBg}; color: ${sourceColor}; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase;">
              ${escapeHtml(u.source)}
            </span>
          </td>
          <td style="padding: 10px 10px; font-weight: 700; color: #1e3a8a; font-family: Consolas, monospace; font-size: 12px;">
            ${escapeHtml(u.unit_code)}
          </td>
          <td style="padding: 10px 10px; color: #1e293b; font-weight: 500;">
            ${escapeHtml(u.project_name)}
            <div style="font-size: 11px; color: #64748b; margin-top: 2px;">${escapeHtml(locationText)}</div>
          </td>
          <td style="padding: 10px 8px; text-align: center; color: #334155; font-size: 12px;">${escapeHtml(u.unit_type || '-')}</td>
          <td style="padding: 10px 8px; text-align: right; color: #334155; font-size: 12px; white-space: nowrap;">${escapeHtml(areaText)}</td>
          <td style="padding: 10px 10px; text-align: right; font-weight: 700; color: #dc2626; font-size: 12px; white-space: nowrap;">
            ${escapeHtml(priceText)}
            ${u.price_tts ? `<div style="font-size: 10px; color: #047857; font-weight: normal;">TTS: ${formatPriceVnd(u.price_tts)}</div>` : ''}
          </td>
          <td style="padding: 10px 8px; text-align: center;">
            ${
              detailHref
                ? `<a href="${escapeHtml(detailHref)}" target="_blank" style="display: inline-block; background-color: #eff6ff; color: #2563eb; padding: 3px 8px; border-radius: 4px; text-decoration: none; font-size: 11px; font-weight: 600;">Xem →</a>`
                : '-'
            }
          </td>
        </tr>
      `;
    })
    .join('');

  // 3. Khối nội dung danh sách căn mới
  let detailContentHtml = '';
  if (units.length > 0) {
    const previewNotice =
      units.length > maxPreview
        ? `<div style="background-color: #f1f5f9; border-left: 4px solid #3b82f6; padding: 10px 14px; margin-bottom: 12px; font-size: 12px; color: #334155;">
             Đang hiển thị xem trước <strong>${previewUnits.length} / ${units.length}</strong> căn mới nhất. Toàn bộ thông tin chi tiết đầy đủ của ${units.length} căn được đính kèm trong <strong>file Excel (.xlsx)</strong> bên dưới email.
           </div>`
        : '';

    detailContentHtml = `
      ${previewNotice}
      <div style="overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 8px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
          <thead>
            <tr style="background-color: #f8fafc; color: #475569; font-size: 11px; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">
              <th style="padding: 10px 8px; text-align: center;">STT</th>
              <th style="padding: 10px 8px; text-align: center;">Nguồn</th>
              <th style="padding: 10px 10px;">Mã Căn</th>
              <th style="padding: 10px 10px;">Dự Án & Vị Trí</th>
              <th style="padding: 10px 8px; text-align: center;">Loại</th>
              <th style="padding: 10px 8px; text-align: right;">DT</th>
              <th style="padding: 10px 10px; text-align: right;">Giá Bán</th>
              <th style="padding: 10px 8px; text-align: center;">Quỹ Căn</th>
            </tr>
          </thead>
          <tbody>
            ${unitRows}
          </tbody>
        </table>
      </div>
    `;
  } else {
    detailContentHtml = `
      <div style="background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 24px; text-align: center; color: #64748b;">
        <div style="font-size: 28px; margin-bottom: 8px;">✅</div>
        <div style="font-size: 14px; font-weight: 600; color: #334155;">Không phát sinh căn hộ mới trong phiên này</div>
        <div style="font-size: 12px; margin-top: 4px;">Toàn bộ rổ hàng của cả 2 sàn đang ở trạng thái đồng bộ với cơ sở dữ liệu nội bộ.</div>
      </div>
    `;
  }

  // 4. Khối đính kèm file Excel
  const excelAttachmentBox =
    units.length > 0
      ? `
    <div style="margin-top: 20px; background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px 18px; display: flex; align-items: center;">
      <div style="font-size: 26px; margin-right: 14px;">📊</div>
      <div>
        <div style="font-weight: 700; color: #166534; font-size: 13px;">Báo cáo chi tiết: Bao_cao_ro_hang_${dateStr.replace(/\//g, '-')}.xlsx</div>
        <div style="font-size: 12px; color: #15803d; margin-top: 2px;">
          Chứa đầy đủ <strong>${units.length}</strong> căn mới với 37 cột dữ liệu (diện tích, giá TTS, tiêu chuẩn bàn giao, link trực tiếp...). Vui lòng tải file đính kèm để xem chi tiết.
        </div>
      </div>
    </div>
  `
      : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Báo cáo rổ hàng Bất động sản</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.5;">
  <div style="max-width: 820px; margin: 24px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);">
    
    <!-- HEADER -->
    <div style="background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%); color: #ffffff; padding: 24px 28px;">
      <div style="font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #93c5fd; margin-bottom: 6px;">
        REAL ESTATE INVENTORY MONITOR
      </div>
      <h1 style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px;">
        📢 BÁO CÁO ĐỒNG BỘ RỔ HÀNG BẤT ĐỘNG SẢN
      </h1>
      <div style="margin-top: 8px; font-size: 12px; color: #dbeafe;">
        Thời gian đối chiếu: <strong>${escapeHtml(timeStr)} - ${escapeHtml(dateStr)}</strong>
      </div>
    </div>

    <!-- BODY CONTAINER -->
    ${movements ? `<div style="padding:16px 28px"><strong>Bi?n ??ng quan s?t ???c:</strong> ${movements.summary.newUnits} c?n m?i, ${movements.summary.priceChanged} c?n ??i gi?, ${movements.summary.sold} c?n chuy?n ?? b?n, ${movements.summary.statusChanged} c?n ??i tr?ng th?i; ${movements.summary.removed || 0} rời rổ, ${movements.summary.relisted || 0} xuất hiện lại.<p>${escapeHtml(movementNotice(movements))}</p></div>` : ''}
    <div style="padding: 24px 28px;">
      
      <!-- KPI STAT CARDS -->
      <table style="width: 100%; border-collapse: separate; border-spacing: 10px 0; margin-bottom: 24px;">
        <tr>
          <td style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; text-align: center; width: 33%;">
            <div style="font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase;">Đã Quét Phiên Này</div>
            <div style="font-size: 22px; font-weight: 800; color: #1e293b; margin-top: 4px;">${totalScanned.toLocaleString('vi-VN')}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">căn trên sàn</div>
          </td>
          <td style="background-color: ${pendingUnitsCount > 0 ? '#fef2f2' : '#f8fafc'}; border: 1px solid ${pendingUnitsCount > 0 ? '#fecaca' : '#e2e8f0'}; border-radius: 8px; padding: 14px; text-align: center; width: 33%;">
            <div style="font-size: 11px; font-weight: 600; color: ${pendingUnitsCount > 0 ? '#b91c1c' : '#64748b'}; text-transform: uppercase;">Căn Cần Thông Báo</div>
            <div style="font-size: 22px; font-weight: 800; color: ${pendingUnitsCount > 0 ? '#dc2626' : '#1e293b'}; margin-top: 4px;">${pendingUnitsCount.toLocaleString('vi-VN')}</div>
            <div style="font-size: 11px; color: ${pendingUnitsCount > 0 ? '#ef4444' : '#94a3b8'}; margin-top: 2px;">căn mới & tồn đọng</div>
          </td>
          <td style="background-color: ${systemStatusBg}; border: 1px solid ${systemStatusBorder}; border-radius: 8px; padding: 14px; text-align: center; width: 33%;">
            <div style="font-size: 11px; font-weight: 600; color: ${systemStatusColor}; text-transform: uppercase;">Trạng Thái Hệ Thống</div>
            <div style="font-size: 15px; font-weight: 800; color: ${systemStatusColor}; margin-top: 6px;">
              ${systemStatusText}
            </div>
            <div style="font-size: 11px; color: ${systemStatusColor}; margin-top: 2px;">${systemStatusSub}</div>
          </td>
        </tr>
      </table>

      <!-- 1. KẾT QUẢ THEO NGUỒN -->
      <h2 style="font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.5px;">
        1. Kết quả quét theo nguồn dữ liệu
      </h2>
      <div style="overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
          <thead>
            <tr style="background-color: #f8fafc; color: #475569; font-size: 11px; text-transform: uppercase; border-bottom: 2px solid #e2e8f0;">
              <th style="padding: 10px 14px;">Nguồn Dữ Liệu</th>
              <th style="padding: 10px 14px; text-align: center;">Số Căn Đã Quét</th>
              <th style="padding: 10px 14px; text-align: center;">Căn Mới</th>
              <th style="padding: 10px 14px; text-align: center;">Trạng Thái</th>
            </tr>
          </thead>
          <tbody>
            ${sourceRows}
          </tbody>
        </table>
      </div>

      <!-- 2. CHI TIẾT CĂN MỚI -->
      <h2 style="font-size: 14px; font-weight: 700; color: #1e3a8a; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.5px;">
        2. Chi tiết căn mới vừa bổ sung vào giỏ hàng
      </h2>
      ${detailContentHtml}

      <!-- EXCEL ATTACHMENT CALLOUT -->
      ${excelAttachmentBox}

    </div>

    <!-- FOOTER -->
    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 28px; text-align: center; font-size: 11px; color: #64748b;">
      <div>Email được tạo và gửi tự động bởi <strong>Real Estate Inventory Crawler Service</strong>.</div>
      <div style="margin-top: 4px; color: #94a3b8;">Hệ thống lưu trữ nội bộ trên máy chủ VPS · Không chia sẻ qua database online bên thứ ba.</div>
    </div>

  </div>
</body>
</html>
  `;
}

module.exports = {
  buildDailyReport,
  escapeHtml,
  formatPriceVnd,
};
