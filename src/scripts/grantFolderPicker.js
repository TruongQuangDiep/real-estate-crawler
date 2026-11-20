require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { isDriveConfigured, getOAuth2Client } = require('../services/googleDriveService');

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
  } catch (_) {}
}

async function main() {
  console.log(`\n====================================================================`);
  console.log(`🗂️ [GOOGLE PICKER] CẤP QUYỀN THƯ MỤC CÓ SẴN QUA GOOGLE PICKER API`);
  console.log(`====================================================================\n`);

  const check = isDriveConfigured();
  // Nếu chỉ thiếu Folder ID thì vẫn tiếp tục
  if (!check.enabled && check.reason.includes('GOOGLE_DRIVE_ROOT_FOLDER_ID')) {
    // Ok
  } else if (!check.enabled) {
    console.error(`❌ Dịch vụ Google Drive chưa sẵn sàng: ${check.reason}`);
    process.exit(1);
  }

  const oauth2Client = getOAuth2Client();
  const token = await oauth2Client.getAccessToken();
  const accessToken = token.token;

  const creds = JSON.parse(fs.readFileSync(check.credsPath, 'utf8'));
  const clientConfig = creds.installed || creds.web;
  const clientId = clientConfig.client_id;
  // App ID thường là phần số đầu tiên của Client ID (trước dấu gạch ngang)
  const appId = clientId.split('-')[0];

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/save-folder') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { folderId, folderName } = JSON.parse(body);
          if (!folderId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Thiếu folderId' }));
          }

          // Cập nhật file .env
          const envPath = path.resolve('.env');
          if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');
            if (envContent.includes('GOOGLE_DRIVE_ROOT_FOLDER_ID=')) {
              envContent = envContent.replace(
                /^GOOGLE_DRIVE_ROOT_FOLDER_ID=.*$/m,
                `GOOGLE_DRIVE_ROOT_FOLDER_ID=${folderId}`
              );
            } else {
              envContent += `\nGOOGLE_DRIVE_ROOT_FOLDER_ID=${folderId}\n`;
            }
            fs.writeFileSync(envPath, envContent, 'utf8');
          }

          console.log(`\n====================================================================`);
          console.log(`✅ [THÀNH CÔNG] ĐÃ CẤP QUYỀN VÀ LIÊN KẾT THƯ MỤC THÀNH CÔNG!`);
          console.log(`   - Tên thư mục: "${folderName || 'Selected Folder'}"`);
          console.log(`   - Folder ID:   ${folderId}`);
          console.log(`   - File .env:   Đã cập nhật GOOGLE_DRIVE_ROOT_FOLDER_ID`);
          console.log(`👉 Bây giờ bạn có thể chạy: npm run drive:test`);
          console.log(`====================================================================\n`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, folderId }));

          setTimeout(() => {
            server.close();
            process.exit(0);
          }, 1000);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Giao diện web Google Picker
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google Picker - Cấp quyền thư mục Google Drive</title>
  <script src="https://apis.google.com/js/api.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #1e293b; padding: 40px 20px; text-align: center; }
    .card { max-width: 600px; margin: 0 auto; background: white; padding: 36px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.08); text-align: left; }
    h1 { font-size: 20px; color: #1e3a8a; margin-top: 0; }
    p { font-size: 14px; color: #475569; line-height: 1.6; }
    .btn { display: inline-block; background-color: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; font-size: 14px; width: 100%; box-sizing: border-box; text-align: center; }
    .btn:hover { background-color: #1d4ed8; }
    .status { margin-top: 16px; padding: 12px; border-radius: 6px; font-size: 13px; display: none; }
    .status.success { background-color: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; display: block; }
    .status.error { background-color: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; display: block; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🗂️ Cấp quyền Thư mục qua Google Picker</h1>
    <p>
      Với scope bảo mật <code>drive.file</code>, Google yêu cầu bạn cấp quyền truy cập cho thư mục công ty bằng cách chọn thư mục đó một lần duy nhất qua <strong>Google Picker</strong>.
    </p>
    <button class="btn" id="pickBtn" onclick="openPicker()">📂 Mở Google Drive để Chọn Thư Mục</button>
    <div id="statusBox" class="status"></div>
  </div>

  <script>
    const oauthToken = ${JSON.stringify(accessToken)};
    const appId = ${JSON.stringify(appId)};
    let pickerApiLoaded = false;

    gapi.load('picker', () => {
      pickerApiLoaded = true;
    });

    function openPicker() {
      if (!pickerApiLoaded) {
        showStatus('Đang tải thư viện Google Picker, vui lòng thử lại sau 2 giây...', 'error');
        return;
      }

      // Tạo view chỉ hiển thị các Folder của Google Drive
      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setMimeTypes('application/vnd.google-apps.folder')
        .setSelectFolderEnabled(true);

      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(oauthToken)
        .setAppId(appId)
        .setCallback(pickerCallback)
        .setTitle('Chọn Thư mục Bất động sản công ty')
        .build();
      picker.setVisible(true);
    }

    function pickerCallback(data) {
      if (data.action === google.picker.Action.PICKED) {
        const doc = data.docs[0];
        const folderId = doc.id;
        const folderName = doc.name;

        showStatus('⏳ Đang lưu quyền truy cập cho thư mục: "' + folderName + '"...', 'success');

        fetch('/save-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId, folderName }),
        })
        .then(res => res.json())
        .then(result => {
          if (result.success) {
            showStatus('✅ ĐÃ CẤP QUYỀN THÀNH CÔNG! Thư mục "' + folderName + '" đã được kết nối. Bạn có thể đóng tab này và quay lại PowerShell.', 'success');
          } else {
            showStatus('❌ Lỗi: ' + (result.error || 'Không thể lưu'), 'error');
          }
        })
        .catch(err => {
          showStatus('❌ Lỗi kết nối: ' + err.message, 'error');
        });
      }
    }

    function showStatus(text, type) {
      const box = document.getElementById('statusBox');
      box.className = 'status ' + type;
      box.innerText = text;
    }
  </script>
</body>
</html>
    `);
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}`;
    console.log(`🌐 Đang mở giao diện Google Picker tại: ${url}`);
    console.log(`👉 Trình duyệt sẽ tự động bật lên. Hãy bấm nút "Mở Google Drive để Chọn Thư Mục"...`);
    openBrowser(url);
  });
}

main().catch((err) => {
  console.error('[Picker Fatal]', err.message);
  process.exit(1);
});
