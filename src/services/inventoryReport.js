const Unit = require('../models/Unit');

function buildProjectInventory(catalog, units) {
  const rows = catalog.map(p => ({ source: p.source, project_id: p.project_id, project_name: p.project_name,
    count: 0, in_catalog: true, data_status: 'Chưa có căn trong CSDL; chưa kết luận hết hàng' }));
  const byId = new Map(rows.map(p => [`${p.source}|${p.project_id}`, p]));
  const byName = new Map(rows.map(p => [`${p.source}|${p.project_name}`, p]));
  for (const u of units) {
    let row = byId.get(`${u.source}|${u.project_id}`) || byName.get(`${u.source}|${u.project_name}`);
    if (!row) {
      row = { source: u.source, project_id: u.project_id, project_name: u.project_name, count: 0,
        in_catalog: false, data_status: 'Có căn; ID/tên chưa khớp danh mục dự án' };
      rows.push(row); byId.set(`${u.source}|${u.project_id}`, row); byName.set(`${u.source}|${u.project_name}`, row);
    }
    if (u.listing_state !== 'missing') row.count++;
    if (row.in_catalog && row.count > 0) row.data_status = 'Có dữ liệu căn trong CSDL';
  }
  return rows.sort((a, b) => a.source.localeCompare(b.source) || b.count - a.count || a.project_name.localeCompare(b.project_name));
}
function movementRows(units, start, end) {
  const result = [];
  for (const u of units) for (const event of u.change_history || []) {
    const at = new Date(event.at);
    if (at < start || at >= end || event.kind === 'BASELINE') continue;
    const delta = event.changes || {};
    const sold = delta.status && /đã bán|^sold$/i.test(delta.status.after);
    const price = Object.keys(delta).some(k => !['status', 'listing_state'].includes(k));
    result.push({ source: u.source, project_name: u.project_name, unit_code: u.unit_code, at,
      kind: event.kind === 'NEW' ? 'Căn mới ghi nhận' : delta.listing_state ? (delta.listing_state.after === 'missing' ? 'Không còn trong rổ đã quét' : 'Xuất hiện lại') : sold ? 'Chuyển sang đã bán' : price ? 'Đổi giá' : 'Đổi trạng thái',
      old_price: delta.price?.before ?? '', new_price: delta.price?.after ?? '',
      old_status: delta.status?.before ?? '', new_status: delta.status?.after ?? '',
      detail: JSON.stringify(delta), price_changed: price, sold: Boolean(sold), is_new: event.kind === 'NEW',
      removed: delta.listing_state?.after === 'missing', relisted: delta.listing_state?.after === 'active' });
  }
  return result.sort((a, b) => b.at - a.at);
}
function summarize(rows) {
  const unique = predicate => new Set(rows.filter(predicate).map(r => `${r.source}|${r.project_name}|${r.unit_code}`)).size;
  return { newUnits: unique(r => r.is_new), priceChanged: unique(r => r.price_changed), sold: unique(r => r.sold),
    statusChanged: unique(r => r.old_status !== ''), removed: unique(r => r.removed), relisted: unique(r => r.relisted), events: rows.length };
}
async function getMovements(start, end = new Date()) {
  const units = await Unit.find({ 'change_history.at': { $gte: start, $lt: end } })
    .select('source project_name unit_code change_history').lean();
  const rows = movementRows(units, start, end);
  const baseline = await Unit.findOne({ tracking_started_at: { $ne: null } }).sort({ tracking_started_at: 1 }).select('tracking_started_at').lean();
  return { rows, summary: summarize(rows), start, end, trackingStartedAt: baseline?.tracking_started_at || null };
}
function movementNotice(m) {
  const since = m.trackingStartedAt ? new Date(m.trackingStartedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'chưa khởi tạo';
  return `Lịch sử bắt đầu: ${since}. Chỉ phản ánh lần quét thành công đã quan sát; 0 sự kiện không khẳng định 0 thay đổi trên sàn. Rời rổ chỉ ghi nhận khi quét đủ phạm vi, không coi là đã bán. API chỉ trả căn chưa bán thì không xác định được số bán thực tế. Không có lịch sử trước thời điểm bắt đầu.`;
}
async function addMovementSheets(workbook, units = [], supplied) {
  const end = supplied?.end || new Date(), start = supplied?.start || new Date(end.getTime() - 7 * 86400000);
  const data = supplied || { rows: movementRows(units, start, end), start, end,
    trackingStartedAt: units.map(u => u.tracking_started_at).filter(Boolean).sort((a,b) => new Date(a)-new Date(b))[0] };
  const rows = data.rows, summary = summarize(rows);
  const ws = workbook.addWorksheet('Bien_dong_quy_can');
  ws.columns = [
    ['Thời điểm (giờ Việt Nam)', 'at', 25], ['Nguồn', 'source', 14], ['Dự án', 'project_name', 40], ['Mã căn', 'unit_code', 24],
    ['Biến động', 'kind', 25], ['Giá cũ (VNĐ)', 'old_price', 24], ['Giá mới (VNĐ)', 'new_price', 24],
    ['Trạng thái cũ', 'old_status', 20], ['Trạng thái mới', 'new_status', 20], ['Chi tiết thay đổi', 'detail', 65],
  ].map(([header,key,width]) => ({header,key,width}));
  for (const row of rows) ws.addRow({ ...row, at: new Date(new Date(row.at).getTime() + 7 * 3600000) });
  ws.getColumn('at').numFmt = 'dd/mm/yyyy hh:mm:ss';
  ws.getColumn('old_price').numFmt = ws.getColumn('new_price').numFmt = '#,##0';
  ws.autoFilter = `A1:J${Math.max(1, ws.rowCount)}`;
  ws.views = [{state:'frozen',ySplit:1}];
  const notes = workbook.addWorksheet('Huong_dan_du_lieu');
  notes.columns = [{width:34},{width:110}];
  notes.addRow(['Nội dung', 'Giải thích']);
  notes.addRow(['Khoảng báo cáo biến động', `${new Date(start).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})} đến ${new Date(end).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})} (không gồm mốc cuối)`]);
  notes.addRow(['Căn mới / đổi giá / đã bán', `${summary.newUnits} / ${summary.priceChanged} / ${summary.sold} căn quan sát được. Rời rổ đã quét: ${summary.removed}; xuất hiện lại: ${summary.relisted}.`]);
  notes.addRow(['Phạm vi lịch sử', movementNotice(data)]);
  notes.addRow(['Ô trống và dấu -', 'Ô trống: không áp dụng/không có thuộc tính trong dữ liệu nguồn. Dấu -: thuộc tính có nhưng thiếu giá trị. Quỹ chưa xác định dùng - để tránh tự gán Yes/No.']);
  notes.addRow(['Giá và đơn giá', 'Lấy từ trường dữ liệu nguồn, không suy ra đơn giá bằng tổng giá chia diện tích. HiSale/SalePro cao tầng có mục TTTĐ trên giao diện; chưa có số thì dùng -. Các trường ngoài dữ liệu API có thể cần kiểm tra bổ sung.']);
  notes.addRow(['Danh sách dự án', 'Bao gồm danh mục Project và dự án có căn chưa khớp danh mục. Số căn là số bản ghi đang lưu, không bảo đảm tồn kho thời gian thực. Dự án 0 bản ghi không mặc định là hết hàng. Không gộp dự án giữa các sàn.']);
  notes.addRow(['Trạng thái / phân khúc', 'Đang lock chỉ đếm lock/giữ chỗ; đã cọc/đã bán là trạng thái khác. Phân khúc chưa xác định không tự gán cao tầng.']);
  notes.addRow(['Drive bảng tính giá', 'Xem các link file đã sao lưu và trạng thái tài liệu. Có thư mục Drive không đồng nghĩa đã sao lưu toàn bộ bảng tính. Link nguồn không phải file Excel thì không tự tạo file thay thế.']);
  const anomalies = units.filter(u => u.price > 0 && u.price < 1000000);
  if (anomalies.length) {
    notes.addRow(['Giá nguồn cần xác minh', `${anomalies.length} căn có tổng giá lớn hơn 0 nhưng nhỏ hơn 1 triệu VNĐ. Giữ nguyên giá nguồn; không nhân đổi đơn vị hay suy đoán giá thực tế. Xem sheet Can_xac_minh_gia.`]);
    const quality = workbook.addWorksheet('Can_xac_minh_gia');
    quality.columns = [['Nguồn','source',14],['Dự án','project_name',40],['Mã căn','unit_code',25],['Giá nguồn (VNĐ)','price',24],['Ghi chú','note',85]].map(([header,key,width])=>({header,key,width}));
    for (const u of anomalies) {
      const row = quality.addRow({...u,note:'Tổng giá nguồn nhỏ hơn 1 triệu VNĐ; có thể là giá tạm/thiếu dữ liệu. Cần kiểm tra sàn trước khi sử dụng.'});
      row.height = 32; row.alignment = {wrapText:true,vertical:'middle'};
    }
    quality.getColumn('price').numFmt='#,##0';quality.autoFilter=`A1:E${quality.rowCount}`;quality.views=[{state:'frozen',ySplit:1}];
    quality.getRow(1).font={bold:true};quality.getRow(1).height=30;
  }
  for (const sheet of [ws,notes]) { sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3A8A'}};sheet.getRow(1).height=32; }
  notes.eachRow((row,n)=>{if(n>1){row.alignment={wrapText:true,vertical:'top'};row.height=60;}});
  return data;
}
module.exports = { buildProjectInventory, movementRows, summarize, getMovements, movementNotice, addMovementSheets };
