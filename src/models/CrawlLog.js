const mongoose = require('mongoose');

const crawlLogSchema = new mongoose.Schema({
  started_at: {
    type: Date,
    default: Date.now,
  },
  finished_at: {
    type: Date,
  },
  source: {
    type: String,
    default: 'hisale',
  },
  project_id: {
    type: mongoose.Schema.Types.Mixed,
  },
  status: {
    type: String,
    enum: ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'],
    default: 'RUNNING',
  },
  total_projects: {
    type: Number,
    default: 0,
  },
  success_projects: {
    type: Number,
    default: 0,
  },
  failed_projects: {
    type: Number,
    default: 0,
  },
  skipped_projects: {
    type: Number,
    default: 0,
  },
  total_scanned: {
    type: Number,
    default: 0,
  },
  new_units_count: {
    type: Number,
    default: 0,
  },
  updated_units_count: {
    type: Number,
    default: 0,
  },
  mail_sent: {
    type: Boolean,
    default: false,
  },
  error_message: {
    type: String,
    default: null,
  },
});

module.exports = mongoose.model('CrawlLog', crawlLogSchema);
