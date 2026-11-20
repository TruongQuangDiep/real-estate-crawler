const crypto = require('crypto');
const axios = require('axios');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const {
  isDriveConfigured,
  ensureFolderPath,
  uploadFile,
  verifyDriveItemExists,
  sanitizeDriveName,
} = require('./googleDriveService');

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_SIZE_MB = 20;
const DEFAULT_MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 20000;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000; // Khóa xử lý 15 phút

let isSyncRunning = false;

// Danh sách các domain cho phép tải ảnh (SSRF Protection)
const ALLOWED_DOMAINS = [
  'hisale.vn',
  'hisale.com',
  'salepro.com',
  'fptcloud.com',
  'amazonaws.com',
  'cloudfront.net',
  'googleusercontent.com',
  'googleapis.com',
  'drive.google.com',
];

/**
 * Loại bỏ dấu tiếng Việt chuẩn xác (xử lý cả chữ Đ/đ và ký tự có dấu)
 */
function removeVietnameseTones(str) {
  if (!str) return '';
  return String(str)
    .replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, 'a')
    .replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, 'e')
    .replace(/ì|í|ị|ỉ|ĩ/g, 'i')
    .replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, 'o')
    .replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, 'u')
    .replace(/ỳ|ý|ỵ|ỷ|ỹ/g, 'y')
    .replace(/đ/g, 'd')
    .replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, 'A')
    .replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, 'E')
    .replace(/Ì|Í|Ị|Ỉ|Ĩ/g, 'I')
    .replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, 'O')
    .replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, 'U')
    .replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, 'Y')
    .replace(/Đ/g, 'D');
}

/**
 * Phân loại danh mục thư mục con cho Layout thiết kế theo chuẩn V3
 */
function getLayoutCategoryFolder(rawName = '') {
  const norm = removeVietnameseTones(rawName).toLowerCase().trim();

  // Studio
  if (norm.includes('studio')) return 'Studio';

  // 1PN+ / 1PN Plus
  if (
    norm.includes('1pn+') ||
    norm.includes('1pn +') ||
    norm.includes('1pn plus') ||
    norm.includes('1 phong ngu +') ||
    norm.includes('1 phong ngu+')
  ) {
    return '1PN_Plus';
  }
  // 1PN
  if (norm.includes('1pn') || norm.includes('1 phong ngu')) {
    return '1PN';
  }

  // 2PN+ / 2PN Plus
  if (
    norm.includes('2pn+') ||
    norm.includes('2pn +') ||
    norm.includes('2pn plus') ||
    norm.includes('2 phong ngu +') ||
    norm.includes('2 phong ngu+')
  ) {
    return '2PN_Plus';
  }
  // 2PN
  if (norm.includes('2pn') || norm.includes('2 phong ngu')) {
    return '2PN';
  }

  // 3PN+ / 3PN Plus
  if (
    norm.includes('3pn+') ||
    norm.includes('3pn +') ||
    norm.includes('3pn plus') ||
    norm.includes('3 phong ngu +') ||
    norm.includes('3 phong ngu+')
  ) {
    return '3PN_Plus';
  }
  // 3PN
  if (norm.includes('3pn') || norm.includes('3 phong ngu')) {
    return '3PN';
  }

  // 4PN
  if (norm.includes('4pn') || norm.includes('4 phong ngu')) {
    return '4PN';
  }

  // Duplex & Penthouse
  if (norm.includes('duplex')) return 'Duplex';
  if (norm.includes('penthouse')) return 'Penthouse';

  // Thấp tầng: Biệt thự đơn lập
  if (norm.includes('don lap')) return 'Biet_thu_don_lap';
  // Biệt thự song lập
  if (norm.includes('song lap')) return 'Biet_thu_song_lap';
  // Biệt thự tứ lập
  if (norm.includes('tu lap')) return 'Biet_thu_tu_lap';
  // Biệt thự nói chung
  if (norm.includes('biet thu')) return 'Biet_thu';

  // Liền kề / Nhà phố
  if (norm.includes('lien ke') || norm.includes('nha pho')) return 'Lien_ke';

  // Shophouse / TMDV
  if (norm.includes('shophouse') || norm.includes('tmdv') || norm.includes('thuong mai')) return 'Shophouse';

  // Clean slug fallback
  const clean = rawName
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return clean || 'Khac';
}

/**
 * Phân loại tài liệu dự án SalePro
 */
function classifySaleProDocument(title = '', url = '') {
  const text = `${title} ${url}`.toLowerCase();
  const norm = removeVietnameseTones(text);

  if (norm.includes('bang gia') || norm.includes('gia min') || norm.includes('price')) return 'BANG_GIA';
  if (norm.includes('csbh') || norm.includes('chinh sach') || norm.includes('policy')) return 'CSBH';
  if (norm.includes('layout') || norm.includes('mat bang') || norm.includes('thiet ke')) return 'LAYOUT';
  if (norm.includes('phap ly') || norm.includes('legal')) return 'PHAP_LY';
  if (norm.includes('bieu mau') || norm.includes('dat coc') || norm.includes('form') || norm.includes('hop dong')) {
    return 'BIEU_MAU';
  }
  return 'OTHER';
}

/**
 * Trích xuất khoảng diện tích từ chuỗi mô tả (ví dụ: "Diện tích: 62.66m² - 62.91m²")
 */
function extractAreaRange(featuresStr = '') {
  if (!featuresStr) return null;
  const matches = featuresStr.match(/(\d+(?:[.,]\d+)?)\s*(?:m²|m2)?\s*[-–~≈]\s*(\d+(?:[.,]\d+)?)/i);
  if (matches) {
    const min = parseFloat(matches[1].replace(',', '.'));
    const max = parseFloat(matches[2].replace(',', '.'));
    return { min, max };
  }
  const single = featuresStr.match(/(\d+(?:[.,]\d+)?)\s*(?:m²|m2)/i);
  if (single) {
    const val = parseFloat(single[1].replace(',', '.'));
    return { min: val, max: val };
  }
  return null;
}

/**
 * Liên kết một căn Unit với danh sách product_layouts theo 3 mức độ (EXACT, TYPE_MATCH, UNMATCHED)
 */
function matchUnitWithProductLayouts(unit, productLayouts = []) {
  if (!unit || !productLayouts || productLayouts.length === 0) {
    return { matchLevel: 'UNMATCHED', matchedLayout: null, label: '' };
  }

  const rawUnitType = unit.unit_type || unit.raw_data?.apartment_type_name || unit.raw_data?.product_name || '';
  const unitCategory = getLayoutCategoryFolder(rawUnitType);

  if (unitCategory === 'Khac' && !rawUnitType) {
    return { matchLevel: 'UNMATCHED', matchedLayout: null, label: '' };
  }

  // 1. Tìm layout có category khớp chính xác
  let candidates = productLayouts.filter((p) => p.category === unitCategory);

  // Nếu không khớp category, thử tìm qua tên tương đối
  if (candidates.length === 0) {
    const normUnitType = removeVietnameseTones(rawUnitType).toLowerCase();
    candidates = productLayouts.filter((p) => {
      const normProd = removeVietnameseTones(p.product_name).toLowerCase();
      return normProd.includes(normUnitType) || normUnitType.includes(normProd);
    });
  }

  if (candidates.length === 0) {
    return { matchLevel: 'UNMATCHED', matchedLayout: null, label: '' };
  }

  // 2. Nếu có nhiều candidates, thử đối chiếu chi tiết theo phong cách hoặc diện tích
  let bestCandidate = candidates[0];
  let isExact = false;

  const unitArea =
    unit.area_build || unit.area_land || unit.raw_data?.built_up_area || unit.raw_data?.carpet_area || 0;

  for (const cand of candidates) {
    // Kiểm tra tên phong cách (ví dụ "Địa Trung Hải", "Tân Cổ Điển")
    const candNorm = removeVietnameseTones(cand.product_name).toLowerCase();
    const unitFullText = removeVietnameseTones(
      `${unit.unit_code} ${unit.subdivision} ${rawUnitType} ${JSON.stringify(unit.raw_data || {})}`
    ).toLowerCase();

    if (candNorm.length > 5 && unitFullText.includes(candNorm)) {
      bestCandidate = cand;
      isExact = true;
      break;
    }

    // Kiểm tra diện tích
    if (unitArea > 0 && cand.features) {
      const range = extractAreaRange(cand.features);
      if (range) {
        if (unitArea >= range.min - 2 && unitArea <= range.max + 2) {
          bestCandidate = cand;
          isExact = true;
          break;
        }
      }
    }
  }

  // Nếu chỉ có 1 candidate duy nhất trong dự án cho loại căn này (vd: Studio chỉ có 1 layout Studio)
  if (candidates.length === 1) {
    if (unitArea > 0 && bestCandidate.features) {
      const range = extractAreaRange(bestCandidate.features);
      if (range && unitArea >= range.min - 3 && unitArea <= range.max + 3) {
        isExact = true;
      }
    } else {
      isExact = true;
    }
  }

  const matchLevel = isExact ? 'EXACT' : 'TYPE_MATCH';
  const label = isExact
    ? `Layout ${bestCandidate.product_name} (Chính xác)`
    : `Layout ${bestCandidate.product_name} (Tham khảo)`;

  return {
    matchLevel,
    matchedLayout: bestCandidate,
    label,
  };
}

/**
 * Kiểm tra tính an toàn của URL và ngăn chặn tấn công SSRF
 */
function validateSafeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('URL rỗng hoặc không đúng định dạng');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`URL không hợp lệ: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Giao thức không được phép: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Chặn localhost, loopback, private IP, link-local, cloud metadata
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '169.254.169.254' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
  ) {
    throw new Error(`Từ chối truy cập địa chỉ IP nội bộ / private (SSRF block): ${hostname}`);
  }

  const isAllowed = ALLOWED_DOMAINS.some(
    (allowed) => hostname === allowed || hostname.endsWith('.' + allowed)
  );

  if (!isAllowed) {
    throw new Error(`Hostname [${hostname}] không nằm trong danh sách nguồn ảnh được phép truy cập`);
  }

  return parsed.href;
}

/**
 * Tính mã băm SHA-256 từ buffer dữ liệu file
 */
function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Kiểm tra chữ ký nhị phân (Magic Bytes) và Content-Type của file
 */
function detectBufferFormat(buffer, contentType = '', url = '') {
  if (!buffer || buffer.length < 4) {
    throw new Error('Dữ liệu tải về quá ngắn hoặc rỗng, không phải file hợp lệ');
  }

  // 1. Kiểm tra nếu là HTML / Text / JSON báo lỗi
  const prefixStr = buffer.slice(0, Math.min(buffer.length, 300)).toString('utf8').trim().toLowerCase();
  const cleanHeader = String(contentType).toLowerCase();

  if (
    cleanHeader.includes('text/html') ||
    cleanHeader.includes('application/json') ||
    cleanHeader.includes('text/plain') ||
    prefixStr.startsWith('<!doctype html') ||
    prefixStr.startsWith('<html') ||
    prefixStr.startsWith('<?xml') ||
    prefixStr.startsWith('{')
  ) {
    throw new Error('Dữ liệu trả về là trang HTML / Text lỗi, không phải file ảnh hoặc tài liệu');
  }

  // 2. Nhận diện định dạng qua Magic Bytes
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', ext: 'png' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }

  // GIF: GIF87a hoặc GIF89a
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return { mimeType: 'image/gif', ext: 'gif' };
  }

  // WEBP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }

  // PDF: %PDF-
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return { mimeType: 'application/pdf', ext: 'pdf' };
  }

  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mimeType: 'image/bmp', ext: 'bmp' };
  }

  if (cleanHeader.includes('image/png') || url.toLowerCase().endsWith('.png')) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (cleanHeader.includes('image/webp') || url.toLowerCase().endsWith('.webp')) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  if (cleanHeader.includes('image/jpeg') || url.toLowerCase().endsWith('.jpg') || url.toLowerCase().endsWith('.jpeg')) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }
  if (cleanHeader.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
    return { mimeType: 'application/pdf', ext: 'pdf' };
  }

  throw new Error(`Định dạng dữ liệu không xác định hoặc không được hỗ trợ (MIME: ${contentType})`);
}

/**
 * Tải file an toàn từ URL kèm cơ chế retry, backoff, giới hạn dung lượng và chống SSRF
 */
async function downloadBufferWithRetry(rawUrl, maxRetries = DEFAULT_MAX_RETRIES) {
  const safeUrl = validateSafeUrl(rawUrl);
  const maxBytes = (Number(process.env.IMAGE_MAX_SIZE_MB) || DEFAULT_MAX_SIZE_MB) * 1024 * 1024;
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      const response = await axios.get(safeUrl, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxContentLength: maxBytes,
        maxRedirects: 5,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });

      const buffer = Buffer.from(response.data);
      if (buffer.length === 0) {
        throw new Error('Dữ liệu tải về có kích thước 0 byte');
      }

      const contentType = response.headers['content-type'] || '';
      const etag = response.headers['etag'] || '';
      const lastModified = response.headers['last-modified'] || '';

      const { mimeType, ext } = detectBufferFormat(buffer, contentType, safeUrl);

      return {
        buffer,
        mimeType,
        ext,
        etag: typeof etag === 'string' ? etag.replace(/"/g, '') : '',
        lastModified: typeof lastModified === 'string' ? lastModified : '',
      };
    } catch (err) {
      lastErr = err;
      if (err.response && (err.response.status === 404 || err.response.status === 410)) {
        break;
      }
      if (attempt >= maxRetries) break;
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`Tải ảnh thất bại sau ${attempt} lần thử: ${lastErr ? lastErr.message : 'Unknown error'}`);
}

/**
 * Phân loại chính xác phân khúc Cao tầng hay Thấp tầng
 */
function determineSegment(item) {
  if (!item) return 'Thap_tang';

  const rawType = String(
    item.project_type ||
    item.raw_data?.project_type ||
    item.raw_data?.type ||
    ''
  ).toLowerCase();

  if (rawType.includes('high') || rawType.includes('cao')) return 'Cao_tang';
  if (rawType.includes('low') || rawType.includes('thap')) return 'Thap_tang';

  const floor = String(item.floor || item.number_of_floor || '').trim();
  if (floor && floor !== '0') return 'Cao_tang';

  const building = String(item.building || item.building_name || '').trim();
  if (building) return 'Cao_tang';

  const unitType = String(item.unit_type || item.apartment_type_name || '').toLowerCase();
  if (
    unitType.includes('căn hộ') ||
    unitType.includes('chung cư') ||
    unitType.includes('studio') ||
    unitType.includes('penthouse') ||
    unitType.includes('duplex')
  ) {
    return 'Cao_tang';
  }

  return 'Thap_tang';
}

/**
 * Thu thập dữ liệu media công khai từ các API SalePro (get_project_landing, get_project_detail, get_share_info)
 */
async function fetchSaleProPublicMedia(projectId, shareContent = '') {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://salepro.com/',
  };

  const result = {
    banners: [],
    projectImages: [],
    floorPlans: [],
    products: [],
    documents: [],
  };

  // 1. Gọi get_project_landing
  try {
    const resLanding = await axios.get(
      'https://salepro.com/api/rest_api/pu/property/master/data/get_project_landing/',
      {
        params: { project_id: projectId },
        headers,
        timeout: 10000,
      }
    );
    const landing = resLanding.data?.data?.[0];
    if (landing) {
      if (Array.isArray(landing.banner_desktop)) {
        for (const b of landing.banner_desktop) {
          if (b.image_url) result.banners.push({ name: b.banner_name || 'Banner', url: b.image_url });
        }
      }
      if (landing.project_image?.image_url) {
        result.projectImages.push({ name: 'project_image', url: landing.project_image.image_url });
      }
      if (Array.isArray(landing.floor_plan)) {
        for (const fp of landing.floor_plan) {
          if (fp.image_url) {
            result.floorPlans.push({
              name: fp.floorplan_name || 'Mặt bằng',
              url: fp.image_url,
            });
          }
        }
      }
      if (Array.isArray(landing.product)) {
        for (const prod of landing.product) {
          if (prod.image_url) {
            result.products.push({
              name: prod.product_name || 'Sản phẩm',
              category: getLayoutCategoryFolder(prod.product_name),
              features: prod.product_features || '',
              url: prod.image_url,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[SalePro API] get_project_landing dự án ${projectId} lỗi:`, err.message);
  }

  // 2. Gọi get_project_detail
  try {
    const resDetail = await axios.get(
      'https://salepro.com/api/rest_api/pu/property/master/data/get_project_detail/',
      {
        params: { project_id: projectId },
        headers,
        timeout: 10000,
      }
    );
    const detailData = resDetail.data?.data || {};

    if (Array.isArray(detailData.image_data)) {
      for (const group of detailData.image_data) {
        if (Array.isArray(group.image_data)) {
          for (const img of group.image_data) {
            if (img.image_url) {
              result.projectImages.push({
                name: group.image_coordinate_name || 'Phối cảnh',
                url: img.image_url,
              });
            }
          }
        }
      }
    }

    if (Array.isArray(detailData.link_general)) {
      for (const lg of detailData.link_general) {
        if (lg.link_utility_url) {
          result.documents.push({
            title: lg.link_utility_name || 'Tài liệu',
            category: classifySaleProDocument(lg.link_utility_name, lg.link_utility_url),
            source_url: lg.link_utility_url,
            target_url: lg.link_utility_url,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[SalePro API] get_project_detail dự án ${projectId} lỗi:`, err.message);
  }

  // 3. Phân tích share_content và giải mã slug qua get_share_info
  if (shareContent && typeof shareContent === 'string') {
    const shareUrls = shareContent.match(/https:\/\/salepro\.com\/share\/([^\s#]+)/g) || [];
    for (const sUrl of shareUrls) {
      const slugMatch = sUrl.match(/https:\/\/salepro\.com\/share\/([^\s#]+)/);
      if (slugMatch) {
        const slug = slugMatch[1].replace(/[.,;!]+$/, '').trim();
        try {
          const resShare = await axios.get(
            'https://salepro.com/api/rest_api/pu/property/share/get_share_info',
            {
              params: { slug },
              headers,
              timeout: 6000,
            }
          );
          const shareInfo = resShare.data?.data;
          if (shareInfo && shareInfo.target_url) {
            result.documents.push({
              title: shareInfo.name || slug,
              category: classifySaleProDocument(shareInfo.name || slug, shareInfo.target_url),
              source_url: sUrl,
              target_url: shareInfo.target_url,
            });
          }
        } catch (_) {
          // Bỏ qua lỗi slug đơn lẻ
        }
      }
    }
  }

  return result;
}

/**
 * Nâng cấp V3: Đồng bộ toàn diện Media dự án SalePro (_Project, _FloorPlans, _Layouts)
 */
async function syncSaleProProjectMedia(projectDoc) {
  if (!projectDoc || projectDoc.source !== 'salepro') return;

  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    console.log(`[SalePro V3] Google Drive chưa bật, bỏ qua đồng bộ media dự án ${projectDoc.project_name}`);
    return;
  }

  const segment = determineSegment(projectDoc);
  console.log(`\n====================================================================`);
  console.log(`🚀 [SalePro Media V3] ĐỒNG BỘ MEDIA DỰ ÁN: [${projectDoc.project_id}] ${projectDoc.project_name}`);
  console.log(`  - Phân khúc: ${segment}`);
  console.log(`====================================================================`);

  const stats = {
    projectId: projectDoc.project_id,
    projectName: projectDoc.project_name,
    segment,
    totalFetched: 0,
    bannersFetched: 0,
    floorPlansFetched: 0,
    productsFetched: 0,
    documentsFetched: 0,
    uploadedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    projectImagesUploaded: 0,
    floorPlansUploaded: 0,
    layoutsUploaded: 0,
    unitCount: 0,
    exactCount: 0,
    typeMatchCount: 0,
    unmatchedCount: 0,
    driveFolderUrl: '',
  };

  try {
    // Đảm bảo thư mục chính của dự án trên Google Drive
    const projectFolder = await ensureFolderPath(['SalePro', segment, projectDoc.project_name]);
    projectDoc.drive_folder_id = projectFolder.id;
    projectDoc.drive_folder_url = projectFolder.webViewLink;
    stats.driveFolderUrl = projectFolder.webViewLink;

    // 1. Thu thập dữ liệu media đầy đủ từ các API công khai của SalePro
    const publicMedia = await fetchSaleProPublicMedia(
      projectDoc.project_id,
      projectDoc.raw_data?.share_content || ''
    );

    // Bổ sung avatar dự án từ raw_data nếu có
    const avatarUrl = projectDoc.raw_data?.avatar?.image_url;
    if (avatarUrl && !publicMedia.banners.some((b) => b.url === avatarUrl)) {
      publicMedia.banners.unshift({ name: 'project_avatar', url: avatarUrl });
    }

    stats.bannersFetched = publicMedia.banners.length + publicMedia.projectImages.length;
    stats.floorPlansFetched = publicMedia.floorPlans.length;
    stats.productsFetched = publicMedia.products.length;
    stats.documentsFetched = publicMedia.documents.length;
    stats.totalFetched =
      stats.bannersFetched + stats.floorPlansFetched + stats.productsFetched + stats.documentsFetched;

    console.log(`  📸 Đã thu thập từ API công khai:`);
    console.log(`    • ${stats.bannersFetched} ảnh phối cảnh & banners`);
    console.log(`    • ${stats.floorPlansFetched} mặt bằng tầng / phân khu (_FloorPlans)`);
    console.log(`    • ${stats.productsFetched} layout thiết kế sản phẩm (_Layouts)`);
    console.log(`    • ${stats.documentsFetched} tài liệu liên quan`);

    // Lưu danh mục tài liệu vào Project
    projectDoc.documents_classified = publicMedia.documents;
    projectDoc.document_urls = Array.from(new Set(publicMedia.documents.map((d) => d.target_url || d.source_url)));

    projectDoc.stored_images = projectDoc.stored_images || [];
    projectDoc.drive_project_image_urls = projectDoc.drive_project_image_urls || [];
    projectDoc.drive_floor_plan_urls = projectDoc.drive_floor_plan_urls || [];
    projectDoc.drive_layout_image_urls = projectDoc.drive_layout_image_urls || [];
    projectDoc.floor_plans = projectDoc.floor_plans || [];
    projectDoc.product_layouts = projectDoc.product_layouts || [];

    // ==========================================
    // 2. Đồng bộ thư mục _Project/
    // ==========================================
    const allProjectImages = [...publicMedia.banners, ...publicMedia.projectImages];
    if (allProjectImages.length > 0) {
      const subProjectFolder = await ensureFolderPath(['SalePro', segment, projectDoc.project_name, '_Project']);

      // Giới hạn upload tối đa 10 ảnh phối cảnh tiêu biểu nhất để tối ưu dung lượng Drive
      const imagesToUpload = allProjectImages.slice(0, 10);

      for (let i = 0; i < imagesToUpload.length; i++) {
        const item = imagesToUpload[i];
        try {
          const { buffer, mimeType, ext, etag, lastModified } = await downloadBufferWithRetry(item.url);
          const sha256 = computeSha256(buffer);

          const existing = projectDoc.stored_images.find(
            (img) => img.original_url === item.url && img.image_type === '_PROJECT'
          );

          if (!existing || existing.sha256 !== sha256) {
            const fileName = i === 0 ? `project_avatar.${ext}` : `banner_${String(i).padStart(2, '0')}.${ext}`;
            const uploaded = await uploadFile({
              name: fileName,
              buffer,
              mimeType,
              parentFolderId: subProjectFolder.id,
              description: `Ảnh phối cảnh dự án ${projectDoc.project_name} - ${item.name}`,
            });

            if (!projectDoc.drive_project_image_urls.includes(uploaded.webViewLink)) {
              projectDoc.drive_project_image_urls.push(uploaded.webViewLink);
            }

            projectDoc.stored_images = projectDoc.stored_images.filter(
              (img) => !(img.original_url === item.url && img.image_type === '_PROJECT')
            );
            projectDoc.stored_images.push({
              original_url: item.url,
              drive_file_id: uploaded.id,
              drive_url: uploaded.webViewLink,
              sha256,
              mime_type: mimeType,
              file_size: uploaded.size,
              etag,
              last_modified: lastModified,
              image_type: '_PROJECT',
              uploaded_at: new Date(),
            });
            stats.uploadedCount++;
            stats.projectImagesUploaded++;
          } else {
            stats.duplicateCount++;
          }
        } catch (imgErr) {
          stats.errorCount++;
          console.warn(`[SalePro V3] ⚠️ Lỗi tải ảnh dự án [${item.url}]:`, imgErr.message);
        }
      }
    }

    // ==========================================
    // 3. Đồng bộ thư mục _FloorPlans/
    // ==========================================
    if (publicMedia.floorPlans.length > 0) {
      const floorPlanFolder = await ensureFolderPath(['SalePro', segment, projectDoc.project_name, '_FloorPlans']);

      for (let i = 0; i < publicMedia.floorPlans.length; i++) {
        const fp = publicMedia.floorPlans[i];
        try {
          const { buffer, mimeType, ext, etag, lastModified } = await downloadBufferWithRetry(fp.url);
          const sha256 = computeSha256(buffer);

          const existing = projectDoc.stored_images.find(
            (img) => img.original_url === fp.url && img.image_type === '_FLOOR_PLAN'
          );

          let driveUrl = existing?.drive_url;

          if (!existing || existing.sha256 !== sha256) {
            const cleanFpName = sanitizeDriveName(fp.name || `floorplan_${i + 1}`);
            const fileName = `${cleanFpName}.${ext}`;
            const uploaded = await uploadFile({
              name: fileName,
              buffer,
              mimeType,
              parentFolderId: floorPlanFolder.id,
              description: `Mặt bằng dự án ${projectDoc.project_name} - ${fp.name}`,
            });

            driveUrl = uploaded.webViewLink;
            if (!projectDoc.drive_floor_plan_urls.includes(driveUrl)) {
              projectDoc.drive_floor_plan_urls.push(driveUrl);
            }

            projectDoc.stored_images = projectDoc.stored_images.filter(
              (img) => !(img.original_url === fp.url && img.image_type === '_FLOOR_PLAN')
            );
            projectDoc.stored_images.push({
              original_url: fp.url,
              drive_file_id: uploaded.id,
              drive_url: driveUrl,
              sha256,
              mime_type: mimeType,
              file_size: uploaded.size,
              etag,
              last_modified: lastModified,
              image_type: '_FLOOR_PLAN',
              uploaded_at: new Date(),
            });
            stats.uploadedCount++;
            stats.floorPlansUploaded++;
          } else {
            stats.duplicateCount++;
          }

          // Cập nhật mảng floor_plans
          projectDoc.floor_plans = projectDoc.floor_plans.filter((f) => f.image_url !== fp.url);
          projectDoc.floor_plans.push({
            floorplan_name: fp.name,
            image_url: fp.url,
            drive_url: driveUrl,
            sha256,
          });
        } catch (fpErr) {
          stats.errorCount++;
          console.warn(`[SalePro V3] ⚠️ Lỗi tải mặt bằng [${fp.url}]:`, fpErr.message);
        }
      }
    }

    // ==========================================
    // 4. Đồng bộ thư mục _Layouts/<Category>/
    // ==========================================
    if (publicMedia.products.length > 0) {
      for (const prod of publicMedia.products) {
        try {
          const { buffer, mimeType, ext, etag, lastModified } = await downloadBufferWithRetry(prod.url);
          const sha256 = computeSha256(buffer);

          const layoutSubFolder = await ensureFolderPath([
            'SalePro',
            segment,
            projectDoc.project_name,
            '_Layouts',
            prod.category,
          ]);

          const existing = projectDoc.stored_images.find(
            (img) => img.original_url === prod.url && img.image_type === '_LAYOUT'
          );

          let driveUrl = existing?.drive_url;

          if (!existing || existing.sha256 !== sha256) {
            const cleanProdName = sanitizeDriveName(prod.name || `layout_${prod.category}`);
            const fileName = `${cleanProdName}.${ext}`;
            const uploaded = await uploadFile({
              name: fileName,
              buffer,
              mimeType,
              parentFolderId: layoutSubFolder.id,
              description: `Layout thiết kế ${prod.name} - Dự án ${projectDoc.project_name}`,
            });

            driveUrl = uploaded.webViewLink;
            if (!projectDoc.drive_layout_image_urls.includes(driveUrl)) {
              projectDoc.drive_layout_image_urls.push(driveUrl);
            }

            projectDoc.stored_images = projectDoc.stored_images.filter(
              (img) => !(img.original_url === prod.url && img.image_type === '_LAYOUT')
            );
            projectDoc.stored_images.push({
              original_url: prod.url,
              drive_file_id: uploaded.id,
              drive_url: driveUrl,
              sha256,
              mime_type: mimeType,
              file_size: uploaded.size,
              etag,
              last_modified: lastModified,
              image_type: '_LAYOUT',
              uploaded_at: new Date(),
            });
            stats.uploadedCount++;
            stats.layoutsUploaded++;
          } else {
            stats.duplicateCount++;
          }

          // Cập nhật mảng product_layouts
          projectDoc.product_layouts = projectDoc.product_layouts.filter((p) => p.image_url !== prod.url);
          projectDoc.product_layouts.push({
            product_name: prod.name,
            category: prod.category,
            features: prod.features,
            image_url: prod.url,
            drive_url: driveUrl,
            sha256,
          });
        } catch (prodErr) {
          stats.errorCount++;
          console.warn(`[SalePro V3] ⚠️ Lỗi tải layout [${prod.url}]:`, prodErr.message);
        }
      }
    }

    projectDoc.image_sync_status = 'SUCCESS';
    projectDoc.image_synced_at = new Date();
    await projectDoc.save();

    // ==========================================
    // 5. Lan tỏa và liên kết layout tới từng căn trong MongoDB
    // ==========================================
    const unitsOfProject = await Unit.find({
      source: 'salepro',
      $or: [{ project_id: projectDoc.project_id }, { project_name: projectDoc.project_name }],
    });

    console.log(`  🔗 Đang liên kết layout và tài liệu tới ${unitsOfProject.length} căn thuộc dự án...`);
    let exactCount = 0;
    let typeMatchCount = 0;
    let unmatchedCount = 0;

    for (const unit of unitsOfProject) {
      const { matchLevel, matchedLayout, label } = matchUnitWithProductLayouts(
        unit,
        projectDoc.product_layouts
      );

      unit.layout_match_level = matchLevel;
      unit.layout_name = label;

      if (matchedLayout && matchedLayout.drive_url) {
        unit.layout_image_urls = [matchedLayout.image_url];
        unit.drive_layout_image_urls = [matchedLayout.drive_url];
      } else {
        unit.layout_image_urls = [];
        unit.drive_layout_image_urls = [];
      }

      unit.project_image_urls = projectDoc.project_image_urls;
      unit.drive_project_image_urls = projectDoc.drive_project_image_urls;
      unit.floor_plan_urls = (projectDoc.floor_plans || []).map((f) => f.image_url);
      unit.drive_floor_plan_urls = (projectDoc.floor_plans || []).map((f) => f.drive_url).filter(Boolean);
      unit.drive_folder_url = projectDoc.drive_folder_url;
      unit.document_urls = projectDoc.document_urls;
      unit.shared_media_status = 'SYNCED';

      // Căn SalePro không có ảnh chụp riêng -> Ghi nhận trung thực NO_IMAGE
      if (!unit.image_urls || unit.image_urls.length === 0) {
        unit.image_sync_status = 'NO_IMAGE';
      }

      await unit.save();

      if (matchLevel === 'EXACT') exactCount++;
      else if (matchLevel === 'TYPE_MATCH') typeMatchCount++;
      else unmatchedCount++;
    }

    stats.unitCount = unitsOfProject.length;
    stats.exactCount = exactCount;
    stats.typeMatchCount = typeMatchCount;
    stats.unmatchedCount = unmatchedCount;

    console.log(`  ✅ Hoàn tất liên kết:`);
    console.log(`     • Khớp chính xác (EXACT): ${exactCount} căn`);
    console.log(`     • Khớp loại tham khảo (TYPE_MATCH): ${typeMatchCount} căn`);
    console.log(`     • Chưa liên kết được (UNMATCHED): ${unmatchedCount} căn`);
    console.log(`====================================================================\n`);

    return {
      status: 'SUCCESS',
      ...stats,
    };
  } catch (err) {
    console.error(`[SalePro Media V3] ❌ Lỗi nghiêm trọng đồng bộ dự án ${projectDoc.project_name}:`, err.message);
    projectDoc.image_sync_status = 'FAILED';
    projectDoc.image_sync_error = err.message;
    await projectDoc.save();
    return { status: 'FAILED', error: err.message };
  }
}

/**
 * Xử lý đồng bộ hình ảnh cho một bản ghi Unit cụ thể (HiSale hoặc SalePro căn riêng)
 */
async function syncSingleUnit(unitDoc) {
  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    return { status: 'SKIPPED_DRIVE_DISABLED', unit_code: unitDoc.unit_code };
  }

  unitDoc.image_sync_status = 'PROCESSING';
  unitDoc.image_sync_locked_until = new Date(Date.now() + LOCK_TIMEOUT_MS);
  unitDoc.image_sync_retries = (unitDoc.image_sync_retries || 0) + 1;
  await unitDoc.save();

  const sourceName = (unitDoc.source || 'hisale').toLowerCase() === 'hisale' ? 'HiSale' : 'SalePro';
  const urlsToSync = Array.isArray(unitDoc.image_urls) ? unitDoc.image_urls.filter(Boolean) : [];

  // Nếu là SalePro và căn không có ảnh riêng:
  if (sourceName === 'SalePro' && urlsToSync.length === 0) {
    unitDoc.image_sync_status = 'NO_IMAGE';
    unitDoc.image_sync_locked_until = null;
    unitDoc.image_synced_at = new Date();
    await unitDoc.save();
    return { status: 'NO_IMAGE', unit_code: unitDoc.unit_code };
  }

  if (urlsToSync.length === 0) {
    unitDoc.image_sync_status = 'NO_IMAGE';
    unitDoc.image_sync_locked_until = null;
    unitDoc.image_synced_at = new Date();
    await unitDoc.save();
    return { status: 'NO_IMAGE', unit_code: unitDoc.unit_code };
  }

  try {
    const segment = determineSegment(unitDoc);

    let folder = null;
    if (unitDoc.drive_folder_id) {
      const exists = await verifyDriveItemExists(unitDoc.drive_folder_id);
      if (exists) {
        folder = { id: unitDoc.drive_folder_id, webViewLink: unitDoc.drive_folder_url };
      }
    }

    if (!folder) {
      folder = await ensureFolderPath([sourceName, segment, unitDoc.project_name, unitDoc.unit_code]);
      unitDoc.drive_folder_id = folder.id;
      unitDoc.drive_folder_url = folder.webViewLink;
    }

    unitDoc.stored_images = unitDoc.stored_images || [];
    unitDoc.drive_image_urls = unitDoc.drive_image_urls || [];

    let successCount = 0;
    let failCount = 0;

    for (let index = 0; index < urlsToSync.length; index++) {
      const originalUrl = urlsToSync[index];

      try {
        const { buffer, mimeType, ext, etag, lastModified } = await downloadBufferWithRetry(originalUrl);
        const sha256 = computeSha256(buffer);

        const existingStored = unitDoc.stored_images.find((img) => img.original_url === originalUrl);

        if (existingStored && existingStored.sha256 === sha256 && existingStored.drive_url) {
          if (!unitDoc.drive_image_urls.includes(existingStored.drive_url)) {
            unitDoc.drive_image_urls.push(existingStored.drive_url);
          }
          successCount++;
          continue;
        }

        const duplicateHash = unitDoc.stored_images.find((img) => img.sha256 === sha256 && img.drive_url);
        if (duplicateHash) {
          if (!unitDoc.drive_image_urls.includes(duplicateHash.drive_url)) {
            unitDoc.drive_image_urls.push(duplicateHash.drive_url);
          }
          successCount++;
          continue;
        }

        const fileName = `image_${String(index + 1).padStart(2, '0')}.${ext}`;
        const uploaded = await uploadFile({
          name: fileName,
          buffer,
          mimeType,
          parentFolderId: folder.id,
          description: `Ảnh căn ${unitDoc.unit_code} - Dự án ${unitDoc.project_name}`,
        });

        unitDoc.stored_images = unitDoc.stored_images.filter((img) => img.original_url !== originalUrl);
        unitDoc.stored_images.push({
          original_url: originalUrl,
          drive_file_id: uploaded.id,
          drive_url: uploaded.webViewLink,
          sha256,
          mime_type: mimeType,
          file_size: uploaded.size,
          etag,
          last_modified: lastModified,
          image_type: 'UNIT',
          uploaded_at: new Date(),
        });

        if (!unitDoc.drive_image_urls.includes(uploaded.webViewLink)) {
          unitDoc.drive_image_urls.push(uploaded.webViewLink);
        }

        await unitDoc.save();
        successCount++;
      } catch (uploadErr) {
        failCount++;
        unitDoc.image_sync_error = uploadErr.message;
        console.warn(
          `[ImageSync] ⚠️ Lỗi tải ảnh [${originalUrl}] của căn ${unitDoc.unit_code}:`,
          uploadErr.message
        );
      }
    }

    if (successCount === urlsToSync.length) {
      unitDoc.image_sync_status = 'SUCCESS';
      unitDoc.image_sync_error = '';
    } else if (successCount > 0) {
      unitDoc.image_sync_status = 'PARTIAL';
    } else {
      unitDoc.image_sync_status = 'FAILED';
    }

    unitDoc.image_sync_locked_until = null;
    unitDoc.image_synced_at = new Date();
    await unitDoc.save();

    return {
      status: unitDoc.image_sync_status,
      unit_code: unitDoc.unit_code,
      successCount,
      failCount,
    };
  } catch (err) {
    unitDoc.image_sync_status = 'FAILED';
    unitDoc.image_sync_error = err.message;
    unitDoc.image_sync_locked_until = null;
    unitDoc.image_synced_at = new Date();
    await unitDoc.save();
    return { status: 'FAILED', unit_code: unitDoc.unit_code, error: err.message };
  }
}

/**
 * Xử lý một batch danh sách căn với số lượng đồng thời được kiểm soát
 */
async function processBatchWithConcurrency(units, concurrency = DEFAULT_CONCURRENCY) {
  const results = [];
  for (let i = 0; i < units.length; i += concurrency) {
    const chunk = units.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map((u) => syncSingleUnit(u)));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Đồng bộ một batch hình ảnh đang chờ xử lý
 */
async function syncPendingImages({ source = 'all', limit = null } = {}) {
  if (isSyncRunning) {
    console.log('[ImageSync] ⏳ Đang có một phiên đồng bộ hình ảnh đang chạy. Bỏ qua phiên này.');
    return { running: true };
  }

  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    console.log(`[ImageSync] ℹ️ Tạm hoãn đồng bộ Google Drive: ${driveCheck.reason}`);
    return { enabled: false, reason: driveCheck.reason };
  }

  isSyncRunning = true;
  const startedAt = new Date();
  const batchSize = Number(limit || process.env.IMAGE_SYNC_BATCH_SIZE || DEFAULT_BATCH_SIZE);
  const concurrency = Number(process.env.IMAGE_UPLOAD_CONCURRENCY || DEFAULT_CONCURRENCY);

  console.log(`\n====================================================================`);
  console.log(`📸 [IMAGE SYNC] BẮT ĐẦU ĐỒNG BỘ HÌNH ẢNH GOOGLE DRIVE - ${startedAt.toLocaleTimeString('vi-VN')}`);
  console.log(`  - Nguồn: ${source.toUpperCase()} | Kích thước batch: ${batchSize} căn | Luồng song song: ${concurrency}`);
  console.log(`====================================================================`);

  try {
    const filterConditions = [];

    filterConditions.push({
      $or: [
        { image_sync_status: { $in: ['PENDING', 'PARTIAL'] } },
        { image_sync_status: { $exists: false } },
      ],
    });

    filterConditions.push({
      image_sync_status: 'PROCESSING',
      image_sync_locked_until: { $lt: new Date() },
    });

    filterConditions.push({
      image_sync_status: 'FAILED',
      image_sync_retries: { $lt: 3 },
    });

    filterConditions.push({
      image_sync_status: 'SUCCESS',
      $expr: {
        $gt: [
          { $size: { $ifNull: ['$image_urls', []] } },
          { $size: { $ifNull: ['$stored_images', []] } },
        ],
      },
    });

    const query = { $or: filterConditions };
    if (source && source !== 'all') {
      query.source = source.toLowerCase();
    }

    const pendingUnits = await Unit.find(query)
      .sort({ created_at: -1 })
      .limit(batchSize);

    if (pendingUnits.length === 0) {
      console.log(`[ImageSync] ✨ Không còn căn [${source}] nào đang chờ đồng bộ hình ảnh.`);
      return { total: 0, success: 0 };
    }

    console.log(`[ImageSync] 🔍 Tìm thấy ${pendingUnits.length} căn cần xử lý hình ảnh trong batch này...`);
    const results = await processBatchWithConcurrency(pendingUnits, concurrency);

    const successCount = results.filter((r) => r.status === 'SUCCESS').length;
    const partialCount = results.filter((r) => r.status === 'PARTIAL').length;
    const failedCount = results.filter((r) => r.status === 'FAILED').length;
    const noImageCount = results.filter((r) => r.status === 'NO_IMAGE').length;

    console.log(`🏁 [IMAGE SYNC] KẾT THÚC BATCH:`);
    console.log(`  - Thành công: ${successCount} căn`);
    if (partialCount > 0) console.log(`  - Thành công một phần: ${partialCount} căn`);
    if (failedCount > 0) console.log(`  - Thất bại: ${failedCount} căn`);
    if (noImageCount > 0) console.log(`  - Không có ảnh: ${noImageCount} căn`);
    console.log(`====================================================================\n`);

    return {
      total: pendingUnits.length,
      success: successCount,
      partial: partialCount,
      failed: failedCount,
      noImage: noImageCount,
    };
  } catch (err) {
    console.error('[ImageSync] ❌ Lỗi nghiêm trọng trong phiên đồng bộ ảnh:', err.message);
    return { error: err.message };
  } finally {
    isSyncRunning = false;
  }
}

/**
 * Phân tích nội dung share_content thành layoutImageUrls và documentUrls
 */
function parseSaleProShareContent(text = '') {
  const result = {
    layoutImageUrls: [],
    documentUrls: [],
  };
  if (!text || typeof text !== 'string') return result;

  const urlRegex = /https?:\/\/[^\s"',;<>]+/gi;
  const matches = text.match(urlRegex) || [];
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

  for (const rawUrl of matches) {
    const cleanUrl = rawUrl.replace(/[.,;!?]+$/, '');
    const lower = cleanUrl.toLowerCase();
    if (imageExts.some((ext) => lower.endsWith(ext))) {
      if (!result.layoutImageUrls.includes(cleanUrl)) {
        result.layoutImageUrls.push(cleanUrl);
      }
    } else {
      if (!result.documentUrls.includes(cleanUrl)) {
        result.documentUrls.push(cleanUrl);
      }
    }
  }

  return result;
}

module.exports = {
  syncPendingImages,
  syncSingleUnit,
  syncSaleProProjectMedia,
  fetchSaleProPublicMedia,
  parseSaleProShareContent,
  matchUnitWithProductLayouts,
  getLayoutCategoryFolder,
  classifySaleProDocument,
  determineSegment,
  computeSha256,
  downloadBufferWithRetry,
  detectBufferFormat,
  validateSafeUrl,
};
