const mongoose = require('mongoose');

const reportLogSchema = new mongoose.Schema({
  report_type: {
    type: String,
    required: true,
    enum: ['DAILY', 'WEEKLY'],
    index: true,
  },
  // Khóa định danh ngày hoặc tuần (vd: '2026-11-20' hoặc '2026-W47') để chống gửi trùng tuyệt đối kể cả sau khi restart VPS
  period_key: {
    type: String,
    required: true,
    index: true,
  },
  period_start: {
    type: Date,
    required: true,
  },
  period_end: {
    type: Date,
    required: true,
  },
  sent_at: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ['SUCCESS', 'FAILED', 'SKIPPED_NO_DATA'],
    default: 'SUCCESS',
  },
  total_units: {
    type: Number,
    default: 0,
  },
  summary: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  recipients: {
    type: [String],
    default: [],
  },
  excel_file_name: {
    type: String,
    default: '',
  },
  error_message: {
    type: String,
    default: null,
  },
});

reportLogSchema.index({ report_type: 1, period_key: 1 }, { unique: true });

module.exports = mongoose.model('ReportLog', reportLogSchema);
