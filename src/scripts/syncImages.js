require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const { syncPendingImages } = require('../services/imageStorageService');

function parseArgs() {
  const args = process.argv.slice(2);
  let source = 'all';
  let limit = null;

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1].trim().toLowerCase();
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.split('=')[1]);
    } else if (/^\d+$/.test(arg)) {
      limit = Number(arg);
    } else if (arg.toLowerCase() === 'hisale' || arg.toLowerCase() === 'salepro') {
      source = arg.toLowerCase();
    }
  }

  return { source, limit };
}

async function main() {
  await connectDB();

  const { source, limit } = parseArgs();

  try {
    await syncPendingImages({ source, limit });
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
