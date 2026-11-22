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
  // Google Drive & Image Storage V2 & V3 fields
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
  floor_plan_urls: {
    type: [String],
    default: []
  },
  drive_floor_plan_urls: {
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
  // Chi tiết các loại mặt bằng & layout
  floor_plans: {
    type: [
      {
        floorplan_name: { type: String, default: '' },
        image_url: { type: String, default: '' },
        drive_url: { type: String, default: '' },
        sha256: { type: String, default: '' }
      }
    ],
    default: []
  },
  product_layouts: {
    type: [
      {
        product_name: { type: String, default: '' },
        category: { type: String, default: '' }, // e.g. Studio, 1PN, 1PN_Plus, 2PN, Lien_ke...
        features: { type: String, default: '' },
        image_url: { type: String, default: '' },
        drive_url: { type: String, default: '' },
        sha256: { type: String, default: '' }
      }
    ],
    default: []
  },
  documents_classified: {
    type: [
      {
        title: { type: String, default: '' },
        category: {
          type: String,
          enum: ['BANG_GIA', 'CSBH', 'LAYOUT', 'PHAP_LY', 'BIEU_MAU', 'OTHER'],
          default: 'OTHER'
        },
        source_url: { type: String, default: '' },
        target_url: { type: String, default: '' }
      }
    ],
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
        etag: { type: String, default: '' },
        last_modified: { type: String, default: '' },
        image_type: {
          type: String,
          enum: ['_PROJECT', '_LAYOUT', '_FLOOR_PLAN'],
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
    default: 'PENDING',
    index: true
  },
  image_sync_locked_until: {
    type: Date,
    default: null,
    index: true
  },
  image_sync_lock_owner: {
    type: String, // Lease ID / Worker ID sở hữu khóa
    default: null,
    index: true
  },
  image_sync_retries: {
    type: Number,
    default: 0
  },
  image_sync_error: {
    type: String,
    default: ''
  },
  image_synced_at: {
    type: Date,
    default: null
  },
  media_schema_version: {
    type: Number,
    default: 1, // 1: V1/V2 avatar only, 3: V3 Media (_Project, _FloorPlans, _Layouts)
    index: true
  },
  media_synced_at: {
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
