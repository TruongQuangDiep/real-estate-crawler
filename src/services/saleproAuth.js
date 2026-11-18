const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '../../.salepro_session.json');
const SALEPRO_LOGIN_URL = 'https://salepro.com/api/rest_api/pu/property/auth/login';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';

/**
 * Chuẩn hóa chuỗi Bearer token
 */
function normalizeBearerToken(rawToken = '') {
  const token = String(rawToken || '').trim();
  if (!token) return '';
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

/**
 * Gộp cookie cũ với các header Set-Cookie mới trả về từ server (giữ lại cf_clearance nếu có)
 */
function mergeCookieStrings(existingCookie = '', setCookieHeaders = []) {
  const cookieMap = new Map();

  String(existingCookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        cookieMap.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    });

  if (Array.isArray(setCookieHeaders)) {
    setCookieHeaders.forEach((item) => {
      const firstPart = String(item || '').split(';')[0].trim();
      const idx = firstPart.indexOf('=');
      if (idx > 0) {
        cookieMap.set(firstPart.slice(0, idx).trim(), firstPart.slice(idx + 1).trim());
      }
    });
  }

  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Kiểm tra hạn sử dụng token (trả về true nếu đã hết hạn hoặc sắp hết hạn)
 */
function isSessionExpired(expiresAt) {
  if (!expiresAt) return false;
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return false;
  return Date.now() >= expiryMs - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Đọc session SalePro từ file cache hoặc .env.
 * Nếu user mới cập nhật SALEPRO_AUTH_TOKEN / SALEPRO_COOKIE trong .env,
 * giá trị mới trong .env sẽ được ưu tiên hơn cache cũ.
 */
function getCachedSaleProSession() {
  const envToken = normalizeBearerToken(process.env.SALEPRO_AUTH_TOKEN || '');
  const envCookie = (process.env.SALEPRO_COOKIE || '').trim();

  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      const envChanged =
        (envToken && cached.sourceEnvToken && cached.sourceEnvToken !== envToken) ||
        (envCookie && cached.sourceEnvCookie && cached.sourceEnvCookie !== envCookie);

      if (!envChanged && cached && (cached.authToken || cached.cookie)) {
        return {
          authToken: normalizeBearerToken(cached.authToken || envToken),
          cookie: cached.cookie || envCookie,
          expiresAt: cached.expiresAt || null
        };
      }
    } catch (e) {
      // Bỏ qua lỗi đọc file cache
    }
  }

  return {
    authToken: envToken,
    cookie: envCookie,
    expiresAt: null
  };
}

/**
 * Lưu session SalePro mới vào file cache
 */
function saveCachedSaleProSession(authToken, cookie, extra = {}) {
  try {
    const normalizedToken = normalizeBearerToken(authToken);
    const data = {
      authToken: normalizedToken,
      cookie: (cookie || '').trim(),
      uid: extra.uid || null,
      expiresAt: extra.expiresAt || null,
      sourceEnvToken: normalizeBearerToken(process.env.SALEPRO_AUTH_TOKEN || ''),
      sourceEnvCookie: (process.env.SALEPRO_COOKIE || '').trim(),
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[SalePro Auth] 💾 Đã lưu session mới vào .salepro_session.json');
  } catch (err) {
    console.warn('[SalePro Auth] Không thể ghi file session cache:', err.message);
  }
}

/**
 * Đăng nhập SalePro bằng email/mật khẩu qua POST /api/rest_api/pu/property/auth/login
 */
async function loginSalePro(
  email = process.env.SALEPRO_EMAIL,
  password = process.env.SALEPRO_PASSWORD
) {
  if (!email || !password) {
    const cfgError = new Error('Chưa cấu hình SALEPRO_EMAIL hoặc SALEPRO_PASSWORD trong .env');
    cfgError.isAuthError = true;
    throw cfgError;
  }

  console.log(`[SalePro Auth] 🔑 Đang đăng nhập SalePro với tài khoản: ${email}...`);

  const cached = getCachedSaleProSession();
  const baseCookie = cached.cookie || (process.env.SALEPRO_COOKIE || '').trim();
  const userAgent = process.env.SALEPRO_USER_AGENT || DEFAULT_USER_AGENT;

  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'vi',
    'content-type': 'application/json',
    origin: 'https://salepro.com',
    referer: 'https://salepro.com/sign-in',
    'user-agent': userAgent
  };

  if (baseCookie) {
    headers.cookie = baseCookie;
  }

  let res;
  try {
    res = await axios.post(
      SALEPRO_LOGIN_URL,
      {
        login: email,
        password
      },
      {
        headers,
        timeout: 20000,
        validateStatus: (status) => status >= 200 && status < 500
      }
    );
  } catch (err) {
    const netError = new Error(`[SalePro Auth] Lỗi kết nối khi đăng nhập: ${err.message}`);
    netError.isAuthError = true;
    throw netError;
  }

  // Kiểm tra trường hợp bị Cloudflare chặn (403 HTML challenge)
  if (
    res.status === 403 &&
    typeof res.data === 'string' &&
    (res.data.includes('cf-') || res.data.toLowerCase().includes('cloudflare'))
  ) {
    const cfError = new Error(
      '[SalePro Auth] Cloudflare từ chối request (cookie cf_clearance có thể đã hết hạn). Hãy copy cookie cf_clearance mới từ trình duyệt vào SALEPRO_COOKIE trong .env.'
    );
    cfError.isAuthError = true;
    throw cfError;
  }

  if (
    res.status >= 400 ||
    !res.data ||
    res.data.code !== 1 ||
    !res.data.data ||
    !res.data.data.access_token
  ) {
    const detail = typeof res.data === 'string' ? res.data.slice(0, 250) : JSON.stringify(res.data);
    const authError = new Error(`[SalePro Auth] Đăng nhập thất bại (HTTP ${res.status}): ${detail}`);
    authError.isAuthError = true;
    throw authError;
  }

  const payload = res.data.data;
  const authToken = normalizeBearerToken(payload.access_token);
  const mergedCookie = mergeCookieStrings(baseCookie, res.headers && res.headers['set-cookie']);

  saveCachedSaleProSession(authToken, mergedCookie, {
    uid: payload.uid,
    expiresAt: payload.expires_in || null
  });

  console.log(
    `[SalePro Auth] ✅ Đăng nhập thành công (uid: ${payload.uid || '?'}${payload.expires_in ? `, hết hạn: ${payload.expires_in}` : ''}).`
  );

  return {
    authToken,
    cookie: mergedCookie,
    expiresAt: payload.expires_in || null,
    email
  };
}

/**
 * Lấy session SalePro hợp lệ (tự động login lại nếu thiếu token hoặc token đã hết hạn)
 */
async function getSaleProSession() {
  const email = (process.env.SALEPRO_EMAIL || '').trim();
  const password = (process.env.SALEPRO_PASSWORD || '').trim();
  const session = getCachedSaleProSession();

  const needsLogin = !session.authToken || isSessionExpired(session.expiresAt);
  if (needsLogin) {
    if (email && password) {
      return await loginSalePro(email, password);
    }
    console.warn(
      '[SalePro Auth] ⚠️ Chưa có SALEPRO_AUTH_TOKEN hợp lệ và cũng chưa cấu hình SALEPRO_EMAIL / SALEPRO_PASSWORD.'
    );
  }

  return {
    authToken: session.authToken,
    cookie: session.cookie,
    expiresAt: session.expiresAt,
    email
  };
}

/**
 * Tạo bộ headers chuẩn cho request SalePro
 */
function buildSaleProHeaders(session = {}, referer = 'https://salepro.com/project-page') {
  const userAgent = process.env.SALEPRO_USER_AGENT || DEFAULT_USER_AGENT;

  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'vi',
    referer,
    'user-agent': userAgent
  };

  if (session.authToken) {
    headers.authorization = normalizeBearerToken(session.authToken);
  }
  if (session.cookie) {
    headers.cookie = session.cookie;
  }

  return headers;
}

module.exports = {
  getCachedSaleProSession,
  saveCachedSaleProSession,
  getSaleProSession,
  loginSalePro,
  buildSaleProHeaders,
  DEFAULT_USER_AGENT
};
