require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const { sendWeeklyReport } = require('../services/weeklyReportService');

async function main() {
  await connectDB();

  const isTest = process.argv.includes('--test');

  console.log(`[Weekly Report Script] Chế độ: ${isTest ? 'KIỂM THỬ GIAO DIỆN MẪU (--test)' : 'GỬI BÁO CÁO THẬT (--send)'}...`);

  try {
    const result = await sendWeeklyReport({
      isForced: true,
      isTest,
    });
    console.log('[Weekly Report Script] Kết quả:', result);
  } catch (err) {
    console.error('[Weekly Report Script] ❌ Lỗi:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main().catch(async (e) => {
  console.error('[Weekly Report Fatal]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
