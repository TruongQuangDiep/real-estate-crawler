const mongoose = require('mongoose');
module.exports = mongoose.model('PricingDocument', new mongoose.Schema({
  source_key: { type: String, unique: true, required: true },
  source_url: String, name: String, drive_file_id: String, drive_url: String,
  status: { type: String, enum: ['SUCCESS', 'FAILED', 'SKIPPED'], required: true },
  error: String, checked_at: Date,
}));
