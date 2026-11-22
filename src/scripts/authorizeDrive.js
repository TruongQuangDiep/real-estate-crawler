require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { OAuth2Client } = require('google-auth-library');

const SCOPES = ['https://www.googleapis.com/auth/drive'];

const credentialsPath = path.resolve(process.env.GOOGLE_DRIVE_CREDENTIALS || './credentials/credentials.json');
const tokenPath = path.resolve(process.env.GOOGLE_DRIVE_TOKEN || './credentials/token.json');

/**
 * Mở URL trên trình duyệt mặc định của hệ điều hành mà không làm rách URL
 */
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

/**
 * Đọc và xác thực cấu hình OAuth Client từ file credentials.json
 */
function loadClientConfig() {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Không tìm thấy file credentials tại: ${credentialsPath}`);
  }
  const raw = fs.readFileSync(credentialsPath, 'utf8');
  const parsed = JSON.parse(raw);
  const config = parsed.installed || parsed.web;
  if (!config) {
    throw new Error('File credentials.json thiếu cấu hình "installed" hoặc "web"');
  }
  if (!config.client_id || !config.client_secret || config.client_id === 'xxxx') {
    throw new Error('File credentials.json chứa giá trị placeholder (xxxx). Vui lòng cập nhật Client ID thật từ GCP');
  }
  return config;
}

/**
 * Lưu token an toàn vào credentials/token.json (bảo tồn refresh_token nếu có trước đó)
 */
function saveTokens(newTokens) {
  let mergedTokens = { ...newTokens };

  if (fs.existsSync(tokenPath)) {
    try {
      const oldTokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      if (!mergedTokens.refresh_token && oldTokens.refresh_token && oldTokens.refresh_token !== 'xxxx') {
        mergedTokens.refresh_token = oldTokens.refresh_token;
      }
    } catch (_) {}
  }

  const tokenDir = path.dirname(tokenPath);
  if (!fs.existsSync(tokenDir)) {
    fs.mkdirSync(tokenDir, { recursive: true });
  }

  fs.writeFileSync(tokenPath, JSON.stringify(mergedTokens, null, 2));
}

/**
 * Phương án 1: Xác thực qua thư viện chính thức @google-cloud/local-auth
 */
async function authenticateWithLocalAuth() {
  console.log('[Auth] 🚀 Đang khởi động Loopback Flow với @google-cloud/local-auth...');
  const { authenticate } = require('@google-cloud/local-auth');

  // Đảm bảo request luôn có prompt=consent và access_type=offline để lấy refresh_token
  const origGenerate = OAuth2Client.prototype.generateAuthUrl;
  OAuth2Client.prototype.generateAuthUrl = function (opts) {
    return origGenerate.call(this, {
      ...opts,
      prompt: 'consent',
      access_type: 'offline',
    });
  };

  try {
    const authClient = await authenticate({
      keyfilePath: credentialsPath,
      scopes: SCOPES,
    });
    return authClient.credentials;
  } finally {
    OAuth2Client.prototype.generateAuthUrl = origGenerate;
  }
}

/**
 * Phương án 2 (Fallback): Tự triển khai Loopback Server với http://127.0.0.1, PKCE (S256) và State validation
 */
async function authenticateWithCustomLoopback(clientConfig) {
  console.log('[Auth] 🔄 Đang khởi chạy Custom Loopback Server (http://127.0.0.1 + PKCE S256)...');

  // 1. Tạo PKCE code_verifier và code_challenge (RFC 7636)
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    // 2. Tạo HTTP Server lắng nghe trên 127.0.0.1 với cổng động (port 0)
    const server = http.createServer(async (req, res) => {
      try {
        const address = server.address();
        const base = `http://127.0.0.1:${address.port}`;
        const reqUrl = new URL(req.url, base);

        // Kiểm tra lỗi từ Google
        if (reqUrl.searchParams.has('error')) {
          const errReason = reqUrl.searchParams.get('error');
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h2 style="color:red">Xác thực bị từ chối: ${errReason}</h2>`);
          server.close();
          return reject(new Error(`Google từ chối xác thực: ${errReason}`));
        }

        // Kiểm tra tham số state chống tấn công CSRF
        const returnedState = reqUrl.searchParams.get('state');
        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2 style="color:red">Lỗi xác thực: State không khớp (CSRF Protection)</h2>');
          server.close();
          return reject(new Error('State parameter mismatch'));
        }

        const code = reqUrl.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2 style="color:red">Không tìm thấy mã authorization code</h2>');
          server.close();
          return reject(new Error('Missing authorization code in callback'));
        }

        // Đổi code lấy token kèm PKCE code_verifier
        const { tokens } = await oauth2Client.getToken({
          code,
          codeVerifier,
          redirect_uri: redirectUri,
        });

        // Trả về trang thông báo hoàn tất đẹp mắt cho người dùng
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>Xác thực thành công</title></head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding-top: 60px; background-color: #f8fafc; color: #1e293b;">
            <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
              <h1 style="color: #16a34a; font-size: 24px; margin-bottom: 12px;">✅ Xác thực Google Drive thành công!</h1>
              <p style="font-size: 15px; color: #475569; line-height: 1.6;">
                Hệ thống Real Estate Crawler đã nhận mã ủy quyền và lưu Refresh Token thành công.<br/>
                <strong>Bạn có thể đóng tab này và quay lại PowerShell.</strong>
              </p>
            </div>
          </body>
          </html>
        `);

        server.close();
        resolve(tokens);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const redirectUri = `http://127.0.0.1:${port}`;

      const oauth2Client = new OAuth2Client({
        clientId: clientConfig.client_id,
        clientSecret: clientConfig.client_secret,
        redirectUri,
      });

      const authorizeUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      console.log(`🌐 Local Callback Server đang lắng nghe tại: ${redirectUri}`);
      console.log(`👉 Đang tự động mở trình duyệt để cấp quyền...`);
      console.log(`(Nếu trình duyệt không tự mở, hãy click vào link dưới đây):`);
      console.log(`--------------------------------------------------------------------`);
      console.log(authorizeUrl);
      console.log(`--------------------------------------------------------------------\n`);

      openBrowser(authorizeUrl);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  console.log(`\n====================================================================`);
  console.log(`🔑 [OAUTH 2.0] XÁC THỰC GOOGLE DRIVE (LOOPBACK REDIRECT FLOW)`);
  console.log(`====================================================================\n`);

  const clientConfig = loadClientConfig();
  let tokens = null;

  // 1. Thử xác thực với @google-cloud/local-auth trước
  try {
    tokens = await authenticateWithLocalAuth();
  } catch (err) {
    console.warn(`[Auth] ⚠️ @google-cloud/local-auth gặp trở ngại (${err.message}). Chuyển sang Custom Loopback Server...`);
    tokens = await authenticateWithCustomLoopback(clientConfig);
  }

  if (!tokens) {
    throw new Error('Không thể thu thập token ủy quyền từ Google');
  }

  // 2. Lưu token vào credentials/token.json
  saveTokens(tokens);

  console.log(`\n====================================================================`);
  console.log(`✅ [THÀNH CÔNG] ĐÃ LƯU TOKEN VĨNH VIỄN VÀO: ${tokenPath}`);
  console.log(`🎉 Bạn đã xác thực Google Drive thành công 100%!`);
  console.log(`👉 Bây giờ bạn có thể chạy: npm run drive:test để kiểm tra kết nối!`);
  console.log(`====================================================================\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ [Lỗi xác thực]:', err.message);
  process.exit(1);
});
