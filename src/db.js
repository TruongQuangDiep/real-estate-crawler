const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI;
  try {
    await mongoose.connect(uri);
    console.log(`[MongoDB] Kết nối thành công tới: ${uri}`);
  } catch (error) {
    console.error(`[MongoDB] Lỗi kết nối CSDL:`, error.message);
    throw error;
  }
}

module.exports = { connectDB };
