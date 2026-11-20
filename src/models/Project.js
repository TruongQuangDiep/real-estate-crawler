const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  // Nguồn dữ liệu: 'hisale' hoặc 'salepro'
  source: {
    type: String,
    required: true,
    enum: ['hisale', 'salepro'],
    index: true
  },
  // ID dự án trên web nguồn
  project_id: {
    type: Number,
    required: true
  },
  project_code: {
    type: String,
    default: ''
  },
  project_name: {
    type: String,
    required: true,
    trim: true
  },
  project_slug: {
    type: String,
    default: ''
  },
  // 'low_rise' | 'high_rise' | 'mixed' | ''
  project_type: {
    type: String,
    default: ''
  },
  investor: {
    type: String,
    default: ''
  },
  project_address: {
    type: String,
    default: ''
  },
  // Trạng thái dự án: 'public', 'launching_soon', ...
  state: {
    type: String,
    default: 'public',
    index: true
  },
  // 0 = còn hàng, 1 = hết hàng
  out_of_stock: {
    type: Number,
    default: 0
  },
  // Tổng số căn đang mở bán trên web
  apartment_count: {
    type: Number,
    default: 0
  },
  min_price: {
    type: Number,
    default: 0
  },
  max_price: {
    type: Number,
    default: 0
  },
  // Dữ liệu gốc từ API danh sách dự án
  raw_data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Google Drive & Image Storage V2 fields
  drive_folder_id: {
    type: String,
    default: ''
  },
  drive_folder_url: {
    type: String,
    default: ''
  },
  project_image_urls: {
    type: [String],
    default: []
  },
  drive_project_image_urls: {
    type: [String],
    default: []
  },
  layout_image_urls: {
    type: [String],
    default: []
  },
  drive_layout_image_urls: {
    type: [String],
    default: []
  },
  document_urls: {
    type: [String],
    default: []
  },
  stored_images: {
    type: [
      {
        original_url: { type: String, default: '' },
        drive_file_id: { type: String, default: '' },
        drive_url: { type: String, default: '' },
        sha256: { type: String, default: '' },
        mime_type: { type: String, default: '' },
        file_size: { type: Number, default: 0 },
        image_type: {
          type: String,
          enum: ['_PROJECT', '_LAYOUT'],
          default: '_PROJECT'
        },
        uploaded_at: { type: Date, default: Date.now }
      }
    ],
    default: []
  },
  image_sync_status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'PARTIAL', 'FAILED', 'NO_IMAGE'],
    default: 'PENDING'
  },
  image_synced_at: {
    type: Date,
    default: null
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

// Định danh duy nhất mỗi dự án theo nguồn
projectSchema.index({ source: 1, project_id: 1 }, { unique: true });

module.exports = mongoose.model('Project', projectSchema);
