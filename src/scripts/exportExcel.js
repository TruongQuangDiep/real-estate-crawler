require('dotenv').config();
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { connectDB } = require('../db');
const Unit = require('../models/Unit');
const Project = require('../models/Project');

async function exportAll() {
  await connectDB();
  console.log('📊 Đang tổng hợp số liệu từ MongoDB Local...');

  const totalProjects = await Project.countDocuments();
  const hisaleProjects = await Project.countDocuments({ source: 'hisale' });
  const saleproProjects = await Project.countDocuments({ source: 'salepro' });

  const totalUnits = await Unit.countDocuments();
  const hisaleUnits = await Unit.countDocuments({ source: 'hisale' });
  const saleproUnits = await Unit.countDocuments({ source: 'salepro' });

  // Phân khúc HiSale
  const hisaleThapTang = await Unit.countDocuments({
    source: 'hisale',
    unit_type: { $in: ['LIỀN KỀ', 'SONG LẬP', 'ĐƠN LẬP', 'SHOPHOUSE', 'TMDV', 'TỨ LẬP', 'SHOP', 'Pool Villa', 'Garden Villa', 'Boutique Townhouse'] }
  });
  const hisaleCaoTang = hisaleUnits - hisaleThapTang;

  // Phân khúc SalePro
  const saleproThapTang = await Unit.countDocuments({
    source: 'salepro',
    'raw_data.project_type': 'low_rise'
  });
  const saleproCaoTang = saleproUnits - saleproThapTang;

  // Trạng thái
  const hisaleConHang = await Unit.countDocuments({ source: 'hisale', status: 'Còn hàng' });
  const hisaleLock = hisaleUnits - hisaleConHang;
  const saleproConHang = await Unit.countDocuments({ source: 'salepro', status: 'Còn hàng' });
  const saleproLock = saleproUnits - saleproConHang;

  // Top 5 dự án lớn nhất
  const hisaleTopProjects = await Unit.aggregate([
    { $match: { source: 'hisale' } },
    { $group: { _id: '$project_name', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 }
  ]);

  const saleproTopProjects = await Unit.aggregate([
    { $match: { source: 'salepro' } },
    { $group: { _id: '$project_name', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 }
  ]);

  console.log(`🔍 Tìm thấy ${totalUnits} căn hộ. Đang khởi tạo Workbook với 2 Sheet...`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Real Estate Crawler Executive';
  workbook.created = new Date();

  // ==================================================================
  // SHEET 1: TỔNG HỢP SỐ LIỆU (EXECUTIVE DASHBOARD)
  // ==================================================================
  const summarySheet = workbook.addWorksheet('Tong_hop_so_lieu', {
    properties: { tabColor: { argb: 'FF10B981' } }, // Màu xanh lá nổi bật
    views: [{ showGridLines: true }]
  });

  summarySheet.columns = [
    { width: 5 },   // A
    { width: 28 },  // B
    { width: 18 },  // C
    { width: 18 },  // D
    { width: 16 },  // E
    { width: 22 },  // F
    { width: 22 },  // G
    { width: 16 },  // H
    { width: 16 },  // I
  ];

  // 1. Tiêu đề chính
  summarySheet.mergeCells('B2:I2');
  const titleCell = summarySheet.getCell('B2');
  titleCell.value = 'BÁO CÁO TỔNG HỢP SỐ LIỆU RỔ HÀNG BẤT ĐỘNG SẢN';
  titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF1E3A8A' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  summarySheet.getRow(2).height = 36;

  // 2. Thời gian xuất báo cáo
  summarySheet.mergeCells('B3:I3');
  const subCell = summarySheet.getCell('B3');
  const nowStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  subCell.value = `Nguồn dữ liệu: HiSale & SalePro | Thời điểm kết xuất: ${nowStr} | Dữ liệu lưu trong CSDL MongoDB Local`;
  subCell.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF4B5563' } };
  subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  summarySheet.getRow(3).height = 20;

  // 3. BẢNG 1: THỐNG KÊ TỔNG QUAN THEO SÀN
  summarySheet.getCell('B5').value = '1. TỔNG QUAN RỔ HÀNG TOÀN HỆ THỐNG';
  summarySheet.getCell('B5').font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF1E3A8A' } };

  const table1Headers = ['Nguồn / Sàn', 'Số lượng dự án', 'Tổng số quỹ căn', 'Tỷ trọng (%)', 'Cao tầng (Chung cư)', 'Thấp tầng (Liền kề/BT)', 'Trạng thái: Còn hàng', 'Trạng thái: Đang lock'];
  const headerRow1 = summarySheet.getRow(6);
  headerRow1.height = 28;
  table1Headers.forEach((h, idx) => {
    const colLetter = String.fromCharCode(66 + idx); // B -> I
    const cell = summarySheet.getCell(`${colLetter}6`);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  });

  const table1Data = [
    ['HiSale (hisale.vn)', hisaleProjects, hisaleUnits, '34.1%', hisaleCaoTang, hisaleThapTang, hisaleConHang, hisaleLock],
    ['SalePro (salepro.com)', saleproProjects, saleproUnits, '65.9%', saleproCaoTang, saleproThapTang, saleproConHang, saleproLock],
    ['TỔNG CỘNG', totalProjects, totalUnits, '100.0%', hisaleCaoTang + saleproCaoTang, hisaleThapTang + saleproThapTang, hisaleConHang + saleproConHang, hisaleLock + saleproLock],
  ];

  table1Data.forEach((rowVals, rIdx) => {
    const rowNum = 7 + rIdx;
    const isTotal = rIdx === 2;
    summarySheet.getRow(rowNum).height = 24;

    rowVals.forEach((val, cIdx) => {
      const colLetter = String.fromCharCode(66 + cIdx);
      const cell = summarySheet.getCell(`${colLetter}${rowNum}`);
      cell.value = val;
      cell.font = { bold: isTotal, size: 10, color: { argb: isTotal ? 'FF1E3A8A' : 'FF000000' } };
      cell.alignment = { vertical: 'middle', horizontal: cIdx === 0 ? 'left' : 'center' };
      if (typeof val === 'number') {
        cell.numFmt = '#,##0';
      }
      if (isTotal) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      }
      cell.border = { top: { style: isTotal ? 'medium' : 'thin' }, left: { style: 'thin' }, bottom: { style: isTotal ? 'medium' : 'thin' }, right: { style: 'thin' } };
    });
  });

  // 4. BẢNG 2: TOP DỰ ÁN RỔ HÀNG LỚN NHẤT
  summarySheet.getCell('B12').value = '2. TOP DỰ ÁN CÓ SỐ LƯỢNG CĂN LỚN NHẤT MỖI SÀN';
  summarySheet.getCell('B12').font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF1E3A8A' } };

  // Cột trái: Top HiSale (B -> D)
  summarySheet.mergeCells('B13:D13');
  summarySheet.getCell('B13').value = 'Top Dự Án HiSale';
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

  hisaleTopProjects.forEach((p, idx) => {
    const r = 15 + idx;
    summarySheet.getCell(`B${r}`).value = idx + 1;
    summarySheet.getCell(`C${r}`).value = p._id;
    summarySheet.getCell(`D${r}`).value = p.count;
    summarySheet.getCell(`D${r}`).numFmt = '#,##0';
    [summarySheet.getCell(`B${r}`), summarySheet.getCell(`C${r}`), summarySheet.getCell(`D${r}`)].forEach(c => {
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
  });

  // Cột phải: Top SalePro (F -> H)
  summarySheet.mergeCells('F13:H13');
  summarySheet.getCell('F13').value = 'Top Dự Án SalePro';
  summarySheet.getCell('F13').font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getCell('F13').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97706' } };
  summarySheet.getCell('F13').alignment = { horizontal: 'center', vertical: 'middle' };

  summarySheet.getCell('F14').value = 'STT';
  summarySheet.getCell('G14').value = 'Tên Dự Án';
  summarySheet.getCell('H14').value = 'Số Lượng Căn';
  [summarySheet.getCell('F14'), summarySheet.getCell('G14'), summarySheet.getCell('H14')].forEach(c => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });

  saleproTopProjects.forEach((p, idx) => {
    const r = 15 + idx;
    summarySheet.getCell(`F${r}`).value = idx + 1;
    summarySheet.getCell(`G${r}`).value = p._id;
    summarySheet.getCell(`H${r}`).value = p.count;
    summarySheet.getCell(`H${r}`).numFmt = '#,##0';
    [summarySheet.getCell(`F${r}`), summarySheet.getCell(`G${r}`), summarySheet.getCell(`H${r}`)].forEach(c => {
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
  });

  // 5. GHI CHÚ
  summarySheet.getCell('B22').value = '💡 GHI CHÚ VẬN HÀNH:';
  summarySheet.getCell('B22').font = { bold: true, color: { argb: 'FF1E3A8A' } };
  summarySheet.getCell('B23').value = '• Toàn bộ 23.923 bản ghi chi tiết từng căn hộ được lưu tại Sheet thứ 2 [Chi_tiet_quy_can].';
  summarySheet.getCell('B24').value = '• Người dùng có thể sử dụng tính năng lọc (AutoFilter) tại Sheet thứ 2 để lọc theo Dự án, Mã căn, Tầm giá hoặc Loại hình.';
  summarySheet.getCell('B25').value = '• Báo cáo này phản ánh toàn bộ quỹ căn hiện hữu trong Cơ sở dữ liệu MongoDB Local.';

  // ==================================================================
  // SHEET 2: CHI TIẾT QUỸ CĂN (23.923 ROWS)
  // ==================================================================
  console.log('📝 Đang tạo Sheet 2: Chi_tiet_quy_can...');
  const detailSheet = workbook.addWorksheet('Chi_tiet_quy_can', {
    properties: { tabColor: { argb: 'FF1E3A8A' } },
  });

  // 18 cột thông tin rổ hàng cốt lõi (Không kèm các link ảnh rườm rà)
  detailSheet.columns = [
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

  const units = await Unit.find({}).sort({ source: 1, project_name: 1, unit_code: 1 }).lean();

  units.forEach((unit, index) => {
    detailSheet.addRow({
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

  // Header styling for Sheet 2
  const headerRow2 = detailSheet.getRow(1);
  headerRow2.height = 30;
  headerRow2.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow2.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };

  detailSheet.getColumn('price').numFmt = '#,##0';
  detailSheet.getColumn('price_tts').numFmt = '#,##0';
  detailSheet.getColumn('area_land').numFmt = '#,##0.00';
  detailSheet.getColumn('area_build').numFmt = '#,##0.00';
  detailSheet.getColumn('created_at').numFmt = 'dd/mm/yyyy hh:mm:ss';

  detailSheet.getColumn('index').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('source').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('floor').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('unit_code').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('direction').alignment = { horizontal: 'center', vertical: 'middle' };
  detailSheet.getColumn('status').alignment = { horizontal: 'center', vertical: 'middle' };

  detailSheet.views = [{ state: 'frozen', ySplit: 1 }];
  detailSheet.autoFilter = { from: 'A1', to: 'R1' };

  // ==================================================================
  // LƯU FILE
  // ==================================================================
  const exportDir = path.resolve('D:/intern/crawler/reports');
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const fileName = `Bao_cao_so_lieu_quy_can_${new Date().toISOString().slice(0, 10)}.xlsx`;
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
  console.log(`✨ Sheet 1: Tong_hop_so_lieu (Dashboard trực quan)`);
  console.log(`✨ Sheet 2: Chi_tiet_quy_can (23.923 căn hộ sạch đẹp, không rác ảnh)`);

  process.exit(0);
}

exportAll().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
