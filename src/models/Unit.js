const mongoose = require('mongoose');

const unitSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: true,
      default: 'hisale',
      index: true
    },
    project_id: {
      type: Number,
      index: true
    },
    project_name: {
      type: String,
      required: true,
      index: true
    },
    subdivision: {
      type: String, // Phân khu (Vịnh Bình Minh 1, Thiên Đường Nhiệt Đới 1...)
      default: ''
    },
    building: {
      type: String,
      default: ''
    },
    floor: {
      type: String,
      default: ''
    },
    unit_code: {
      type: String, // Mã căn (BM84-25, ND11-62...)
      required: true,
      index: true
    },
    unit_type: {
      type: String, // Liền kề, Song lập, Đơn lập, Shophouse...
      default: ''
    },
    area_land: {
      type: Number, // Diện tích đất (m2)
      default: 0
    },
    area_build: {
      type: Number, // Diện tích xây dựng (m2)
      default: 0
    },
    price: {
      type: Number, // Giá bán dạng số (để sort / filter)
      default: 0
    },
    price_text: {
      type: String, // Text hiển thị giá gốc (ví dụ: 13.11 tỷ)
      default: ''
    },
    price_tts: {
      type: Number, // Giá thanh toán sớm
      default: 0
    },
    status: {
      type: String, // Còn hàng, Giữ chỗ, Đã bán...
      default: 'Còn hàng'
    },
    direction: {
      type: String, // Hướng (Đông Bắc, Tây Nam...)
      default: ''
    },
    delivery_standard: {
      type: String, // Tiêu chuẩn bàn giao (Thô, Hoàn thiện, Giãn xây)
      default: ''
    },
    bank_support: {
      type: String, // Ngân hàng hỗ trợ (BIDV, Techcombank, MB...)
      default: ''
    },
    price_list_url: {
      type: String, // Link Google Drive bảng giá / chính sách
      default: ''
    },
    image_urls: {
      type: [String], // Danh sách link ảnh layout, bảng giá
      default: []
    },
    // Google Drive & Image Storage V2 fields
    drive_image_urls: {
      type: [String], // Danh sách link ảnh riêng của căn trên Google Drive
      default: []
    },
    project_image_urls: {
      type: [String], // URL ảnh phối cảnh / avatar dự án dùng chung
      default: []
    },
    drive_project_image_urls: {
      type: [String], // URL ảnh dự án đã đồng bộ trên Google Drive
      default: []
    },
    layout_image_urls: {
      type: [String], // URL ảnh layout mặt bằng
      default: []
    },
    drive_layout_image_urls: {
      type: [String], // URL ảnh layout mặt bằng trên Google Drive
      default: []
    },
    document_urls: {
      type: [String], // Tài liệu liên quan (PDF, brochure...)
      default: []
    },
    drive_folder_id: {
      type: String, // ID thư mục riêng của căn trên Google Drive
      default: ''
    },
    drive_folder_url: {
      type: String, // Link trực tiếp mở thư mục căn trên Google Drive
      default: ''
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
            enum: ['UNIT', '_PROJECT', '_LAYOUT'],
            default: 'UNIT'
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
    raw_data: {
      type: Object, // Lưu toàn bộ data JSON gốc từ API
      default: {}
    },
    is_notified: {
      type: Boolean, // Cờ kiểm tra đã gửi mail chưa (false: tin mới cần gửi)
      default: false,
      index: true
    },
    created_at: {
      type: Date,
      default: Date.now
    },
    updated_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: false // Ta tự quản lý created_at qua $setOnInsert
  }
);

// Compound Unique Index: Đảm bảo 1 mã căn trong cùng 1 dự án & nguồn không bị trùng lặp
unitSchema.index({ source: 1, project_name: 1, unit_code: 1 }, { unique: true });

module.exports = mongoose.model('Unit', unitSchema);
