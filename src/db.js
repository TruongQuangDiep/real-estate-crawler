const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error('Chưa cấu hình biến môi trường MONGO_URI');
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
    });

    // Mask sensitive credentials if present in connection string
    const maskedUri = uri.replace(/\/\/[^@]+@/, '//***:***@');
    console.log(`[MongoDB] Kết nối thành công (${maskedUri})`);
  } catch (error) {
    console.error(`[MongoDB] Lỗi kết nối CSDL:`, error.message);
    throw error;
  }
}

async function disconnectDB() {
  try {
    await mongoose.disconnect();
    console.log('[MongoDB] Đã ngắt kết nối an toàn');
  } catch (error) {
    console.error('[MongoDB] Lỗi ngắt kết nối:', error.message);
  }
}

module.exports = { connectDB, disconnectDB };
