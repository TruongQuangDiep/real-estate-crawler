require('dotenv').config();
const { isDriveConfigured, getDriveClient, ensureFolderPath, uploadFile } = require('../services/googleDriveService');

async function testGoogleDriveIntegration() {
  console.log(`\n====================================================================`);
  console.log(`🧪 [TEST DRIVE] KIỂM TRA KẾT NỐI VÀ QUYỀN TRUY CẬP THƯ MỤC GOOGLE DRIVE`);
  console.log(`====================================================================\n`);

  const check = isDriveConfigured();
  if (!check.enabled) {
    console.warn(`⚠️ Dịch vụ Google Drive chưa sẵn sàng hoạt động:`);
    console.warn(`   Lý do: ${check.reason}\n`);
    console.log(`📋 Checklist cần thiết lập:`);
    console.log(`   1. Tạo credentials.json (OAuth Client ID) tại: ./credentials/credentials.json`);
    console.log(`   2. Chạy lệnh xác thực: npm run drive:auth`);
    console.log(`   3. Bật GOOGLE_DRIVE_ENABLED=true trong file .env`);
    console.log(`   4. Điền GOOGLE_DRIVE_ROOT_FOLDER_ID=1QLSf5pecivmn6KfPNCrJlbUHMPRfYpuk vào .env\n`);
    process.exit(0);
  }

  try {
    const drive = getDriveClient();
    const rootId = check.rootId;

    console.log(`🔍 1. Kiểm tra quyền truy cập Thư mục tổng [ID: ${rootId}]...`);
    const rootRes = await drive.files.get({
      fileId: rootId,
      fields: 'id, name, mimeType, capabilities, owners, permissions',
      supportsAllDrives: true,
    });

    console.log(`   ✅ Đã kết nối thành công tới thư mục: "${rootRes.data.name}"`);
    console.log(`   - MIME Type: ${rootRes.data.mimeType}`);
    const canAddChildren = rootRes.data.capabilities?.canAddChildren;
    console.log(`   - Quyền tạo thư mục/file con (canAddChildren): ${canAddChildren ? 'CÓ (Đầy đủ quyền)' : 'KHÔNG (Cần cấp quyền Edit/Editor cho tài khoản)'}`);

    if (canAddChildren === false) {
      console.warn(`\n⚠️ CẢNH BÁO: Tài khoản của bạn chỉ có quyền xem (Viewer) trên Thư mục tổng.`);
      console.warn(`   Vui lòng liên hệ quản trị viên cấp quyền "Người chỉnh sửa" (Editor) trên thư mục [${rootId}].\n`);
      process.exit(1);
    }

    console.log(`\n📁 2. Thử nghiệm tạo cấu trúc thư mục con: [Test_Run/Sub_Folder]...`);
    const testFolder = await ensureFolderPath(['_Test_Run', 'Connection_Check'], rootId);
    console.log(`   ✅ Tạo thành công thư mục con!`);
    console.log(`   - ID thư mục: ${testFolder.id}`);
    console.log(`   - Link thư mục: ${testFolder.webViewLink}`);

    console.log(`\n📤 3. Thử nghiệm upload 1 file ảnh test (1x1 pixel buffer)...`);
    // Tạo 1 buffer ảnh PNG 1x1 pixel hợp lệ
    const samplePngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    const uploadRes = await uploadFile({
      name: 'ping_test.png',
      buffer: samplePngBuffer,
      mimeType: 'image/png',
      parentFolderId: testFolder.id,
      description: 'File test kiểm tra đường truyền bot crawler',
    });

    console.log(`   ✅ Upload thành công!`);
    console.log(`   - File ID: ${uploadRes.id}`);
    console.log(`   - File Name: ${uploadRes.name}`);
    console.log(`   - Direct Link: ${uploadRes.webViewLink}`);

    console.log(`\n🎉 HOÀN TẤT KIỂM THỬ: Google Drive API hoạt động 100% hoàn hảo và đã sẵn sàng lưu trữ rổ hàng!\n`);
  } catch (err) {
    console.error(`\n❌ Lỗi khi kiểm tra Google Drive API:`, err.message);
    if (err.code === 404 || err.message?.includes('File not found')) {
      console.error(`\n💡 NGUYÊN NHÂN LỖI 404 (File not found):`);
      console.error(`   Không tìm thấy hoặc không có quyền truy cập vào thư mục [${check.rootId}].`);
      console.error(`   - Nếu đây là thư mục do người khác chia sẻ: Hãy đảm bảo tài khoản Gmail của bạn đã được cấp quyền "Người chỉnh sửa" (Editor).`);
      console.error(`   - Nếu vừa thay đổi quyền hoặc scope: Chạy lại lệnh 'npm run drive:auth' để cấp lại quyền truy cập mới.\n`);
      console.error(`🛠️ 2 CÁCH KHẮC PHỤC CỰC KỲ ĐƠN GIẢN:`);
      console.error(`   👉 CÁCH 1 (Khuyên dùng - Nhanh nhất): Tự động tạo thư mục chuẩn qua API:`);
      console.error(`      Chạy lệnh: npm run drive:create-root`);
      console.error(`      (Hệ thống sẽ tạo thư mục mới qua API và tự động điền ID vào file .env cho bạn)\n`);
      console.error(`   👉 CÁCH 2: Cấp quyền cho thư mục công ty có sẵn qua Google Picker:`);
      console.error(`      Chạy lệnh: npm run drive:picker`);
      console.error(`      (Chọn thư mục công ty trên popup để Google cấp quyền truy cập vĩnh viễn cho bot)\n`);
    } else if (err.code === 403) {
      console.error(`   👉 Lỗi quyền truy cập (403): Có thể Google Drive API chưa được bật trên Google Cloud Console hoặc token đã hết hạn.`);
    }
    process.exit(1);
  }
}

testGoogleDriveIntegration().catch((e) => {
  console.error('[Fatal]', e);
  process.exit(1);
});
