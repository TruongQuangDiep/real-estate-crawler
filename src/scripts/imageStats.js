require('dotenv').config();
const { connectDB, disconnectDB } = require('../db');
const Unit = require('../models/Unit');
const Project = require('../models/Project');

async function runStats() {
  console.log('\n====================================================================');
  console.log('📊 [IMAGE STATS] THỐNG KÊ DỮ LIỆU HÌNH ẢNH & TIẾN ĐỘ ĐỒNG BỘ GOOGLE DRIVE');
  console.log('====================================================================');

  await connectDB();

  try {
    const totalUnits = await Unit.countDocuments();
    const totalProjects = await Project.countDocuments();

    console.log(`\n📌 TỔNG QUAN HỆ THỐNG:`);
    console.log(`  - Tổng số căn hộ (Units):   ${totalUnits.toLocaleString('vi-VN')} bản ghi`);
    console.log(`  - Tổng số dự án (Projects): ${totalProjects.toLocaleString('vi-VN')} dự án`);

    // 1. Thống kê quỹ căn theo từng nguồn
    const unitStats = await Unit.aggregate([
      {
        $group: {
          _id: '$source',
          total: { $sum: 1 },
          hasOriginalImages: {
            $sum: {
              $cond: [
                { $and: [{ $isArray: '$image_urls' }, { $gt: [{ $size: '$image_urls' }, 0] }] },
                1,
                0,
              ],
            },
          },
          syncedSuccess: {
            $sum: {
              $cond: [{ $eq: ['$image_sync_status', 'SUCCESS'] }, 1, 0],
            },
          },
          syncedPartial: {
            $sum: {
              $cond: [{ $eq: ['$image_sync_status', 'PARTIAL'] }, 1, 0],
            },
          },
          syncedFailed: {
            $sum: {
              $cond: [{ $eq: ['$image_sync_status', 'FAILED'] }, 1, 0],
            },
          },
          noImage: {
            $sum: {
              $cond: [{ $eq: ['$image_sync_status', 'NO_IMAGE'] }, 1, 0],
            },
          },
          pending: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$image_sync_status', 'PENDING'] },
                    { $eq: [{ $ifNull: ['$image_sync_status', null] }, null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    console.log(`\n🏢 THỐNG KÊ CHI TIẾT THEO SÀN / NGUỒN DỮ LIỆU:`);
    console.log('--------------------------------------------------------------------');
    console.log(
      'Nguồn'.padEnd(10) +
        'Tổng căn'.padEnd(12) +
        'Có ảnh gốc'.padEnd(14) +
        'Đã đồng bộ'.padEnd(14) +
        'Chưa đồng bộ'.padEnd(14) +
        'Lỗi'.padEnd(8) +
        'Không có ảnh'
    );
    console.log('--------------------------------------------------------------------');

    for (const stat of unitStats) {
      const sourceName = (stat._id || 'unknown').toUpperCase();
      console.log(
        sourceName.padEnd(10) +
          String(stat.total).padEnd(12) +
          String(stat.hasOriginalImages).padEnd(14) +
          String(stat.syncedSuccess + stat.syncedPartial).padEnd(14) +
          String(stat.pending).padEnd(14) +
          String(stat.syncedFailed).padEnd(8) +
          String(stat.noImage)
      );
    }
    console.log('--------------------------------------------------------------------');

    // 2. Thống kê dự án theo nguồn
    const projectStats = await Project.aggregate([
      {
        $group: {
          _id: '$source',
          total: { $sum: 1 },
          hasAvatar: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $and: [{ $ne: ['$project_image_url', null] }, { $ne: ['$project_image_url', ''] }] },
                    { $and: [{ $isArray: '$project_image_urls' }, { $gt: [{ $size: '$project_image_urls' }, 0] }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          hasDocuments: {
            $sum: {
              $cond: [
                { $and: [{ $isArray: '$document_urls' }, { $gt: [{ $size: '$document_urls' }, 0] }] },
                1,
                0,
              ],
            },
          },
          avatarSynced: {
            $sum: {
              $cond: [
                { $and: [{ $isArray: '$drive_project_image_urls' }, { $gt: [{ $size: '$drive_project_image_urls' }, 0] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    console.log(`\n📁 THỐNG KÊ MEDIA DỰ ÁN (PROJECTS):`);
    console.log('--------------------------------------------------------------------');
    console.log(
      'Nguồn'.padEnd(10) +
        'Tổng dự án'.padEnd(14) +
        'Có ảnh đại diện'.padEnd(18) +
        'Đã đồng bộ Drive'.padEnd(18) +
        'Có tài liệu layout'
    );
    console.log('--------------------------------------------------------------------');

    for (const pStat of projectStats) {
      const pSource = (pStat._id || 'unknown').toUpperCase();
      console.log(
        pSource.padEnd(10) +
          String(pStat.total).padEnd(14) +
          String(pStat.hasAvatar).padEnd(18) +
          String(pStat.avatarSynced).padEnd(18) +
          String(pStat.hasDocuments)
      );
    }
    console.log('--------------------------------------------------------------------');

    console.log(`\n💡 Ghi chú:`);
    console.log(`  - Sàn HiSale: 100% căn có ảnh riêng đều có link gốc trong image_urls.`);
    console.log(`  - Sàn SalePro: API quỹ căn không trả về ảnh riêng từng căn (NO_IMAGE), media nằm ở cấp độ Dự án.`);
    console.log(`  - Lệnh này chỉ đọc dữ liệu thống kê từ MongoDB, không tải hay upload dữ liệu lên Google Drive.\n`);
  } catch (err) {
    console.error('❌ Lỗi thống kê:', err.message);
  } finally {
    await disconnectDB();
  }
}

runStats();
