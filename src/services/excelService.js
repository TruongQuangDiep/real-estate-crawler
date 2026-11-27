const { extractExtendedFields } = require('./unitFields');
const { addMovementSheets } = require('./inventoryReport');
const {folderUrl: canonicalFolderUrl} = require('./driveLinks');
const {reportPrices}=require('./reportPrices');
const ExcelJS = require('exceljs');

/**
 * Tạo file báo cáo Excel trực tiếp trong buffer bộ nhớ (không cần ghi file tạm ra đĩa).
 * 40 cột: 18 cột gốc, 8 cột media và 14 cột theo yêu cầu báo cáo.
 * 
 * @param {Array<Object>} units - Danh sách các bản ghi căn hộ mới
 * @param {Object} options - Tùy chọn tiêu đề worksheet ('Danh sách căn mới' hoặc 'Báo cáo tuần')
 * @returns {Promise<Buffer>}
 */
async function buildExcelReport(units = [], options = {}) {
  const sheetTitle = options.sheetTitle || 'Danh sách căn mới';
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Real Estate Crawler Bot V2';
  workbook.lastModifiedBy = 'Real Estate Crawler Bot V2';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetTitle, {
    properties: { tabColor: { argb: 'FF1E3A8A' } },
  });

  // Định nghĩa đầy đủ các cột chuẩn V3 (18 cột truyền thống + 8 cột Google Drive & Media)
  sheet.columns = [
    // 18 cột truyền thống (Giữ nguyên thứ tự và cấu trúc)
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

    // 8 cột nâng cấp Google Drive & Media V3 (Cột 19 -> 26)
    { header: 'Hình ảnh riêng của căn — Google Drive', key: 'drive_image_urls', width: 42 },
    { header: 'Hình ảnh layout thiết kế — Google Drive', key: 'drive_layout_image_urls', width: 45 },
    { header: 'Mức độ khớp layout', key: 'layout_match_level', width: 24 },
    { header: 'Hình ảnh mặt bằng — Google Drive', key: 'drive_floor_plan_urls', width: 42 },
    { header: 'Hình ảnh phối cảnh dự án — Google Drive', key: 'drive_project_image_urls', width: 42 },
    { header: 'Thư mục Google Drive', key: 'drive_folder_url', width: 42 },
    { header: 'Tài liệu liên quan', key: 'document_urls', width: 38 },
    { header: 'Trạng thái đồng bộ hình ảnh', key: 'image_sync_status', width: 22 },
    { header: 'Trục', key: 'axis', width: 14 },
    { header: 'Mặt tiền (m)', key: 'frontWidth', width: 16 },
    { header: 'Giá vay (VNĐ)', key: 'priceLoan', width: 24 },
    { header: 'Giá TTTĐ (VNĐ)', key: 'priceTttd', width: 24 },
    { header: 'Đơn giá (VNĐ/m²)', key: 'unitPrice', width: 24 },
    { header: 'HiSale - Quỹ căn', key: 'hisaleQuyCan', width: 18 },
    { header: 'HiSale - Quỹ HOT', key: 'hisaleQuyHot', width: 18 },
    { header: 'HiSale - Quỹ CĐT', key: 'hisaleQuyCdt', width: 18 },
    { header: 'VHub - Quỹ độc quyền', key: 'vhubQuyDocQuyen', width: 22 },
    { header: 'VHub - Quỹ chung (QCK)', key: 'vhubQuyChung', width: 22 },
    { header: 'VHub - Quỹ chéo', key: 'vhubQuyCheo', width: 18 },
    { header: 'SalePro - Quỹ Độc quyền + Ẩn', key: 'saleproQuyDocQuyenAn', width: 30 },
    { header: 'SalePro - Quỹ chéo', key: 'saleproQuyCheo', width: 22 },
    { header: 'SalePro - Quỹ thưởng', key: 'saleproQuyThuong', width: 24 },
  ];

  units.forEach((unit, index) => {
    // Định dạng chuỗi nhiều URL xuống dòng trong 1 ô
    const formatUrls = (urls) => {
      if (!urls) return '';
      if (Array.isArray(urls)) {
        return urls.filter(Boolean).join('\n');
      }
      return String(urls).trim();
    };

    const driveUnitImages = formatUrls(unit.drive_image_urls);
    const rawLayoutUrls = formatUrls(unit.drive_layout_image_urls);

    // Ghi rõ nhãn layout tham khảo hoặc chính xác
    let driveLayoutDisplay = '';
    if (rawLayoutUrls) {
      if (unit.layout_match_level === 'TYPE_MATCH') {
        const layoutTag = unit.layout_name ? `[Tham khảo: ${unit.layout_name}]` : '[Layout tham khảo]';
        driveLayoutDisplay = `${layoutTag}\n${rawLayoutUrls}`;
      } else if (unit.layout_match_level === 'EXACT') {
        const layoutTag = unit.layout_name ? `[Chính xác: ${unit.layout_name}]` : '[Layout chính xác]';
        driveLayoutDisplay = `${layoutTag}\n${rawLayoutUrls}`;
      } else {
        driveLayoutDisplay = rawLayoutUrls;
      }
    }

    // Hiển thị mức độ khớp layout
    let layoutMatchText = 'N/A';
    if (unit.layout_match_level === 'EXACT') {
      layoutMatchText = 'EXACT (Chính xác)';
    } else if (unit.layout_match_level === 'TYPE_MATCH') {
      layoutMatchText = 'TYPE_MATCH (Tham khảo)';
    } else if (unit.layout_match_level === 'UNMATCHED') {
      layoutMatchText = 'UNMATCHED (Chưa khớp)';
    }

    const driveFloorPlans = formatUrls(unit.drive_floor_plan_urls);
    const driveProjectImages = formatUrls(unit.drive_project_image_urls);
    const documents = formatUrls(unit.document_urls);

    // Hyperlink cho thư mục Google Drive (nếu có)
    let folderCellVal = '';
    const folderUrl = canonicalFolderUrl(unit) || unit.drive_project_folder_url;
    if (folderUrl && String(folderUrl).trim()) {
      const url = String(folderUrl).trim();
      folderCellVal = {
        text: url,
        hyperlink: url,
        tooltip: 'Mở thư mục trên Google Drive',
      };
    }

    const row = sheet.addRow({
      ...reportPrices(unit),
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
      price: reportPrices(unit).price,
      price_tts: reportPrices(unit).priceTts,
      status: unit.status || 'Còn hàng',
      delivery_standard: unit.delivery_standard || '',
      bank_support: unit.bank_support || '',
      price_list_url: unit.price_list_url || '',
      created_at: unit.created_at ? new Date(new Date(unit.created_at).getTime() + 7 * 3600000) : null,

      // V3 fields
      drive_image_urls: driveUnitImages,
      drive_layout_image_urls: driveLayoutDisplay,
      layout_match_level: layoutMatchText,
      drive_floor_plan_urls: driveFloorPlans,
      drive_project_image_urls: driveProjectImages,
      drive_folder_url: folderCellVal,
      document_urls: documents,
      image_sync_status: unit.image_sync_status || (driveUnitImages ? 'SUCCESS' : 'NO_IMAGE'),
    });

    // Cấu hình wrapText cho các cột URL nhiều dòng
    row.getCell('drive_image_urls').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('drive_layout_image_urls').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('layout_match_level').alignment = { horizontal: 'center', vertical: 'top' };
    row.getCell('drive_floor_plan_urls').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('drive_project_image_urls').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('drive_folder_url').alignment = { wrapText: false, vertical: 'top' };
    row.getCell('document_urls').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('image_sync_status').alignment = { horizontal: 'center', vertical: 'top' };
  });

  // Định dạng Header: nền xanh đậm Navy, chữ trắng in đậm
  const headerRow = sheet.getRow(1);
  headerRow.height = 34;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
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
  sheet.getColumn('index').alignment = { horizontal: 'center', vertical: 'top' };
  sheet.getColumn('source').alignment = { horizontal: 'center', vertical: 'top' };
  sheet.getColumn('floor').alignment = { horizontal: 'center', vertical: 'top' };
  sheet.getColumn('unit_code').alignment = { horizontal: 'center', vertical: 'top' };
  sheet.getColumn('direction').alignment = { horizontal: 'center', vertical: 'top' };
  sheet.getColumn('status').alignment = { horizontal: 'center', vertical: 'top' };

  // Include every data row and every column in the filter range.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
  for (const key of ['priceLoan', 'priceTttd', 'unitPrice']) sheet.getColumn(key).numFmt = '#,##0';
  sheet.eachRow((row, n) => { if (n > 1 && typeof row.getCell('unitPrice').value === 'number' && row.getCell('unitPrice').value < 1) row.getCell('unitPrice').numFmt = '0.00000000'; });
  if (options.movements) {
    await addMovementSheets(workbook, units, options.movements);
    await require('./pricingDocuments').addDocumentSheet(workbook, units);
  }

  require('./excelLinks').urlsAsText(workbook);
  return workbook.xlsx.writeBuffer();
}

module.exports = { buildExcelReport };
