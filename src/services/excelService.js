const ExcelJS = require('exceljs');

/**
 * Tạo file báo cáo Excel trực tiếp trong buffer bộ nhớ (không cần ghi file tạm ra đĩa).
 * @param {Array<Object>} units - Danh sách các bản ghi căn hộ mới
 * @returns {Promise<Buffer>}
 */
async function buildExcelReport(units = []) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Real Estate Crawler Bot';
  workbook.lastModifiedBy = 'Real Estate Crawler Bot';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Danh sách căn mới', {
    properties: { tabColor: { argb: 'FF1E3A8A' } },
  });

  sheet.columns = [
    { header: 'STT', key: 'index', width: 8 },
    { header: 'Nguồn', key: 'source', width: 14 },
    { header: 'Dự án', key: 'project_name', width: 36 },
    { header: 'Phân khu', key: 'subdivision', width: 24 },
    { header: 'Tòa', key: 'building', width: 14 },
    { header: 'Tầng', key: 'floor', width: 10 },
    { header: 'Mã căn', key: 'unit_code', width: 18 },
    { header: 'Loại căn', key: 'unit_type', width: 18 },
    { header: 'Hướng', key: 'direction', width: 14 },
    { header: 'DT đất / Thông thủy (m²)', key: 'area_land', width: 24 },
    { header: 'DT XD / Tim tường (m²)', key: 'area_build', width: 24 },
    { header: 'Giá bán niêm yết (VNĐ)', key: 'price', width: 24 },
    { header: 'Giá thanh toán sớm (VNĐ)', key: 'price_tts', width: 24 },
    { header: 'Trạng thái', key: 'status', width: 16 },
    { header: 'Tiêu chuẩn bàn giao', key: 'delivery_standard', width: 24 },
    { header: 'Hỗ trợ ngân hàng', key: 'bank_support', width: 22 },
    { header: 'Link quỹ căn / bảng giá', key: 'price_list_url', width: 45 },
    { header: 'Ngày ghi nhận', key: 'created_at', width: 22 },
  ];

  units.forEach((unit, index) => {
    sheet.addRow({
      index: index + 1,
      source: (unit.source || '').toUpperCase(),
      project_name: unit.project_name || '',
      subdivision: unit.subdivision || '',
      building: unit.building || '',
      floor: unit.floor || '',
      unit_code: unit.unit_code || '',
      unit_type: unit.unit_type || '',
      direction: unit.direction || '',
      area_land: unit.area_land ? Number(unit.area_land) : null,
      area_build: unit.area_build ? Number(unit.area_build) : null,
      price: unit.price ? Number(unit.price) : null,
      price_tts: unit.price_tts ? Number(unit.price_tts) : null,
      status: unit.status || 'Còn hàng',
      delivery_standard: unit.delivery_standard || '',
      bank_support: unit.bank_support || '',
      price_list_url: unit.price_list_url || '',
      created_at: unit.created_at ? new Date(unit.created_at) : new Date(),
    });
  });

  // Định dạng Header: nền xanh đậm Navy, chữ trắng in đậm
  const headerRow = sheet.getRow(1);
  headerRow.height = 32;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E3A8A' },
  };

  // Định dạng số tiền và ngày tháng
  sheet.getColumn('price').numFmt = '#,##0';
  sheet.getColumn('price_tts').numFmt = '#,##0';
  sheet.getColumn('area_land').numFmt = '#,##0.00';
  sheet.getColumn('area_build').numFmt = '#,##0.00';
  sheet.getColumn('created_at').numFmt = 'dd/mm/yyyy hh:mm:ss';

  // Canh lề cột
  sheet.getColumn('index').alignment = { horizontal: 'center' };
  sheet.getColumn('source').alignment = { horizontal: 'center' };
  sheet.getColumn('floor').alignment = { horizontal: 'center' };
  sheet.getColumn('unit_code').alignment = { horizontal: 'center' };
  sheet.getColumn('direction').alignment = { horizontal: 'center' };
  sheet.getColumn('status').alignment = { horizontal: 'center' };

  // Khóa dòng đầu tiên (freeze header) & bật AutoFilter
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'R1' };

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildExcelReport };
