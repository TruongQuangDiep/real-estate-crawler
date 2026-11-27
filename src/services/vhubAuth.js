const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '../../.vhub_session.json');
const DEFAULT_API_URL = 'https://api.vhub.com.vn';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Lấy base URL của VHub API từ biến môi trường hoặc mặc định
 */
function getVhubApiBaseUrl() {
  return (process.env.VHUB_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, '');
}

/**
 * Giải mã phần payload của JWT để kiểm tra thời gian hết hạn (exp)
 */
function isJwtValid(token, bufferSeconds = 60) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    if (!payload.exp) return true;
    const nowSec = Math.floor(Date.now() / 1000);
    return payload.exp > nowSec + bufferSeconds;
  } catch {
    return false;
  }
}

/**
 * Đọc session VHub đã lưu trong file cache (.vhub_session.json)
 */
function getCachedVhubSession() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (data && data.accessToken) {
        return data;
      }
    } catch {
      // Bỏ qua lỗi đọc cache
    }
  }

  if (process.env.VHUB_ACCESS_TOKEN) {
    return {
      accessToken: process.env.VHUB_ACCESS_TOKEN.trim(),
      refreshToken: (process.env.VHUB_REFRESH_TOKEN || '').trim(),
      deviceId: crypto.randomUUID(),
    };
  }

  return null;
}

/**
 * Lưu session VHub mới xuống đĩa để tái sử dụng giữa các lần chạy
 */
function saveCachedVhubSession(sessionData) {
  try {
    const payload = {
      accessToken: sessionData.accessToken,
      refreshToken: sessionData.refreshToken || '',
      deviceId: sessionData.deviceId || crypto.randomUUID(),
      user: sessionData.user
        ? {
            id: sessionData.user.id,
            email: sessionData.user.email,
            displayName: sessionData.user.displayName,
            role: sessionData.user.role,
          }
        : null,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log('[VHub Auth] 💾 Đã lưu session mới vào .vhub_session.json');
  } catch (err) {
    console.warn('[VHub Auth] Không thể ghi file session cache:', err.message);
  }
}

/**
 * Làm mới accessToken bằng refreshToken qua POST /auth/refresh
 */
async function refreshVhubSession(cachedSession) {
  if (!cachedSession || !cachedSession.refreshToken) {
    return null;
  }

  const baseURL = getVhubApiBaseUrl();
  const deviceId = cachedSession.deviceId || crypto.randomUUID();

  try {
    const res = await axios.post(
      `${baseURL}/auth/refresh`,
      {
        refreshToken: cachedSession.refreshToken,
        deviceId,
      },
      {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: 'https://vhub.com.vn',
          Referer: 'https://vhub.com.vn/',
          'User-Agent': DEFAULT_USER_AGENT,
        },
      }
    );

    const data = res.data?.data ?? res.data;
    if (data && data.accessToken) {
      const updated = {
        ...cachedSession,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || cachedSession.refreshToken,
        deviceId,
      };
      saveCachedVhubSession(updated);
      console.log('[VHub Auth] 🔄 Đã tự động làm mới accessToken thành công.');
      return updated;
    }
  } catch (err) {
    console.warn('[VHub Auth] ⚠️ Refresh token thất bại, sẽ đăng nhập lại:', err.message);
  }

  return null;
}

/**
 * Tự động đăng nhập VHub 360 qua POST /auth/login bằng Email/SĐT và Mật khẩu
 */
async function loginVhub(
  identifier = process.env.VHUB_EMAIL,
  password = process.env.VHUB_PASSWORD
) {
  if (!identifier || !password) {
    throw new Error('Chưa cấu hình VHUB_EMAIL hoặc VHUB_PASSWORD trong file .env');
  }

  const baseURL = getVhubApiBaseUrl();
  const deviceId = crypto.randomUUID();

  console.log(`[VHub Auth] 🔑 Đang tự động đăng nhập VHub tài khoản: ${identifier}...`);

  const res = await axios.post(
    `${baseURL}/auth/login`,
    {
      identifier: String(identifier).trim(),
      password: String(password),
      deviceId,
      deviceName: 'Windows · Chrome',
    },
    {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://vhub.com.vn',
        Referer: 'https://vhub.com.vn/',
        'User-Agent': DEFAULT_USER_AGENT,
      },
    }
  );

  const payload = res.data?.data ?? res.data;
  if (!payload || !payload.accessToken) {
    const errMsg = res.data?.message || 'Phản hồi đăng nhập không chứa accessToken';
    throw new Error(`Đăng nhập VHub thất bại: ${errMsg}`);
  }

  const session = {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken || '',
    deviceId,
    user: payload.user || null,
  };

  saveCachedVhubSession(session);
  console.log(
    `[VHub Auth] ✅ Đăng nhập thành công! (${session.user?.displayName || identifier} - Role: ${session.user?.role || 'user'})`
  );
  return session;
}

/**
 * Lấy session hợp lệ cho VHub (Ưu tiên cache còn hạn -> Refresh token -> Login mới)
 */
async function getVhubSession(forceRefresh = false) {
  const cached = getCachedVhubSession();

  if (!forceRefresh && cached && isJwtValid(cached.accessToken)) {
    return cached;
  }

  if (cached && cached.refreshToken) {
    const refreshed = await refreshVhubSession(cached);
    if (refreshed) return refreshed;
  }

  return await loginVhub();
}

module.exports = {
  getVhubApiBaseUrl,
  getVhubSession,
  loginVhub,
  refreshVhubSession,
  isJwtValid,
};
