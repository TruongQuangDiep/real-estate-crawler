require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { connectDB } = require('../db');
const Unit = require('../models/Unit');
const { buildExcelReport } = require('../services/excelService');

async function exportAll() {
  await connectDB();
  console.log('📊 Đang lấy toàn bộ dữ liệu từ MongoDB Local...');
  
  const units = await Unit.find({}).sort({ source: 1, project_name: 1, unit_code: 1 }).lean();
  console.log(`🔍 Tìm thấy ${units.length} căn hộ trong CSDL. Đang xuất ra file Excel...`);

  const buffer = await buildExcelReport(units, { sheetTitle: 'Toan_bo_gio_hang_CSDL' });

  const exportDir = path.resolve('D:/intern/crawler/reports');
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const fileName = `So_lieu_CSDL_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const filePath = path.join(exportDir, fileName);
  fs.writeFileSync(filePath, buffer);

  console.log(`\n🎉 XUẤT FILE EXCEL THÀNH CÔNG!`);
  console.log(`📁 Đường dẫn file: ${filePath}`);
  console.log(`📦 Dung lượng: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
  
  process.exit(0);
}

exportAll().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
