require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDriveClient, isDriveConfigured } = require('../services/googleDriveService');

async function main() {
  console.log(`\n====================================================================`);
  console.log(`📁 [CREATE ROOT] KHỞI TẠO HOẶC TÁI SỬ DỤNG THƯ MỤC TỔNG GOOGLE DRIVE`);
  console.log(`====================================================================\n`);

  const check = isDriveConfigured();
  if (!check.enabled && check.reason.includes('GOOGLE_DRIVE_ROOT_FOLDER_ID')) {
    // Nếu chỉ thiếu Folder ID thì vẫn tiếp tục
  } else if (!check.enabled) {
    console.error(`❌ Dịch vụ Google Drive chưa sẵn sàng: ${check.reason}`);
    process.exit(1);
  }

  try {
    const drive = getDriveClient();
    const folderName = (process.env.GOOGLE_DRIVE_ROOT_FOLDER_NAME || 'Real_Estate_Crawler_Test').trim();

    console.log(`🔍 Đang kiểm tra xem thư mục "${folderName}" đã tồn tại trên Drive chưa...`);
    const cleanName = folderName.replace(/'/g, "\\'");
    const listRes = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and name = '${cleanName}' and trashed = false`,
      spaces: 'drive',
      fields: 'files(id, name, webViewLink, capabilities)',
      pageSize: 5,
    });

    let rootFolder = null;

    if (listRes.data.files && listRes.data.files.length > 0) {
      // Đã có thư mục do app tạo trước đó, tái sử dụng để tránh tạo trùng
      rootFolder = listRes.data.files[0];
      console.log(`\nℹ️ ĐÃ TÌM THẤY THƯ MỤC HỢP LỆ ĐÃ TỒN TẠI (TÁI SỬ DỤNG):`);
      console.log(`   - Tên thư mục: "${rootFolder.name}"`);
      console.log(`   - Folder ID:   ${rootFolder.id}`);
      console.log(`   - Link Drive:  ${rootFolder.webViewLink}`);
    } else {
      // Chưa có, tiến hành tạo mới
      console.log(`⏳ Chưa có thư mục, đang tạo mới thư mục "${folderName}" qua Google Drive API...`);
      const createRes = await drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          description: 'Thư mục tổng lưu trữ rổ hàng Bất động sản tạo tự động bởi Real Estate Crawler Bot',
        },
        fields: 'id, name, webViewLink',
      });

      rootFolder = createRes.data;
      console.log(`\n✅ TẠO MỚI THƯ MỤC THÀNH CÔNG!`);
      console.log(`   - Tên thư mục: "${rootFolder.name}"`);
      console.log(`   - Folder ID:   ${rootFolder.id}`);
      console.log(`   - Link Drive:  ${rootFolder.webViewLink}`);
    }

    const newFolderId = rootFolder.id;

    // Tự động cập nhật GOOGLE_DRIVE_ROOT_FOLDER_ID và GOOGLE_DRIVE_ROOT_FOLDER_NAME vào file .env
    const envPath = path.resolve('.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');

      if (envContent.includes('GOOGLE_DRIVE_ROOT_FOLDER_NAME=')) {
        envContent = envContent.replace(
          /^GOOGLE_DRIVE_ROOT_FOLDER_NAME=.*$/m,
          `GOOGLE_DRIVE_ROOT_FOLDER_NAME=${folderName}`
        );
      } else {
        envContent += `\nGOOGLE_DRIVE_ROOT_FOLDER_NAME=${folderName}\n`;
      }

      if (envContent.includes('GOOGLE_DRIVE_ROOT_FOLDER_ID=')) {
        envContent = envContent.replace(
          /^GOOGLE_DRIVE_ROOT_FOLDER_ID=.*$/m,
          `GOOGLE_DRIVE_ROOT_FOLDER_ID=${newFolderId}`
        );
      } else {
        envContent += `\nGOOGLE_DRIVE_ROOT_FOLDER_ID=${newFolderId}\n`;
      }

      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log(`\n📝 Đã tự động cập nhật .env:`);
      console.log(`   - GOOGLE_DRIVE_ROOT_FOLDER_NAME=${folderName}`);
      console.log(`   - GOOGLE_DRIVE_ROOT_FOLDER_ID=${newFolderId}`);
    }

    console.log(`\n👉 Tiếp theo: Bạn chỉ cần chạy lệnh kiểm tra kết nối:`);
    console.log(`   npm run drive:test\n`);
  } catch (err) {
    console.error('❌ Lỗi khi khởi tạo thư mục tổng:', err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
