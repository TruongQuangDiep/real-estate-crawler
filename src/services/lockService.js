const crypto = require('crypto');
const SystemLock = require('../models/SystemLock');

/**
 * Cố gắng lấy khóa phân tán (Distributed Lock) trong MongoDB
 * @param {string} lockKey - Định danh khóa (ví dụ: 'PROJECT_MEDIA_SYNC')
 * @param {object} options
 * @param {string} options.holder - Định danh tiến trình (mặc định theo PID)
 * @param {number} options.ttlMs - Thời hạn hiệu lực khóa (mặc định 15 phút)
 * @param {number} options.maxRetries - Số lần thử lại nếu bị khóa (mặc định 0)
 * @param {number} options.retryDelayMs - Độ trễ giữa các lần thử lại (mặc định 3000ms)
 * @returns {Promise<{ acquired: boolean, leaseId: string|null, lockKey: string, expiresAt: Date|null }>}
 */
async function acquireLock(lockKey, {
  holder = `PID_${process.pid}`,
  ttlMs = 15 * 60 * 1000,
  maxRetries = 0,
  retryDelayMs = 3000,
} = {}) {
  const leaseId = crypto.randomUUID();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
      // Dùng findOneAndUpdate nguyên tử:
      // Chỉ thành công nếu:
      // 1. Chưa có document lock
      // 2. Hoặc locked_until < now (khóa cũ đã hết hạn)
      const lockDoc = await SystemLock.findOneAndUpdate(
        {
          _id: lockKey,
          $or: [
            { locked_until: { $exists: false } },
            { locked_until: { $lt: now } },
            { locked_until: null },
          ],
        },
        {
          $set: {
            _id: lockKey,
            locked_by: holder,
            lease_id: leaseId,
            locked_at: now,
            locked_until: expiresAt,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );

      // Nếu document vừa cập nhật mang leaseId của ta, việc lấy khóa thành công
      if (lockDoc && lockDoc.lease_id === leaseId) {
        return {
          acquired: true,
          leaseId,
          lockKey,
          expiresAt,
        };
      }
    } catch (err) {
      // Bắt lỗi E11000 (duplicate key) khi 2 worker upsert đồng thời cùng một mili-giây
      if (!err.message.includes('E11000')) {
        console.error(`[LockService] ❌ Lỗi truy vấn khóa [${lockKey}]:`, err.message);
      }
    }

    if (attempt < maxRetries) {
      // Đọc thông tin khóa đang bận để log cảnh báo
      const current = await SystemLock.findById(lockKey).lean().catch(() => null);
      const remainingSec = current?.locked_until
        ? Math.max(0, Math.round((new Date(current.locked_until).getTime() - Date.now()) / 1000))
        : 0;

      console.warn(
        `[LockService] ⏳ Khóa [${lockKey}] đang được giữ bởi [${current?.locked_by || 'Unknown'}] ` +
          `(còn hiệu lực ~${remainingSec}s). Đợi thử lại (${attempt + 1}/${maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return {
    acquired: false,
    leaseId: null,
    lockKey,
    expiresAt: null,
  };
}

/**
 * Giải phóng khóa phân tán an toàn (chỉ worker đang nắm leaseId mới được giải phóng)
 * @param {string} lockKey
 * @param {string} leaseId
 */
async function releaseLock(lockKey, leaseId) {
  if (!lockKey || !leaseId) return false;

  try {
    const result = await SystemLock.deleteOne({
      _id: lockKey,
      lease_id: leaseId,
    });
    return result.deletedCount > 0;
  } catch (err) {
    console.error(`[LockService] ❌ Lỗi giải phóng khóa [${lockKey}]:`, err.message);
    return false;
  }
}

/**
 * Thực thi tác vụ độc quyền với cơ chế tự động lấy và giải phóng khóa
 * @param {string} lockKey
 * @param {Function} workerFn
 * @param {object} options
 */
async function withLock(lockKey, workerFn, options = {}) {
  const lockResult = await acquireLock(lockKey, options);

  if (!lockResult.acquired) {
    console.warn(`[LockService] ⛔ Bỏ qua tác vụ: Không thể lấy khóa [${lockKey}] do tiến trình khác đang xử lý.`);
    return { executed: false, reason: 'LOCK_UNAVAILABLE' };
  }

  try {
    const data = await workerFn(lockResult.leaseId);
    return { executed: true, data };
  } catch (err) {
    console.error(`[LockService] ❌ Lỗi thực thi tác vụ trong khóa [${lockKey}]:`, err.message);
    throw err;
  } finally {
    await releaseLock(lockKey, lockResult.leaseId);
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  withLock,
};
