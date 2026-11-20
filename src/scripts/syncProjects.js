require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const Project = require('../models/Project');
const { syncSaleProProjectMedia } = require('../services/imageStorageService');

function parseArgs() {
  const args = process.argv.slice(2);
  let source = 'salepro';
  let limit = 5;

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1].trim().toLowerCase();
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.split('=')[1]);
    } else if (/^\d+$/.test(arg)) {
      limit = Number(arg);
    }
  }

  return { source, limit };
}

async function main() {
  await connectDB();
  const { source, limit } = parseArgs();

  console.log('\n====================================================================');
  console.log(`📁 [SYNC PROJECTS] ĐỒNG BỘ MEDIA DỰ ÁN (${source.toUpperCase()}) - TỐI ĐA ${limit} DỰ ÁN`);
  console.log('====================================================================');

  try {
    const projects = await Project.find({
      source,
      $or: [
        { drive_project_image_urls: { $exists: false } },
        { drive_project_image_urls: { $size: 0 } },
      ],
    }).limit(limit);

    if (projects.length === 0) {
      console.log(`✨ Tất cả dự án ${source.toUpperCase()} đã được đồng bộ media.`);
      return;
    }

    console.log(`🔍 Tìm thấy ${projects.length} dự án cần đồng bộ media...`);
    let count = 0;

    for (const proj of projects) {
      count++;
      console.log(`\n[${count}/${projects.length}] Đang xử lý dự án: ${proj.project_name}`);
      await syncSaleProProjectMedia(proj);
      const updated = await Project.findById(proj._id).lean();
      console.log(`  ✅ Thư mục Drive: ${updated.drive_folder_url || 'Chưa có'}`);
      console.log(`  📸 Ảnh dự án: ${updated.drive_project_image_urls?.length || 0} link`);
      console.log(`  📑 Ảnh layout: ${updated.drive_layout_image_urls?.length || 0} link`);
      console.log(`  📄 Tài liệu liên quan: ${updated.document_urls?.length || 0} link`);
    }

    console.log('\n🏁 [SYNC PROJECTS] HOÀN TẤT ĐỒNG BỘ DỰ ÁN!');
    console.log('====================================================================\n');
  } catch (err) {
    console.error('❌ Lỗi đồng bộ dự án:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main().catch(async (e) => {
  console.error('[Sync Projects Fatal]', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
