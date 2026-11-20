const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { google } = require('googleapis');

// Cache bộ nhớ lưu các thư mục đã tìm/tạo để tránh spam API queries lên Google Drive
const folderCache = new Map();
// In-flight promises để ngăn chặn race condition khi nhiều luồng cùng tạo 1 thư mục đồng thời
const folderCreationPromises = new Map();

/**
 * Chuẩn hóa tên thư mục/tập tin Google Drive:
 * - Chuẩn hóa unicode NFC
 * - Loại bỏ ký tự cấm: / \ ? % * : | " < > và ký tự điều khiển
 * - Thu gọn khoảng trắng liên tiếp
 * - Cắt ngắn tối đa 120 ký tự
 */
function sanitizeDriveName(name) {
  if (!name || typeof name !== 'string') return 'Unnamed';
  const clean = name
    .normalize('NFC')
    .replace(/[/\\?%*:|"<>]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 120) || 'Unnamed';
}

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
 * Thực thi hàm gọi Drive API có retry khi gặp lỗi 429 hoặc 5xx
 */
async function callWithRetry(apiFn, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await apiFn();
    } catch (err) {
      attempt++;
      const status = err.status || (err.response && err.response.status) || err.code;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (attempt >= maxRetries || !isRetryable) {
        throw err;
      }
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

/**
 * Kiểm tra xem một Folder hoặc File ID trên Drive còn tồn tại và không bị xóa vào thùng rác hay không.
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
async function verifyDriveItemExists(fileId) {
  if (!fileId || typeof fileId !== 'string') return false;
  try {
    const drive = getDriveClient();
    const res = await callWithRetry(() =>
      drive.files.get({
        fileId: fileId.trim(),
        fields: 'id, trashed, name',
      })
    );
    return Boolean(res.data && !res.data.trashed);
  } catch (err) {
    const status = err.status || (err.response && err.response.status) || err.code;
    if (status === 404 || status === '404') {
      return false;
    }
    // Nếu lỗi mạng tạm thời thì không vội phán đoán là đã xóa
    return true;
  }
}

/**
 * Tìm hoặc tạo một thư mục con dưới parentFolderId (chống race-condition với Promise Mutex)
 * @param {string} folderName - Tên thư mục cần tìm/tạo
 * @param {string} parentFolderId - ID thư mục cha
 * @returns {Promise<{ id: string, name: string, webViewLink: string }>}
 */
async function ensureFolder(folderName, parentFolderId) {
  const cleanName = sanitizeDriveName(folderName);
  const cacheKey = `${parentFolderId}::${cleanName}`;

  if (folderCache.has(cacheKey)) {
    return folderCache.get(cacheKey);
  }

  // Nếu đang có một luồng khác tạo đúng thư mục này, cùng đợi Promise đó hoàn thành
  if (folderCreationPromises.has(cacheKey)) {
    return folderCreationPromises.get(cacheKey);
  }

  const creationPromise = (async () => {
    const drive = getDriveClient();

    // 1. Tìm thư mục đã tồn tại dưới parentFolderId chưa
    const query = `'${parentFolderId}' in parents and name = '${cleanName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const res = await callWithRetry(() =>
      drive.files.list({
        q: query,
        fields: 'files(id, name, webViewLink)',
        spaces: 'drive',
        pageSize: 1,
      })
    );

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
    const createRes = await callWithRetry(() =>
      drive.files.create({
        requestBody: {
          name: cleanName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentFolderId],
        },
        fields: 'id, name, webViewLink',
      })
    );

    const created = {
      id: createRes.data.id,
      name: createRes.data.name,
      webViewLink: createRes.data.webViewLink || `https://drive.google.com/drive/folders/${createRes.data.id}`,
    };

    folderCache.set(cacheKey, created);
    return created;
  })();

  folderCreationPromises.set(cacheKey, creationPromise);

  try {
    return await creationPromise;
  } finally {
    folderCreationPromises.delete(cacheKey);
  }
}

/**
 * Tạo cây thư mục lồng nhau theo mảng các phân đoạn đường dẫn.
 * Ví dụ: ['HiSale', 'Cao_tang', 'THE CITYON', 'A2.1009']
 * @param {Array<string>} pathSegments - Mảng các tên thư mục theo thứ tự
 * @param {string} [rootFolderId] - ID thư mục gốc
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
  const cleanName = sanitizeDriveName(name || 'image.jpg');

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const res = await callWithRetry(() =>
    drive.files.create({
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
    })
  );

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
async function createRootFolder(folderName = 'Real_Estate_Crawler_Test') {
  const drive = getDriveClient();
  const cleanName = sanitizeDriveName(folderName || 'Real_Estate_Crawler_Test');

  const res = await callWithRetry(() =>
    drive.files.create({
      requestBody: {
        name: cleanName,
        mimeType: 'application/vnd.google-apps.folder',
        description: 'Thư mục tổng lưu trữ rổ hàng Bất động sản tạo tự động bởi Crawler Bot',
      },
      fields: 'id, name, webViewLink',
    })
  );

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
  folderCreationPromises.clear();
}

module.exports = {
  isDriveConfigured,
  getOAuth2Client,
  getDriveClient,
  verifyDriveItemExists,
  sanitizeDriveName,
  ensureFolder,
  ensureFolderPath,
  createRootFolder,
  uploadFile,
  clearFolderCache,
};
