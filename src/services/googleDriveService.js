const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { google } = require('googleapis');

// Cache bộ nhớ lưu các thư mục đã tìm/tạo để tránh spam API queries lên Google Drive
const folderCache = new Map();

/**
 * Kiểm tra xem dịch vụ Google Drive có được bật và sẵn sàng hoạt động hay không.
 */
function isDriveConfigured() {
  const isEnabled = process.env.GOOGLE_DRIVE_ENABLED === 'true';
  const rootId = (process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim();
  const credsPath = path.resolve(process.env.GOOGLE_DRIVE_CREDENTIALS || './credentials/credentials.json');
  const tokenPath = path.resolve(process.env.GOOGLE_DRIVE_TOKEN || './credentials/token.json');

  if (!isEnabled) {
    return { enabled: false, reason: 'GOOGLE_DRIVE_ENABLED chưa được bật (false)' };
  }
  if (!rootId || rootId === 'xxxx') {
    return { enabled: false, reason: 'GOOGLE_DRIVE_ROOT_FOLDER_ID chưa được điền' };
  }
  if (!fs.existsSync(credsPath)) {
    return { enabled: false, reason: `Không tìm thấy file credentials tại: ${credsPath}` };
  }
  if (!fs.existsSync(tokenPath)) {
    return { enabled: false, reason: `Không tìm thấy file token tại: ${tokenPath}. Cần chạy: npm run drive:auth` };
  }

  // Kiểm tra nội dung token.json để tránh lỗi invalid_grant khi file vẫn chứa placeholder "xxxx"
  try {
    const tokenRaw = fs.readFileSync(tokenPath, 'utf8');
    const token = JSON.parse(tokenRaw);
    if (!token.refresh_token || token.refresh_token === 'xxxx') {
      return {
        enabled: false,
        reason: `File token.json chưa có refresh_token thật (vẫn là 'xxxx'). Bạn cần chạy lệnh: npm run drive:auth để xác thực và cấp quyền lần đầu.`,
      };
    }
  } catch (parseErr) {
    return { enabled: false, reason: `File token.json không hợp lệ. Vui lòng chạy lại: npm run drive:auth` };
  }

  return { enabled: true, rootId, credsPath, tokenPath };
}

/**
 * Khởi tạo OAuth2 Client và đối tượng Google Drive v3 client
 */
function getOAuth2Client() {
  const check = isDriveConfigured();
  if (!check.enabled) {
    throw new Error(`[GoogleDrive] Dịch vụ chưa sẵn sàng: ${check.reason}`);
  }

  const credentialsRaw = fs.readFileSync(check.credsPath, 'utf8');
  const credentials = JSON.parse(credentialsRaw);
  const clientConfig = credentials.installed || credentials.web;

  if (!clientConfig) {
    throw new Error('[GoogleDrive] File credentials.json không đúng định dạng (thiếu "installed" hoặc "web")');
  }

  const { client_id, client_secret, redirect_uris } = clientConfig;
  if (!client_id || !client_secret || client_id === 'xxxx') {
    throw new Error('[GoogleDrive] credentials.json chứa thông tin placeholder (xxxx), vui lòng cập nhật Client ID thật');
  }

  const redirectUri = (redirect_uris && redirect_uris[0]) || 'http://localhost:3000/oauth2callback';
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const tokenRaw = fs.readFileSync(check.tokenPath, 'utf8');
  const tokens = JSON.parse(tokenRaw);
  oauth2Client.setCredentials(tokens);

  // Lắng nghe sự kiện token được tự động làm mới (refresh) để ghi lại vào token.json
  oauth2Client.on('tokens', (newTokens) => {
    try {
      const merged = { ...tokens, ...newTokens };
      fs.writeFileSync(check.tokenPath, JSON.stringify(merged, null, 2));
      console.log('[GoogleDrive] 🔄 Đã tự động cập nhật access token mới vào file token.json');
    } catch (err) {
      console.warn('[GoogleDrive] ⚠️ Không thể ghi token mới vào đĩa:', err.message);
    }
  });

  return oauth2Client;
}

/**
 * Trả về instance của Drive v3
 */
function getDriveClient() {
  const auth = getOAuth2Client();
  return google.drive({ version: 'v3', auth });
}

/**
 * Tìm hoặc tạo một thư mục con dưới parentFolderId
 * @param {string} folderName - Tên thư mục cần tìm/tạo
 * @param {string} parentFolderId - ID thư mục cha
 * @returns {Promise<{ id: string, name: string, webViewLink: string }>}
 */
async function ensureFolder(folderName, parentFolderId) {
  const cleanName = String(folderName || '').trim().replace(/[/\\?%*:|"<>]/g, '_');
  const cacheKey = `${parentFolderId}::${cleanName}`;
  if (folderCache.has(cacheKey)) {
    return folderCache.get(cacheKey);
  }

  const drive = getDriveClient();

  // 1. Tìm thư mục đã tồn tại chưa
  const query = `'${parentFolderId}' in parents and name = '${cleanName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, webViewLink)',
    spaces: 'drive',
    pageSize: 1,
  });

  if (res.data.files && res.data.files.length > 0) {
    const existing = res.data.files[0];
    const result = {
      id: existing.id,
      name: existing.name,
      webViewLink: existing.webViewLink || `https://drive.google.com/drive/folders/${existing.id}`,
    };
    folderCache.set(cacheKey, result);
    return result;
  }

  // 2. Tạo thư mục mới nếu chưa có
  const createRes = await drive.files.create({
    requestBody: {
      name: cleanName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink',
  });

  const created = {
    id: createRes.data.id,
    name: createRes.data.name,
    webViewLink: createRes.data.webViewLink || `https://drive.google.com/drive/folders/${createRes.data.id}`,
  };

  folderCache.set(cacheKey, created);
  return created;
}

/**
 * Tạo cây thư mục lồng nhau theo mảng các phân đoạn đường dẫn.
 * Ví dụ: ['HiSale', 'VINHOMES GREEN PARADISE', 'ND11-58']
 * @param {Array<string>} pathSegments - Mảng các tên thư mục theo thứ tự
 * @param {string} [rootFolderId] - ID thư mục gốc (nếu không truyền sẽ lấy từ GOOGLE_DRIVE_ROOT_FOLDER_ID)
 * @returns {Promise<{ id: string, webViewLink: string, path: string }>}
 */
async function ensureFolderPath(pathSegments = [], rootFolderId = null) {
  const rootId = (rootFolderId || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim();
  if (!rootId) {
    throw new Error('[GoogleDrive] Thiếu GOOGLE_DRIVE_ROOT_FOLDER_ID');
  }

  let currentParentId = rootId;
  let currentFolder = null;

  for (const segment of pathSegments) {
    const segName = String(segment || '').trim();
    if (!segName) continue;
    currentFolder = await ensureFolder(segName, currentParentId);
    currentParentId = currentFolder.id;
  }

  return {
    id: currentParentId,
    webViewLink: currentFolder ? currentFolder.webViewLink : `https://drive.google.com/drive/folders/${currentParentId}`,
    path: pathSegments.join('/'),
  };
}

/**
 * Tải lên một file ảnh/tài liệu vào thư mục chỉ định trên Google Drive
 * @param {Object} params
 * @param {string} params.name - Tên file trên Drive (ví dụ: image_01.jpg)
 * @param {Buffer} params.buffer - Buffer dữ liệu file
 * @param {string} params.mimeType - MIME type (vd: 'image/jpeg', 'image/png')
 * @param {string} params.parentFolderId - ID thư mục cha
 * @param {string} [params.description] - Mô tả tóm tắt file
 * @returns {Promise<{ id: string, name: string, webViewLink: string, webContentLink: string, size: number }>}
 */
async function uploadFile({ name, buffer, mimeType, parentFolderId, description = '' }) {
  const drive = getDriveClient();
  const cleanName = String(name || 'image.jpg').trim().replace(/[/\\?%*:|"<>]/g, '_');

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const res = await drive.files.create({
    requestBody: {
      name: cleanName,
      parents: [parentFolderId],
      description,
    },
    media: {
      mimeType: mimeType || 'image/jpeg',
      body: stream,
    },
    fields: 'id, name, mimeType, size, webViewLink, webContentLink',
  });

  const file = res.data;
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: Number(file.size) || buffer.length,
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    webContentLink: file.webContentLink || `https://drive.google.com/uc?id=${file.id}&export=download`,
  };
}

/**
 * Tạo một thư mục tổng mới ở thư mục gốc Google Drive của tài khoản
 * @param {string} folderName - Tên thư mục tổng
 * @returns {Promise<{ id: string, name: string, webViewLink: string }>}
 */
async function createRootFolder(folderName = 'Real_Estate_Crawler_V2') {
  const drive = getDriveClient();
  const cleanName = String(folderName || 'Real_Estate_Crawler_V2').trim();

  const res = await drive.files.create({
    requestBody: {
      name: cleanName,
      mimeType: 'application/vnd.google-apps.folder',
      description: 'Thư mục tổng lưu trữ rổ hàng Bất động sản tạo tự động bởi Crawler Bot',
    },
    fields: 'id, name, webViewLink',
  });

  return {
    id: res.data.id,
    name: res.data.name,
    webViewLink: res.data.webViewLink || `https://drive.google.com/drive/folders/${res.data.id}`,
  };
}

/**
 * Xóa cache thư mục (hữu ích khi test hoặc reset)
 */
function clearFolderCache() {
  folderCache.clear();
}

module.exports = {
  isDriveConfigured,
  getOAuth2Client,
  getDriveClient,
  ensureFolder,
  ensureFolderPath,
  createRootFolder,
  uploadFile,
  clearFolderCache,
};
