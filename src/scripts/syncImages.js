require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const { syncPendingImages } = require('../services/imageStorageService');

async function main() {
  await connectDB();

  const args = process.argv.slice(2);
  const limitArg = args.find((a) => /^\d+$/.test(a));
  const limit = limitArg ? Number(limitArg) : null;

  try {
    await syncPendingImages(limit);
  } catch (err) {
    console.error('[Sync Script] ❌ Lỗi:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main().catch(async (e) => {
  console.error('[Sync Script Fatal]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
