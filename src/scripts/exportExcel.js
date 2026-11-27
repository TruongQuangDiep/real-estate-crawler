require('dotenv').config();
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { connectDB } = require('../db');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const PricingDocument = require('../models/PricingDocument');
const { buildDriveIndex } = require('../services/driveLinks');
const {reportPrices}=require('../services/reportPrices');

const { extractExtendedFields, segment } = require('../services/unitFields');
const { buildProjectInventory, addMovementSheets } = require('../services/inventoryReport');
async function exportAll() {
  await connectDB();
  console.log('📊 Đang tổng hợp số liệu từ MongoDB Local...');

  const allUnits = await Unit.find({}).sort({ source: 1, project_name: 1, unit_code: 1 }).lean();
  const units = allUnits.filter(u => u.listing_state !== 'missing');
  const totalUnits = units.length;
  const count = (source, status) => units.filter(u => u.source === source && (!status || status.test(u.status || ''))).length;
  const hisaleUnits = count('hisale'), saleproUnits = count('salepro'), vhubUnits = count('vhub');
  const hisaleConHang = count('hisale', /^còn hàng$/i), saleproConHang = count('salepro', /^còn hàng$/i), vhubConHang = count('vhub', /^còn hàng$/i);
  const hisaleLock = count('hisale', /lock|giữ chỗ/i), saleproLock = count('salepro', /lock|giữ chỗ/i), vhubLock = count('vhub', /lock|giữ chỗ/i);

  const catalog = await Project.find({}).lean();
  const lookupDrive = buildDriveIndex(catalog, await PricingDocument.find({}).lean());
  const projectInventory = buildProjectInventory(catalog, allUnits);
  const hisaleAllProjects = projectInventory.filter(p => p.source === 'hisale');
  const vhubAllProjects = projectInventory.filter(p => p.source === 'vhub');
  const saleproAllProjects = projectInventory.filter(p => p.source === 'salepro');
  const totalProjects = projectInventory.length;
  const hisaleProjects = hisaleAllProjects.length, saleproProjects = saleproAllProjects.length, vhubProjects = vhubAllProjects.length;
  const countType = (source, type) => units.filter(u => u.source === source && segment(u) === type).length;
  const hisaleThapTang = countType('hisale', 'low_rise'), hisaleCaoTang = countType('hisale', 'high_rise');
  const saleproThapTang = countType('salepro', 'low_rise'), saleproCaoTang = countType('salepro', 'high_rise');
  const vhubThapTang = countType('vhub', 'low_rise'), vhubCaoTang = countType('vhub', 'high_rise');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Real Estate Crawler Executive';
  workbook.created = new Date();

  // ==================================================================
  // SHEET 1: TỔNG HỢP SỐ LIỆU (EXECUTIVE DASHBOARD)
  // ==================================================================
  const summarySheet = workbook.addWorksheet('Tong_hop_so_lieu', {
    properties: { tabColor: { argb: 'FF10B981' } },
    views: [{ showGridLines: true }]
  });

  summarySheet.columns = [
    { width: 4 },   // A
    { width: 30 },   // B (STT HiSale)
    { width: 34 },  // C (Tên Dự Án HiSale)
    { width: 14 },  // D (Số Lượng Căn HiSale)
    { width: 16 },   // E (Khoảng cách)
    { width: 20 },   // F (STT VHub)
    { width: 34 },  // G (Tên Dự Án VHub)
    { width: 14 },  // H (Số Lượng Căn VHub)
    { width: 20 },   // I (Khoảng cách)
    { width: 6 },   // J (STT SalePro)
    { width: 38 },  // K (Tên Dự Án SalePro)
    { width: 14 },  // L (Số Lượng Căn SalePro)
  ];

  // 1. Tiêu đề chính
  summarySheet.mergeCells('B2:L2');
  const titleCell = summarySheet.getCell('B2');
  titleCell.value = 'BÁO CÁO TỔNG HỢP SỐ LIỆU RỔ HÀNG BẤT ĐỘNG SẢN TOÀN HỆ THỐNG';
  titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF1E3A8A' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  summarySheet.getRow(2).height = 36;

  // 2. Thời gian xuất báo cáo
  summarySheet.mergeCells('B3:L3');
  const subCell = summarySheet.getCell('B3');
  const nowStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  subCell.value = `Nguồn dữ liệu: HiSale, SalePro & VHub 360 | Thời điểm kết xuất: ${nowStr} | Dữ liệu lưu trong CSDL MongoDB Local`;
  subCell.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF4B5563' } };
  subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  summarySheet.getRow(3).height = 28;
  summarySheet.mergeCells('B11:L11');
  summarySheet.getCell('B11').value = `Danh mục: ${catalog.length} dự án; ${projectInventory.filter(p => !p.in_catalog).length} dự án có căn chưa khớp danh mục. Căn chưa phân loại: ${units.filter(u => !segment(u)).length}; trạng thái khác: ${totalUnits-hisaleConHang-saleproConHang-vhubConHang-hisaleLock-saleproLock-vhubLock}.`;
  summarySheet.getCell('B11').alignment = { wrapText: true, vertical: 'middle' };
  summarySheet.getRow(11).height = 30;

  // 3. BẢNG 1: THỐNG KÊ TỔNG QUAN THEO SÀN
  summarySheet.getCell('B5').value = '1. TỔNG QUAN RỔ HÀNG TOÀN HỆ THỐNG';
  summarySheet.getCell('B5').font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF1E3A8A' } };

  const table1Headers = ['Nguồn / Sàn', 'Số lượng dự án', 'Tổng số quỹ căn', 'Tỷ trọng (%)', 'Cao tầng (Chung cư)', 'Thấp tầng (Liền kề/BT)', 'Trạng thái: Còn hàng', 'Trạng thái: Đang lock'];
  const headerRow1 = summarySheet.getRow(6);
  headerRow1.height = 45;
  table1Headers.forEach((h, idx) => {
    const colLetter = String.fromCharCode(66 + idx); // B -> I
    const cell = summarySheet.getCell(`${colLetter}6`);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  });

  const pct = (n) => totalUnits > 0 ? n / totalUnits : 0;
  const table1Data = [
    ['HiSale (hisale.vn)', hisaleProjects, hisaleUnits, pct(hisaleUnits), hisaleCaoTang, hisaleThapTang, hisaleConHang, hisaleLock],
    ['SalePro (salepro.com)', saleproProjects, saleproUnits, pct(saleproUnits), saleproCaoTang, saleproThapTang, saleproConHang, saleproLock],
    ['VHub 360 (vhub.com.vn)', vhubProjects, vhubUnits, pct(vhubUnits), vhubCaoTang, vhubThapTang, vhubConHang, vhubLock],
    [
      'TỔNG CỘNG',
      totalProjects,
      totalUnits,
      1,
      hisaleCaoTang + saleproCaoTang + vhubCaoTang,
      hisaleThapTang + saleproThapTang + vhubThapTang,
      hisaleConHang + saleproConHang + vhubConHang,
      hisaleLock + saleproLock + vhubLock,
    ],
  ];

  table1Data.forEach((rowVals, rIdx) => {
    const rowNum = 7 + rIdx;
    const isTotal = rIdx === table1Data.length - 1;
    summarySheet.getRow(rowNum).height = 24;

    rowVals.forEach((val, cIdx) => {
      const colLetter = String.fromCharCode(66 + cIdx);
      const cell = summarySheet.getCell(`${colLetter}${rowNum}`);
      cell.value = val;
      cell.font = { bold: isTotal, size: 10, color: { argb: isTotal ? 'FF1E3A8A' : 'FF000000' } };
      cell.alignment = { vertical: 'middle', horizontal: cIdx === 0 ? 'left' : 'center' };
      if (cIdx === 3) cell.numFmt = '0.0%';
      if (typeof val === 'number' && cIdx !== 3) {
        cell.numFmt = '#,##0';
      }
      if (isTotal) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      }
      cell.border = { top: { style: isTotal ? 'medium' : 'thin' }, left: { style: 'thin' }, bottom: { style: isTotal ? 'medium' : 'thin' }, right: { style: 'thin' } };
    });
  });

  // 4. BẢNG 2: DANH SÁCH TẤT CẢ DỰ ÁN CỦA TỪNG SÀN (YÊU CẦU CỦA SẾP)
  summarySheet.getCell('B12').value = `2. DANH SÁCH TẤT CẢ DỰ ÁN RỔ HÀNG CỦA TỪNG SÀN (TỔNG CỘNG ${totalProjects} DỰ ÁN)`;
  summarySheet.getCell('B12').font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF1E3A8A' } };

  // Khối 1: HiSale (B13 -> D...)
  summarySheet.mergeCells('B13:D13');
  summarySheet.getCell('B13').value = `Tất Cả Dự Án HiSale (${hisaleAllProjects.length} Dự Án)`;
  summarySheet.getCell('B13').font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getCell('B13').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } };
  summarySheet.getCell('B13').alignment = { horizontal: 'center', vertical: 'middle' };

  summarySheet.getCell('B14').value = 'STT';
  summarySheet.getCell('C14').value = 'Tên Dự Án';
  summarySheet.getCell('D14').value = 'Số Lượng Căn';
  [summarySheet.getCell('B14'), summarySheet.getCell('C14'), summarySheet.getCell('D14')].forEach(c => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });

  hisaleAllProjects.forEach((p, idx) => {
    const r = 15 + idx;
    summarySheet.getRow(r).height = 42;
    for (const col of ['C', 'G', 'K']) summarySheet.getCell(`${col}${r}`).alignment = {wrapText:true,vertical:'middle'};
    summarySheet.getCell(`B${r}`).value = idx + 1;
    summarySheet.getCell(`C${r}`).value = p.project_name;
    summarySheet.getCell(`D${r}`).value = p.count;
    summarySheet.getCell(`D${r}`).numFmt = '#,##0';
    [summarySheet.getCell(`B${r}`), summarySheet.getCell(`C${r}`), summarySheet.getCell(`D${r}`)].forEach(c => {
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
  });

  // Khối 2: VHub 360 (F13 -> H...)
  summarySheet.mergeCells('F13:H13');
  summarySheet.getCell('F13').value = `Tất Cả Dự Án VHub 360 (${vhubAllProjects.length} Dự Án)`;
  summarySheet.getCell('F13').font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getCell('F13').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
  summarySheet.getCell('F13').alignment = { horizontal: 'center', vertical: 'middle' };

  summarySheet.getCell('F14').value = 'STT';
  summarySheet.getCell('G14').value = 'Tên Dự Án';
  summarySheet.getCell('H14').value = 'Số Lượng Căn';
  [summarySheet.getCell('F14'), summarySheet.getCell('G14'), summarySheet.getCell('H14')].forEach(c => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });

  vhubAllProjects.forEach((p, idx) => {
    const r = 15 + idx;
    summarySheet.getRow(r).height = 42;
    for (const col of ['C', 'G', 'K']) summarySheet.getCell(`${col}${r}`).alignment = {wrapText:true,vertical:'middle'};
    summarySheet.getCell(`F${r}`).value = idx + 1;
    summarySheet.getCell(`G${r}`).value = p.project_name;
    summarySheet.getCell(`H${r}`).value = p.count;
    summarySheet.getCell(`H${r}`).numFmt = '#,##0';
    [summarySheet.getCell(`F${r}`), summarySheet.getCell(`G${r}`), summarySheet.getCell(`H${r}`)].forEach(c => {
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
  });

  // Khối 3: SalePro (J13 -> L...)
  summarySheet.mergeCells('J13:L13');
  summarySheet.getCell('J13').value = `Tất Cả Dự Án SalePro (${saleproAllProjects.length} Dự Án)`;
  summarySheet.getCell('J13').font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getCell('J13').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97706' } };
  summarySheet.getCell('J13').alignment = { horizontal: 'center', vertical: 'middle' };

  summarySheet.getCell('J14').value = 'STT';
  summarySheet.getCell('K14').value = 'Tên Dự Án';
  summarySheet.getCell('L14').value = 'Số Lượng Căn';
  [summarySheet.getCell('J14'), summarySheet.getCell('K14'), summarySheet.getCell('L14')].forEach(c => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });

  saleproAllProjects.forEach((p, idx) => {
    const r = 15 + idx;
    summarySheet.getRow(r).height = 42;
    for (const col of ['C', 'G', 'K']) summarySheet.getCell(`${col}${r}`).alignment = {wrapText:true,vertical:'middle'};
    summarySheet.getCell(`J${r}`).value = idx + 1;
    summarySheet.getCell(`K${r}`).value = p.project_name;
    summarySheet.getCell(`L${r}`).value = p.count;
    summarySheet.getCell(`L${r}`).numFmt = '#,##0';
    [summarySheet.getCell(`J${r}`), summarySheet.getCell(`K${r}`), summarySheet.getCell(`L${r}`)].forEach(c => {
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
  });

  // ==================================================================
  // SHEET 2: CHI TIẾT QUỸ CĂN (31 CỘT CHUẨN ĐỦ THEO YÊU CẦU SẾP)
  // ==================================================================
  console.log(`📝 Đang tạo Sheet 2: Chi_tiet_quy_can (${totalUnits} rows)...`);
  const detailSheet = workbook.addWorksheet('Chi_tiet_quy_can', {
    properties: { tabColor: { argb: 'FF1E3A8A' } },
  });

  // 31 cột thông tin rổ hàng hoàn chỉnh
  detailSheet.columns = [
    { header: 'STT', key: 'index', width: 8 },
    { header: 'Nguồn', key: 'source', width: 14 },
    { header: 'Dự án', key: 'project_name', width: 36 },
    { header: 'Phân khu', key: 'subdivision', width: 24 },
    { header: 'Tòa', key: 'building', width: 14 },
    { header: 'Tầng', key: 'floor', width: 10 },
    { header: 'Trục', key: 'axis', width: 14 },
    { header: 'Mã căn', key: 'unit_code', width: 18 },
    { header: 'Loại căn', key: 'unit_type', width: 18 },
    { header: 'Hướng', key: 'direction', width: 14 },
    { header: 'Mặt tiền (m)', key: 'front_width', width: 16 },
    { header: 'DT đất / Thông thủy (m²)', key: 'area_land', width: 24 },
    { header: 'DT XD / Tim tường (m²)', key: 'area_build', width: 24 },
    { header: 'Giá bán niêm yết (VNĐ)', key: 'price', width: 24 },
    { header: 'Giá thanh toán sớm (VNĐ)', key: 'price_tts', width: 24 },
    { header: 'Giá vay (VNĐ)', key: 'price_loan', width: 24 },
    { header: 'Giá TTTĐ (VNĐ)', key: 'price_tttd', width: 24 },
    { header: 'Đơn giá (VNĐ/m²)', key: 'unit_price', width: 24 },
    { header: 'Trạng thái', key: 'status', width: 16 },
    { header: 'HiSale - Quỹ căn', key: 'hisale_quy_can', width: 18 },
    { header: 'HiSale - Quỹ HOT', key: 'hisale_quy_hot', width: 18 },
    { header: 'HiSale - Quỹ CĐT', key: 'hisale_quy_cdt', width: 18 },
    { header: 'VHub - Quỹ độc quyền', key: 'vhub_quy_doc_quyen', width: 22 },
    { header: 'VHub - Quỹ chung (QCK)', key: 'vhub_quy_chung', width: 22 },
    { header: 'VHub - Quỹ chéo', key: 'vhub_quy_cheo', width: 18 },
    { header: 'SalePro - Quỹ Độc quyền + Ẩn', key: 'salepro_quy_doc_quyen_an', width: 30 },
    { header: 'SalePro - Quỹ chéo', key: 'salepro_quy_cheo', width: 22 },
    { header: 'SalePro - Quỹ thưởng', key: 'salepro_quy_thuong', width: 24 },
    { header: 'Tiêu chuẩn bàn giao', key: 'delivery_standard', width: 24 },
    { header: 'Hỗ trợ ngân hàng', key: 'bank_support', width: 22 },
    { header: 'Link bảng giá web nguồn (Sàn ngoài)', key: 'price_list_url', width: 45 },
    { header: 'Thư mục Drive nội bộ (Công ty)', key: 'drive_folder_url', width: 45 },
    { header: 'Ngày ghi nhận', key: 'created_at', width: 22 },
    { header: 'Theo lần quét', key: 'listing_state', width: 30 },
    { header: 'Drive dự án dùng chung', key: 'drive_project_folder', width: 32 },
    { header: 'File nội bộ (nếu có)', key: 'drive_file', width: 32 },
    { header: 'Tình trạng link/file Drive', key: 'drive_status', width: 52 },
    { header: 'Lỗi đồng bộ Drive', key: 'drive_error', width: 65 },
    { header: 'Ghi chú chất lượng giá', key: 'price_quality', width: 65 },
  ];

  units.forEach((unit, index) => {
    const ext = reportPrices(unit);
    const drive = lookupDrive(unit);

    const row = detailSheet.addRow({
      index: index + 1,
      source: (unit.source || '').toUpperCase(),
      project_name: unit.project_name || '',
      subdivision: unit.subdivision || '',
      building: unit.building || '',
      floor: unit.floor || '',
      axis: ext.axis,
      unit_code: unit.unit_code || '',
      unit_type: unit.unit_type || '',
      direction: unit.direction || '',
      front_width: ext.frontWidth,
      area_land: unit.area_land ? Number(unit.area_land) : null,
      area_build: unit.area_build ? Number(unit.area_build) : null,
      price: ext.price,
      price_tts: ext.priceTts,
      price_quality: ext.qualityNote,
      price_loan: ext.priceLoan,
      price_tttd: ext.priceTttd,
      unit_price: ext.unitPrice,
      status: unit.status || 'Còn hàng',
      hisale_quy_can: ext.hisaleQuyCan,
      hisale_quy_hot: ext.hisaleQuyHot,
      hisale_quy_cdt: ext.hisaleQuyCdt,
      vhub_quy_doc_quyen: ext.vhubQuyDocQuyen,
      vhub_quy_chung: ext.vhubQuyChung,
      vhub_quy_cheo: ext.vhubQuyCheo,
      salepro_quy_doc_quyen_an: ext.saleproQuyDocQuyenAn,
      salepro_quy_cheo: ext.saleproQuyCheo,
      salepro_quy_thuong: ext.saleproQuyThuong,
      delivery_standard: unit.delivery_standard || '',
      bank_support: unit.bank_support || '',
      price_list_url: unit.price_list_url || '',
      drive_folder_url: drive.folder ? {text:'Mở thư mục căn',hyperlink:drive.folder} : '',
      drive_project_folder: drive.projectFolder ? {text:'Mở thư mục dự án',hyperlink:drive.projectFolder} : '',
      drive_file: drive.files.length ? {text:'Mở file nội bộ',hyperlink:drive.files[0]} : '',
      drive_status: drive.status,
      drive_error: drive.error,
      listing_state: unit.listing_state === 'missing' ? 'Không còn trong rổ đã quét' : 'Có trong CSDL',
      created_at: unit.created_at ? new Date(new Date(unit.created_at).getTime() + 7 * 3600000) : null,
    });
    row.height=30;
    if (typeof ext.unitPrice === 'number' && ext.unitPrice < 1) row.getCell('unit_price').numFmt = '0.00000000';
    for(const key of ['project_name','subdivision','unit_type','drive_status','drive_error','price_quality']) row.getCell(key).alignment={wrapText:true,vertical:'middle'};
  });

  // Header styling for Sheet 2
  const headerRow2 = detailSheet.getRow(1);
  headerRow2.height = 30;
  headerRow2.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow2.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  headerRow2.height = 42;

  // Màu nền cho các nhóm cột
  for (let c = 1; c <= detailSheet.columnCount; c++) {
    const cell = headerRow2.getCell(c);
    if (c >= 20 && c <= 22) {
      // Nhóm Quỹ HiSale
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } };
    } else if (c >= 23 && c <= 25) {
      // Nhóm Quỹ VHub
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
    } else if (c >= 26 && c <= 28) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97706' } };
    } else {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    }
  }

  detailSheet.getColumn('price').numFmt = '#,##0';
  detailSheet.getColumn('price_tts').numFmt = '#,##0';
  detailSheet.getColumn('price_loan').numFmt = '#,##0';
  detailSheet.getColumn('price_tttd').numFmt = '#,##0';
  detailSheet.getColumn('unit_price').numFmt = '#,##0';
  detailSheet.eachRow((row, n) => { if (n > 1 && typeof row.getCell('unit_price').value === 'number' && row.getCell('unit_price').value < 1) row.getCell('unit_price').numFmt = '0.00000000'; });
  detailSheet.getColumn('area_land').numFmt = '#,##0.00';
  detailSheet.getColumn('area_build').numFmt = '#,##0.00';
  detailSheet.getColumn('created_at').numFmt = 'dd/mm/yyyy hh:mm:ss';

  detailSheet.getColumn('index').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('source').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('floor').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('axis').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('unit_code').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('direction').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('front_width').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('status').alignment = { horizontal: 'center', vertical: 'middle' };

  // Căn giữa 9 cột phân loại quỹ hàng
  ['hisale_quy_can', 'hisale_quy_hot', 'hisale_quy_cdt', 'vhub_quy_doc_quyen', 'vhub_quy_chung', 'vhub_quy_cheo', 'salepro_quy_doc_quyen_an', 'salepro_quy_cheo', 'salepro_quy_thuong'].forEach(colKey => {
    detailSheet.getColumn(colKey).alignment = { horizontal: 'center', vertical: 'middle' };
  });

  detailSheet.views = [{ state: 'frozen', ySplit: 1 }];
  detailSheet.autoFilter = { from: 'A1', to: `AM${detailSheet.rowCount}` };

  // ==================================================================
  // SHEET 3: TOÀN BỘ DỰ ÁN HỢP NHẤT (CÓ THỂ LỌC VÀ SORT TIỆN LỢI)
  // ==================================================================
  console.log('📝 Đang tạo Sheet 3: Danh_sach_tat_ca_du_an...');
  const projectSheet = workbook.addWorksheet('Danh_sach_tat_ca_du_an', {
    properties: { tabColor: { argb: 'FF8B5CF6' } },
  });

  projectSheet.columns = [
    { header: 'STT', key: 'index', width: 8 },
    { header: 'Nguồn / Sàn', key: 'source', width: 18 },
    { header: 'Tên Dự Án', key: 'project_name', width: 42 },
    { header: 'Số Lượng Căn', key: 'count', width: 18 },
    { header: 'Tỷ Trọng Trong Sàn (%)', key: 'pct_source', width: 24 },
    { header: 'Tỷ Trọng Toàn Hệ Thống (%)', key: 'pct_total', width: 26 },
    { header: 'ID dự án', key: 'project_id', width: 24 },
    { header: 'Tình trạng dữ liệu', key: 'data_status', width: 65 },
  ];

  const allProjectsConsolidated = [
    ...hisaleAllProjects.map(p => ({ source: 'HISALE', name: p.project_name, project_id: p.project_id, data_status: p.data_status, count: p.count, pct_source: p.count / (hisaleUnits || 1), pct_total: p.count / (totalUnits || 1) })),
    ...saleproAllProjects.map(p => ({ source: 'SALEPRO', name: p.project_name, project_id: p.project_id, data_status: p.data_status, count: p.count, pct_source: p.count / (saleproUnits || 1), pct_total: p.count / (totalUnits || 1) })),
    ...vhubAllProjects.map(p => ({ source: 'VHUB', name: p.project_name, project_id: p.project_id, data_status: p.data_status, count: p.count, pct_source: p.count / (vhubUnits || 1), pct_total: p.count / (totalUnits || 1) })),
  ];

  allProjectsConsolidated.forEach((p, idx) => {
    projectSheet.addRow({
      index: idx + 1,
      source: p.source,
      project_name: p.name,
      count: p.count,
      pct_source: p.pct_source,
      pct_total: p.pct_total,
      project_id: String(p.project_id ?? ''),
      data_status: p.data_status,
    });
  });

  const headerRow3 = projectSheet.getRow(1);
  headerRow3.height = 28;
  headerRow3.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow3.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  headerRow3.height = 40;
  headerRow3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B5CF6' } };

  projectSheet.getColumn('index').alignment = { horizontal: 'center', vertical: 'middle' };
  projectSheet.getColumn('source').alignment = { horizontal: 'center', vertical: 'middle' };
  projectSheet.getColumn('count').alignment = { horizontal: 'right', vertical: 'middle' };
  projectSheet.getColumn('count').numFmt = '#,##0';
  projectSheet.getColumn('pct_source').alignment = { horizontal: 'center', vertical: 'middle' };
  projectSheet.getColumn('pct_total').alignment = { horizontal: 'center', vertical: 'middle' };

  projectSheet.views = [{ state: 'frozen', ySplit: 1 }];
  projectSheet.autoFilter = { from: 'A1', to: `H${projectSheet.rowCount}` };

  // ==================================================================
  // LƯU FILE
  // ==================================================================
  projectSheet.getColumn('pct_source').numFmt = '0.00%';
  projectSheet.getColumn('pct_total').numFmt = '0.00%';
  await addMovementSheets(workbook, allUnits);
  await require('../services/pricingDocuments').addDocumentSheet(workbook, units);
  require('../services/storedFilesReport').addStoredFilesSheet(workbook, units, lookupDrive);
  const logs=await require('../models/CrawlLog').find({}).sort({started_at:-1}).limit(40).lean();
  const seenSources=new Set();
  const notes=workbook.getWorksheet('Huong_dan_du_lieu');
  for(const log of logs) {
    if(seenSources.has(log.source))continue;seenSources.add(log.source);
    const time=log.finished_at?new Date(log.finished_at).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}):'chưa kết thúc';
    const row=notes.addRow([`Lần cào ${log.source}`,`Kết thúc: ${time}; trạng thái: ${log.status}; số dòng quét: ${log.total_scanned || 0}. Thời điểm xuất Excel không phải thời điểm dữ liệu nguồn được cào.`]);
    row.alignment={wrapText:true,vertical:'top'};row.height=45;
  }
  require('../services/excelLinks').urlsAsText(workbook);

  const exportDir = path.resolve(process.env.REPORT_OUTPUT_DIR || path.join(__dirname, '../../reports'));
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const tag=String(process.env.REPORT_FILE_TAG || 'da_kiem_tra').replace(/[^a-zA-Z0-9_-]/g,'') || 'da_kiem_tra';
  const fileName = `Bao_cao_so_lieu_quy_can_${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())}_${tag}.xlsx`;
  const filePath = path.join(exportDir, fileName);

  console.log('💾 Đang ghi file Excel ra đĩa...');
  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (err) {
    if (err.code === 'EBUSY') {
      const fallbackName = `Bao_cao_so_lieu_quy_can_${Date.now()}.xlsx`;
      const fallbackPath = path.join(exportDir, fallbackName);
      console.log(`⚠️ File cũ đang mở trong Excel, tự động lưu sang: ${fallbackName}`);
      await workbook.xlsx.writeFile(fallbackPath);
      console.log(`📁 Đường dẫn: ${fallbackPath}`);
      process.exit(0);
    }
    throw err;
  }

  const stats = fs.statSync(filePath);
  console.log(`\n🎉 XUẤT BÁO CÁO EXCEL CHUYÊN NGHIỆP THÀNH CÔNG!`);
  console.log(`📁 Đường dẫn: ${filePath}`);
  console.log(`📦 Dung lượng: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`✨ Sheet 1: Tong_hop_so_lieu (Dashboard vĩ mô + Danh sách tất cả ${totalProjects} dự án theo sàn)`);
  console.log(`✨ Sheet 2: Chi_tiet_quy_can (${totalUnits.toLocaleString('vi-VN')} căn hộ, ${detailSheet.columnCount} cột)`);
  console.log(`✨ Sheet 3: Danh_sach_tat_ca_du_an (Toàn bộ ${allProjectsConsolidated.length} dự án hợp nhất có thể lọc/sắp xếp)`);

  await require('mongoose').disconnect();
}

if (require.main === module) exportAll().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});

module.exports = { exportAll };
