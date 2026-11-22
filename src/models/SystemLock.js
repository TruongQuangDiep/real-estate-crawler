const mongoose = require('mongoose');

/**
 * SystemLock Schema: Quản lý khóa phân tán (Distributed Lock) giữa Scheduler và CLI
 * Ngăn chặn xung đột đồng thời khi chạy đồng bộ media hoặc dữ liệu
 */
const systemLockSchema = new mongoose.Schema(
  {
    _id: {
      type: String, // Khóa định danh: 'PROJECT_MEDIA_SYNC', 'IMAGE_UNIT_SYNC', v.v.
      required: true,
    },
    locked_by: {
      type: String, // Tên tiến trình / Worker ID (ví dụ: 'CLI_1234', 'CRON_5678')
      default: '',
    },
    lease_id: {
      type: String, // UUID đại diện cho phiên sở hữu khóa hiện tại
      required: true,
    },
    locked_at: {
      type: Date,
      default: Date.now,
    },
    locked_until: {
      type: Date,
      required: true,
      index: true, // Hỗ trợ TTL query dọn dẹp khóa quá hạn
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('SystemLock', systemLockSchema, 'system_locks');
