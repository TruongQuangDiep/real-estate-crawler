const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '../../.hisale_session.json');

/**
 * Đọc session đã lưu trong file cache hoặc file .env
 */
function getCachedSession() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (data && data.cookie) {
        return data;
      }
    } catch (e) {
      // Bỏ qua lỗi đọc file
    }
  }

  // Nếu không có file cache, dùng cookie từ .env
  if (process.env.HISALE_COOKIE) {
    return {
      cookie: process.env.HISALE_COOKIE,
      xsrfToken: process.env.HISALE_XSRF_TOKEN || ''
    };
  }

  return null;
}

/**
 * Lưu session mới vào file cache để lần sau dùng tiếp
 */
function saveCachedSession(cookie, xsrfToken) {
  try {
    const data = {
      cookie,
      xsrfToken,
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[HiSale Auth] 💾 Đã lưu session mới vào .hisale_session.json');
  } catch (err) {
    console.warn('[HiSale Auth] Không thể ghi file session cache:', err.message);
  }
}

/**
 * Phân tích header Set-Cookie trả về từ axios và gộp với cookie cũ (nếu có)
 */
function parseSetCookies(setCookieHeaders, existingCookies = {}) {
  const cookies = { ...existingCookies };

  if (Array.isArray(setCookieHeaders)) {
    setCookieHeaders.forEach((item) => {
      const firstPair = String(item).split(';')[0];
      const eqIdx = firstPair.indexOf('=');
      if (eqIdx === -1) return;
      const name = firstPair.slice(0, eqIdx).trim();
      const value = firstPair.slice(eqIdx + 1).trim();
      if (name) {
        cookies[name] = value;
      }
    });
  }

  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  // XSRF-TOKEN cần decodeURIComponent nếu mang đi gán vào header x-xsrf-token
  const rawXsrf = cookies['XSRF-TOKEN'] || '';
  let xsrfToken = rawXsrf;
  try {
    xsrfToken = decodeURIComponent(rawXsrf);
  } catch (e) {}

  return { cookies, cookieStr, xsrfToken };
}

/**
 * Tự động đăng nhập vào HiSale bằng tài khoản & mật khẩu
 */
async function loginHisale(phone = process.env.HISALE_PHONE, password = process.env.HISALE_PASSWORD) {
  if (!phone || !password) {
    throw new Error('Chưa cấu hình HISALE_PHONE hoặc HISALE_PASSWORD trong .env');
  }

  console.log(`[HiSale Auth] 🔑 Đang tự động đăng nhập tài khoản: ${phone}...`);

  const client = axios.create({
    baseURL: 'https://www.hisale.com',
    timeout: 15000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*'
    },
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400
  });

  // Bước 1: Gọi trang chủ / login để lấy XSRF-TOKEN và hisale_session khởi tạo
  const initRes = await client.get('/');
  const initialCookies = parseSetCookies(initRes.headers['set-cookie']);

  // Bước 2: Gửi POST /login (maxRedirects: 0 để bắt trọn Set-Cookie nếu Laravel trả 302)
  const loginRes = await client.post(
    '/login',
    {
      phone: phone,
      password: password,
      remember: true
    },
    {
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/json',
        Cookie: initialCookies.cookieStr,
        'X-XSRF-TOKEN': initialCookies.xsrfToken,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://www.hisale.com/login'
      }
    }
  );

  // Kiểm tra trường hợp 302 đẩy ngược lại /login (sai mật khẩu hoặc session/CSRF không hợp lệ)
  const redirectLocation = loginRes.headers && loginRes.headers.location ? String(loginRes.headers.location) : '';
  if (loginRes.status >= 300 && redirectLocation.includes('/login')) {
    throw new Error('Đăng nhập HiSale thất bại (redirect ngược về /login). Kiểm tra lại HISALE_PHONE / HISALE_PASSWORD.');
  }

  // Bước 3: Gộp cookie cũ + cookie mới sau khi login thành công
  const merged = parseSetCookies(loginRes.headers['set-cookie'], initialCookies.cookies);
  const finalCookie = merged.cookieStr || initialCookies.cookieStr;
  const finalXsrf = merged.xsrfToken || initialCookies.xsrfToken;

  saveCachedSession(finalCookie, finalXsrf);
  console.log('[HiSale Auth] ✅ Đăng nhập tự động thành công!');

  return {
    cookie: finalCookie,
    xsrfToken: finalXsrf
  };
}

/**
 * Lấy session hợp lệ: ưu tiên cache, nếu không có hoặc hết hạn thì tự login
 */
async function getHisaleSession(forceRelogin = false) {
  if (!forceRelogin) {
    const cached = getCachedSession();
    if (cached && cached.cookie) {
      return cached;
    }
  }

  // Tự động login nếu chưa có cookie hoặc bị yêu cầu relogin
  return await loginHisale();
}

module.exports = {
  getHisaleSession,
  loginHisale,
  saveCachedSession
};
