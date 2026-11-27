const crypto = require('crypto');
const axios = require('axios');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const {
  isDriveConfigured,
  getDriveClient,
  ensureFolderPath,
  uploadFile,
  verifyDriveItemExists,
  sanitizeDriveName,
} = require('./googleDriveService');

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_SIZE_MB = 0; // 0 = không giới hạn dung lượng ảnh tải về
const DEFAULT_MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 25000; // 25s để tải file mượt mà nhưng không bị treo quá lâu khi link chết
const LOCK_TIMEOUT_MS = 15 * 60 * 1000; // Khóa xử lý 15 phút

let isSyncRunning = false;

// Danh sách các domain cho phép tải ảnh (SSRF Protection)
const ALLOWED_DOMAINS = [
  'hisale.vn',
  'hisale.com',
  'salepro.com',
  'vhub.com.vn',
  'g-hub.vn',
  'r2.dev',
  'vistax.vn',
  'fptcloud.com',
  'amazonaws.com',
  'cloudfront.net',
  'googleusercontent.com',
  'googleapis.com',
  'drive.google.com',
  'docs.google.com',
  'google.com',
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
 * Tuân thủ quy tắc V3.1:
 * - Không gán EXACT nếu chỉ có 1 candidate mà thiếu căn cứ diện tích / thiết kế.
 * - Không gán EXACT nếu có nhiều candidate có diện tích tương đương hoặc mơ hồ.
 * - Đối chiếu mã thiết kế, phân khu, tòa nhà, loại diện tích (tim tường vs thông thủy).
 * - Nếu chỉ khớp loại căn -> TYPE_MATCH.
 * - Không chọn tùy tiện ứng viên đầu tiên.
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

  // 1. Lọc các layouts thuộc category tương ứng
  let candidates = productLayouts.filter((p) => p.category === unitCategory);

  // Fallback: nếu không khớp theo category chuẩn, thử đối chiếu qua tên tương đối
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

  // 2. Thu thập các thuộc tính nhận diện của căn hộ
  const unitAreaBuild = Number(unit.area_build || unit.raw_data?.built_up_area || 0); // Diện tích tim tường / xây dựng
  const unitAreaLand = Number(unit.area_land || unit.raw_data?.carpet_area || 0);    // Diện tích thông thủy / đất
  const unitCode = String(unit.unit_code || '').trim();
  const unitSubdivision = removeVietnameseTones(String(unit.subdivision || '')).toLowerCase();
  const unitBuilding = removeVietnameseTones(String(unit.building || '')).toLowerCase();

  // Kiểm tra mã thiết kế / mẫu layout nếu có trong raw_data hoặc unit_code
  const unitDesignCode = String(
    unit.raw_data?.design_code ||
    unit.raw_data?.layout_code ||
    unit.raw_data?.code_design ||
    ''
  ).toLowerCase().trim();

  // ==========================================
  // TIÊU CHÍ 1: Khớp mã thiết kế cụ thể (Explicit Design Code)
  // ==========================================
  if (unitDesignCode) {
    const codeMatch = candidates.find((cand) => {
      const candNorm = removeVietnameseTones(cand.product_name).toLowerCase();
      return candNorm.includes(unitDesignCode) || (cand.features && cand.features.toLowerCase().includes(unitDesignCode));
    });
    if (codeMatch) {
      return {
        matchLevel: 'EXACT',
        matchedLayout: codeMatch,
        label: `Layout ${codeMatch.product_name} (Chính xác - Mã thiết kế ${unitDesignCode.toUpperCase()})`,
      };
    }
  }

  // ==========================================
  // TIÊU CHÍ 2: Khớp phong cách / phân khu kiến trúc đặc thù
  // (ví dụ: Biệt thự "Địa Trung Hải", "Tân Cổ Điển", "Cọ Xanh", "Hải Đăng"...)
  // ==========================================
  const distinctKeywords = [
    'dia trung hai', 'tan co dien', 'manhattan', 'indochine', 'nhat ban',
    'paris', 'venice', 'monaco', 'florida', 'garden', 'golf'
  ];
  for (const cand of candidates) {
    const candNorm = removeVietnameseTones(cand.product_name).toLowerCase();
    for (const kw of distinctKeywords) {
      if (candNorm.includes(kw)) {
        const fullUnitContext = `${unitCode} ${unitSubdivision} ${unitBuilding} ${rawUnitType}`.toLowerCase();
        if (fullUnitContext.includes(kw)) {
          return {
            matchLevel: 'EXACT',
            matchedLayout: cand,
            label: `Layout ${cand.product_name} (Chính xác - Phong cách ${kw})`,
          };
        }
      }
    }
  }

  // ==========================================
  // TIÊU CHÍ 3: Khớp diện tích chặt chẽ (Tight Area Matching ±0.5m²)
  // ==========================================
  // Chỉ xét EXACT khi diện tích khớp rất sát (dung sai tối đa 0.5m²) và KHÔNG có sự nhập nhằng giữa nhiều layouts
  const areaMatches = [];
  for (const cand of candidates) {
    if (!cand.features) continue;
    const range = extractAreaRange(cand.features);
    if (!range) continue;

    // So sánh với diện tích xây dựng (tim tường) hoặc diện tích thông thủy (đất)
    const matchesBuild = unitAreaBuild > 0 && unitAreaBuild >= range.min - 0.5 && unitAreaBuild <= range.max + 0.5;
    const matchesLand = unitAreaLand > 0 && unitAreaLand >= range.min - 0.5 && unitAreaLand <= range.max + 0.5;

    if (matchesBuild || matchesLand) {
      areaMatches.push({
        cand,
        delta: Math.min(
          unitAreaBuild > 0 ? Math.abs(unitAreaBuild - (range.min + range.max) / 2) : 999,
          unitAreaLand > 0 ? Math.abs(unitAreaLand - (range.min + range.max) / 2) : 999
        ),
      });
    }
  }

  // Nếu duy nhất 1 candidate khớp diện tích chặt chẽ -> EXACT
  if (areaMatches.length === 1) {
    const best = areaMatches[0].cand;
    return {
      matchLevel: 'EXACT',
      matchedLayout: best,
      label: `Layout ${best.product_name} (Chính xác)`,
    };
  }

  // Nếu có nhiều hơn 1 candidate đều khớp diện tích tương đương -> NHẬP NHẰNG (Ambiguous)
  // Quy tắc nghiệp vụ V3.1: Không được đánh dấu EXACT, phải chuyển thành TYPE_MATCH (Tham khảo)
  if (areaMatches.length > 1) {
    areaMatches.sort((a, b) => a.delta - b.delta);
    const best = areaMatches[0].cand;
    return {
      matchLevel: 'TYPE_MATCH',
      matchedLayout: best,
      label: `Layout ${best.product_name} (Tham khảo - Có ${areaMatches.length} thiết kế cùng diện tích)`,
    };
  }

  // ==========================================
  // TIÊU CHÍ 4: Không đủ căn cứ diện tích/thiết kế -> TYPE_MATCH (Tham khảo)
  // Không gán EXACT ngay cả khi dự án chỉ có 1 layout cùng loại
  // ==========================================
  // Chọn layout có khoảng diện tích gần nhất nếu có features
  let closestCandidate = candidates[0];
  let minDiff = Infinity;
  const targetArea = unitAreaBuild || unitAreaLand;

  if (targetArea > 0) {
    for (const cand of candidates) {
      if (cand.features) {
        const range = extractAreaRange(cand.features);
        if (range) {
          const mid = (range.min + range.max) / 2;
          const diff = Math.abs(targetArea - mid);
          if (diff < minDiff) {
            minDiff = diff;
            closestCandidate = cand;
          }
        }
      }
    }
  }

  return {
    matchLevel: 'TYPE_MATCH',
    matchedLayout: closestCandidate,
    label: `Layout ${closestCandidate.product_name} (Tham khảo)`,
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

  // HEIC / HEIF / AVIF: [offset 4..7] = 'ftyp'
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    const brand = buffer.slice(8, 12).toString('latin1').toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return { mimeType: 'image/heic', ext: 'heic' };
    }
    if (brand === 'avif' || brand === 'avis') {
      return { mimeType: 'image/avif', ext: 'avif' };
    }
  }

  if (cleanHeader.includes('image/png') || url.toLowerCase().endsWith('.png')) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (cleanHeader.includes('image/heic') || cleanHeader.includes('image/heif') || url.toLowerCase().includes('.heic') || url.toLowerCase().includes('.heif')) {
    return { mimeType: 'image/heic', ext: 'heic' };
  }
  if (cleanHeader.includes('image/avif') || url.toLowerCase().includes('.avif')) {
    return { mimeType: 'image/avif', ext: 'avif' };
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
  if (
    cleanHeader.includes('spreadsheetml') ||
    cleanHeader.includes('excel') ||
    url.toLowerCase().endsWith('.xlsx') ||
    url.toLowerCase().endsWith('.xls')
  ) {
    return { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  }
  if (
    cleanHeader.includes('wordprocessingml') ||
    cleanHeader.includes('msword') ||
    url.toLowerCase().endsWith('.docx') ||
    url.toLowerCase().endsWith('.doc')
  ) {
    return { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
  }

  // ZIP / Office Open XML (xlsx, docx, etc.): PK..
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    if (
      cleanHeader.includes('spreadsheetml') ||
      cleanHeader.includes('excel') ||
      url.toLowerCase().includes('.xlsx') ||
      url.toLowerCase().includes('.xls')
    ) {
      return { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    }
    if (
      cleanHeader.includes('wordprocessingml') ||
      cleanHeader.includes('msword') ||
      url.toLowerCase().includes('.docx') ||
      url.toLowerCase().includes('.doc')
    ) {
      return { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
    }
    return { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  }

  throw new Error(`Định dạng dữ liệu không xác định hoặc không được hỗ trợ (MIME: ${contentType})`);
}

/**
 * Trích xuất Google Drive file ID từ các dạng link file (view, uc?id=..., open?id=..., spreadsheets/d/..., document/d/...)
 */
function extractDriveFileId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (trimmed.includes('/folders/')) {
    return null;
  }
  const match = trimmed.match(
    /(?:drive\.google\.com\/file\/d\/|docs\.google\.com\/(?:spreadsheets|document|presentation)\/d\/|[?&]id=)([a-zA-Z0-9_-]+)/i
  );
  if (match) return match[1];
  return null;
}

/**
 * Trích xuất Google Drive folder ID từ các dạng link folder Drive
 */
function extractDriveFolderId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const match = rawUrl.match(/(?:drive\.google\.com\/(?:drive\/)?(?:u\/\d+\/)?folders\/)([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : null;
}

/**
 * Tải file an toàn từ URL (hoặc Google Drive File ID) kèm retry, backoff, giới hạn dung lượng và chống SSRF
 */
async function downloadBufferWithRetry(
  rawUrl,
  maxRetries = DEFAULT_MAX_RETRIES,
  { allowDrivePdf = false, allowDriveDoc = false } = {}
) {
  const safeUrl = validateSafeUrl(rawUrl);
  const envVal = process.env.IMAGE_MAX_SIZE_MB;
  const maxMb = envVal !== undefined && envVal !== '' ? Number(envVal) : DEFAULT_MAX_SIZE_MB;
  const maxBytes = maxMb > 0 ? maxMb * 1024 * 1024 : Infinity;
  const driveFileId = extractDriveFileId(safeUrl);
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      if (driveFileId) {
        const drive = getDriveClient();
        const metaRes = await drive.files.get({
          fileId: driveFileId,
          fields: 'id, name, mimeType, size, trashed',
          supportsAllDrives: true,
        });
        const meta = metaRes.data || {};
        if (meta.trashed) {
          throw new Error(`PERMANENT_DEAD_FILE: File Drive đã bị xóa vào thùng rác (${driveFileId})`);
        }
        const driveMime = String(meta.mimeType || '').toLowerCase();
        const isPdf = driveMime.includes('pdf');
        const isSpreadsheet = driveMime.includes('spreadsheet') || driveMime.includes('excel');
        const isDoc = driveMime.includes('document') || driveMime.includes('msword') || driveMime.includes('officedocument');
        const isGoogleApps = driveMime.includes('google-apps');

        if (isGoogleApps || isSpreadsheet || isDoc || isPdf) {
          if (!allowDriveDoc && (!allowDrivePdf || !isPdf)) {
            throw new Error(`Định dạng dữ liệu không phải ảnh (MIME: ${meta.mimeType})`);
          }
        }

        const declaredSize = Number(meta.size || 0);
        if (maxBytes !== Infinity && declaredSize > maxBytes) {
          throw new Error(`Dung lượng file (${declaredSize} bytes) vượt quá giới hạn cho phép`);
        }

        if (driveMime.includes('google-apps.spreadsheet')) {
          const exportRes = await drive.files.export(
            {
              fileId: driveFileId,
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
            { responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT_MS }
          );
          const buffer = Buffer.from(exportRes.data);
          const originalName = meta.name ? (meta.name.toLowerCase().endsWith('.xlsx') ? meta.name : `${meta.name}.xlsx`) : 'Bang_tinh_gia.xlsx';
          return {
            buffer,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ext: 'xlsx',
            etag: '',
            lastModified: '',
            originalName,
          };
        }

        if (driveMime.includes('google-apps.document')) {
          const exportRes = await drive.files.export(
            {
              fileId: driveFileId,
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
            { responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT_MS }
          );
          const buffer = Buffer.from(exportRes.data);
          const originalName = meta.name ? (meta.name.toLowerCase().endsWith('.docx') ? meta.name : `${meta.name}.docx`) : 'Tai_lieu.docx';
          return {
            buffer,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ext: 'docx',
            etag: '',
            lastModified: '',
            originalName,
          };
        }

        const mediaRes = await drive.files.get(
          { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT_MS }
        );
        const buffer = Buffer.from(mediaRes.data);
        if (buffer.length === 0) {
          throw new Error('Dữ liệu tải từ Drive có kích thước 0 byte');
        }
        const { mimeType, ext } = detectBufferFormat(buffer, meta.mimeType || '', meta.name || safeUrl);
        return {
          buffer,
          mimeType,
          ext,
          etag: '',
          lastModified: '',
          originalName: meta.name || '',
        };
      }

      const response = await axios.get(safeUrl, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxContentLength: maxBytes === Infinity ? Infinity : maxBytes,
        maxBodyLength: maxBytes === Infinity ? Infinity : maxBytes,
        maxRedirects: 5,
        beforeRedirect: (options) => {
          const redirectUrl = options.href || `${options.protocol}//${options.hostname}${options.path}`;
          validateSafeUrl(redirectUrl);
        },
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
      const errStatus = err.status || (err.response && err.response.status);
      const errMsg = String(err.message || '');
      if (
        errStatus === 404 ||
        errStatus === 410 ||
        errStatus === 403 ||
        errMsg.includes('MIME:') ||
        errMsg.includes('PERMANENT_DEAD_FILE:') ||
        errMsg.includes('thùng rác') ||
        errMsg.includes('File not found')
      ) {
        if (errStatus === 404 || errMsg.includes('File not found')) {
          lastErr = new Error(`PERMANENT_DEAD_FILE: ${errMsg}`);
        }
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
 * Phân loại chính xác phân khúc Cao tầng hay Thấp tầng chuẩn V3.1
 * Ưu tiên:
 * 1. Metadata dự án (HiSale project.typeName hoặc SalePro project_type)
 * 2. Loại căn (unit_type) - Tiêu chuẩn quyết định hàng đầu cho từng căn
 * 3. Tầng và tòa nhà (tránh ngộ nhận dãy nhà/lô đất thấp tầng là tòa cao tầng)
 */
function determineSegment(item) {
  if (!item) return 'Thap_tang';

  // 1. Kiểm tra loại hình dự án trực tiếp từ raw_data (HiSale project.typeName hoặc SalePro project_type)
  const rawProjectType = String(
    item.project_type ||
    item.raw_data?.project_type ||
    item.raw_data?.productType ||
    item.raw_data?.project?.typeName ||
    item.raw_data?.typeName ||
    ''
  ).toLowerCase();

  const normProjectType = removeVietnameseTones(rawProjectType);
  if (
    normProjectType.includes('thap tang') ||
    normProjectType.includes('thap_tang') ||
    normProjectType.includes('low_rise') ||
    normProjectType.includes('low rise')
  ) {
    return 'Thap_tang';
  }
  if (
    normProjectType.includes('cao tang') ||
    normProjectType.includes('cao_tang') ||
    normProjectType.includes('high_rise') ||
    normProjectType.includes('high rise')
  ) {
    return 'Cao_tang';
  }

  // 2. Kiểm tra loại căn (unit_type) - Đây là tiêu chuẩn quyết định cho từng căn hộ
  const unitType = removeVietnameseTones(
    String(item.unit_type || item.raw_data?.type || item.raw_data?.apartment_type_name || '')
  ).toLowerCase();

  // Danh mục từ khóa thấp tầng đặc trưng (Liền kề, Biệt thự, Nhà phố, Shophouse, Đất nền...)
  const lowRiseKeywords = [
    'lien ke', 'biet thu', 'don lap', 'song lap', 'tu lap',
    'nha pho', 'shophouse', 'shoptel', 'boutique', 'nha vuon', 'dat nen'
  ];
  if (lowRiseKeywords.some((kw) => unitType.includes(kw))) {
    return 'Thap_tang';
  }

  // Danh mục từ khóa cao tầng đặc trưng (Căn hộ, Chung cư, Studio, Duplex, Penthouse, Phòng ngủ...)
  const highRiseKeywords = [
    'can ho', 'chung cu', 'studio', 'duplex', 'penthouse', 'officetel',
    '1pn', '2pn', '3pn', '4pn', 'phong ngu'
  ];
  if (highRiseKeywords.some((kw) => unitType.includes(kw))) {
    return 'Cao_tang';
  }

  // 3. Fallback: Kiểm tra số tầng & tòa nhà khi không có thông tin unit_type rõ ràng
  const floorStr = String(item.floor || item.number_of_floor || '').trim();
  const floorNum = parseInt(floorStr, 10);
  if (!isNaN(floorNum) && floorNum > 5) {
    return 'Cao_tang';
  }

  const building = removeVietnameseTones(String(item.building || item.building_name || '')).toLowerCase().trim();
  if (building) {
    return 'Cao_tang';
  }

  if (!isNaN(floorNum) && floorNum > 0) {
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
async function syncSaleProProjectMedia(projectDoc, options = {}) {
  if (!projectDoc || projectDoc.source !== 'salepro') return;

  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    console.log(`[SalePro V3] Google Drive chưa bật, bỏ qua đồng bộ media dự án ${projectDoc.project_name}`);
    return { status: 'SKIPPED_DRIVE_DISABLED', projectId: projectDoc.project_id };
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

  const projectLeaseId = options.leaseId || crypto.randomUUID();
  const lockTimeoutMs = options.lockTimeoutMs || 15 * 60 * 1000;
  const projectHeartbeatIntervalMs = options.heartbeatIntervalMs || 60000;

  // Trạng thái khóa nội bộ: worker nhận tín hiệu dừng ngay khi mất lease hoặc không gia hạn được
  const projectLockState = {
    isLost: false,
    lostReason: '',
  };
  if (options.lockStateRef && typeof options.lockStateRef === 'object') {
    options.lockStateRef.state = projectLockState;
  }

  // Lấy khóa xử lý nguyên tử cấp dự án với lease ID (ngăn xung đột worker song song)
  const lockedProj = await Project.findOneAndUpdate(
    {
      _id: projectDoc._id,
      $or: [
        { image_sync_status: { $ne: 'PROCESSING' } },
        { image_sync_locked_until: { $lt: new Date() } },
        { image_sync_locked_until: null },
      ],
    },
    {
      $set: {
        image_sync_status: 'PROCESSING',
        image_sync_locked_until: new Date(Date.now() + lockTimeoutMs),
        image_sync_lock_owner: projectLeaseId,
      },
    },
    { new: true }
  );

  if (!lockedProj) {
    console.warn(`[SalePro V3] ℹ️ Dự án [${projectDoc.project_name}] đang được xử lý bởi worker khác.`);
    return { status: 'LOCKED_BY_OTHER', projectId: projectDoc.project_id };
  }

  // Khởi động Heartbeat gia hạn khóa dự án định kỳ (ngăn mất lease khi tải ảnh/cập nhật lâu)
  let projectHeartbeatTimer = null;

  projectHeartbeatTimer = setInterval(async () => {
    try {
      const renewRes = await Project.updateOne(
        {
          _id: projectDoc._id,
          image_sync_lock_owner: projectLeaseId,
          image_sync_locked_until: { $gt: new Date() },
        },
        {
          $set: {
            image_sync_locked_until: new Date(Date.now() + lockTimeoutMs),
          },
        }
      );
      if (renewRes.matchedCount === 0) {
        console.warn(`[SalePro V3] ⚠️ Mất quyền gia hạn khóa dự án [${projectDoc.project_name}] (lease: ${projectLeaseId})`);
        projectLockState.isLost = true;
        projectLockState.lostReason = 'HEARTBEAT_RENEW_FAILED_OR_LEASE_EXPIRED';
        clearInterval(projectHeartbeatTimer);
        projectHeartbeatTimer = null;
      }
    } catch (renewErr) {
      console.error(`[SalePro V3] ❌ Lỗi heartbeat dự án [${projectDoc.project_name}]:`, renewErr.message);
    }
  }, projectHeartbeatIntervalMs);

  if (projectHeartbeatTimer && typeof projectHeartbeatTimer.unref === 'function') {
    projectHeartbeatTimer.unref();
  }

  try {
    if (projectLockState.isLost) {
      console.warn(`[SalePro V3] ⚠️ Mất quyền khóa dự án [${projectDoc.project_name}] trước khi xử lý media.`);
      return { status: 'LOCK_LOST', reason: projectLockState.lostReason, projectId: projectDoc.project_id };
    }
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

      // Cấu hình số ảnh phối cảnh tối đa qua .env (0 = không giới hạn, lấy toàn bộ)
      const maxImagesLimit = process.env.IMAGE_MAX_PROJECT_IMAGES ? Number(process.env.IMAGE_MAX_PROJECT_IMAGES) : 0;
      const imagesToUpload = maxImagesLimit > 0 ? allProjectImages.slice(0, maxImagesLimit) : allProjectImages;

      for (let i = 0; i < imagesToUpload.length; i++) {
        const item = imagesToUpload[i];
        try {
          const { buffer, mimeType, ext, etag, lastModified } = await downloadBufferWithRetry(item.url);
          const sha256 = computeSha256(buffer);

          const existing = projectDoc.stored_images.find(
            (img) => img.original_url === item.url && img.image_type === '_PROJECT'
          );

          let needUpload = !existing || existing.sha256 !== sha256;
          if (existing && existing.sha256 === sha256 && existing.drive_file_id) {
            const stillExists = await verifyDriveItemExists(existing.drive_file_id);
            if (!stillExists) {
              needUpload = true;
            }
          }

          if (needUpload) {
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
          let needUpload = !existing || existing.sha256 !== sha256;
          if (existing && existing.sha256 === sha256 && existing.drive_file_id) {
            const stillExists = await verifyDriveItemExists(existing.drive_file_id);
            if (!stillExists) {
              needUpload = true;
            }
          }

          if (needUpload) {
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
          let needUpload = !existing || existing.sha256 !== sha256;
          if (existing && existing.sha256 === sha256 && existing.drive_file_id) {
            const stillExists = await verifyDriveItemExists(existing.drive_file_id);
            if (!stillExists) {
              needUpload = true;
            }
          }

          if (needUpload) {
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

    // 4. Lưu dữ liệu media cấp dự án vào MongoDB (VẪN GIỮ KHÓA DỰ ÁN CHO ĐẾN KHI CẬP NHẬT CĂN XONG)
    const interimProjectFields = {
      image_sync_status: 'PROCESSING',
      image_sync_error: '',
      drive_folder_id: projectDoc.drive_folder_id,
      drive_folder_url: projectDoc.drive_folder_url,
      project_image_urls: projectDoc.project_image_urls,
      drive_project_image_urls: projectDoc.drive_project_image_urls,
      floor_plans: projectDoc.floor_plans,
      drive_floor_plan_urls: projectDoc.drive_floor_plan_urls,
      product_layouts: projectDoc.product_layouts,
      drive_layout_image_urls: projectDoc.drive_layout_image_urls,
      documents_classified: projectDoc.documents_classified,
      document_urls: projectDoc.document_urls,
      stored_images: projectDoc.stored_images,
    };

    // Conditional update: chỉ worker đang sở hữu khóa (projectLeaseId) mới được ghi kết quả
    const interimSaveRes = await Project.updateOne(
      {
        _id: projectDoc._id,
        image_sync_lock_owner: projectLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: interimProjectFields,
      }
    );

    if (interimSaveRes.matchedCount === 0) {
      console.warn(
        `[SalePro V3] ⚠️ Khóa dự án ${projectDoc.project_name} (lease: ${projectLeaseId}) đã hết hạn hoặc bị worker khác chiếm. Hủy ghi kết quả.`
      );
      return { status: 'LOCK_EXPIRED', projectId: projectDoc.project_id };
    }

    // ==========================================
    // 5. Lan tỏa và liên kết layout tới từng căn trong MongoDB (Vẫn trong vùng khóa)
    // ==========================================
    const unitsOfProject = await Unit.find({
      source: 'salepro',
      $or: [{ project_id: projectDoc.project_id }, { project_name: projectDoc.project_name }],
    });

    console.log(`  🔗 Đang liên kết layout và tài liệu tới ${unitsOfProject.length} căn thuộc dự án...`);
    let exactCount = 0;
    let typeMatchCount = 0;
    let unmatchedCount = 0;
    let unitUpdateSuccessCount = 0;
    let unitUpdateErrorCount = 0;

    for (const unit of unitsOfProject) {
      // 1. Kiểm tra cờ Heartbeat
      if (projectLockState.isLost) {
        console.warn(
          `[SalePro V3] ⚠️ Tín hiệu Heartbeat báo mất khóa dự án [${projectDoc.project_name}]. Dừng cập nhật căn hộ ngay lập tức.`
        );
        return { status: 'LOCK_LOST_DURING_UNIT_UPDATE', reason: projectLockState.lostReason, projectId: projectDoc.project_id };
      }

      // 2. Thao tác đọc khóa Project: kiểm tra xem khóa dự án có còn hiệu lực trong DB không
      const lockCheck = await Project.findOne({
        _id: projectDoc._id,
        image_sync_lock_owner: projectLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      }).select('image_sync_locked_until');

      if (!lockCheck) {
        console.warn(
          `[SalePro V3] ⚠️ Mất quyền sở hữu khóa dự án ${projectDoc.project_name} trong lúc cập nhật căn hộ. Dừng lan tỏa dữ liệu.`
        );
        return { status: 'LOCK_LOST_DURING_UNIT_UPDATE', projectId: projectDoc.project_id };
      }

      try {
        const { matchLevel, matchedLayout, label } = matchUnitWithProductLayouts(
          unit,
          projectDoc.product_layouts
        );

        const unitUpdatePayload = {
          layout_match_level: matchLevel,
          layout_name: label,
          layout_image_urls: (matchedLayout && matchedLayout.drive_url) ? [matchedLayout.image_url] : [],
          drive_layout_image_urls: (matchedLayout && matchedLayout.drive_url) ? [matchedLayout.drive_url] : [],
          project_image_urls: projectDoc.project_image_urls,
          drive_project_image_urls: projectDoc.drive_project_image_urls,
          floor_plan_urls: (projectDoc.floor_plans || []).map((f) => f.image_url),
          drive_floor_plan_urls: (projectDoc.floor_plans || []).map((f) => f.drive_url).filter(Boolean),
          drive_folder_url: projectDoc.drive_folder_url,
          document_urls: projectDoc.document_urls,
          shared_media_status: 'SYNCED',
        };

        // Căn SalePro không có ảnh chụp riêng -> Ghi nhận trung thực NO_IMAGE
        if (!unit.image_urls || unit.image_urls.length === 0) {
          unitUpdatePayload.image_sync_status = 'NO_IMAGE';
        }

        // 3. KIỂM TRA TÌNH HUỐNG LEASE HẾT HẠN GIỮA THAO TÁC ĐỌC KHÓA VÀ GHI UNIT:
        // Đảm bảo không ghi dữ liệu lỗi thời nếu khóa hết hạn hoặc bị mất trong khoảng trống này
        if (projectLockState.isLost) {
          console.warn(
            `[SalePro V3] ⚠️ Heartbeat báo mất lease trước khi ghi căn [${unit.unit_code}]. Hủy ghi để tránh dữ liệu lỗi thời.`
          );
          return { status: 'LOCK_LOST_DURING_UNIT_UPDATE', reason: projectLockState.lostReason, projectId: projectDoc.project_id };
        }

        // Kiểm tra thời gian hết hạn theo lockCheck vừa đọc: nếu thời điểm hiện tại đã vượt quá locked_until
        if (Date.now() >= new Date(lockCheck.image_sync_locked_until).getTime()) {
          console.warn(
            `[SalePro V3] ⚠️ Khóa dự án đã hết hạn giữa lúc đọc khóa và chuẩn bị ghi căn [${unit.unit_code}]. Hủy ghi dữ liệu lỗi thời.`
          );
          return { status: 'LOCK_LOST_DURING_UNIT_UPDATE', projectId: projectDoc.project_id };
        }

        // Tái xác thực nhanh trên DB trước khi ghi để bảo vệ tuyệt đối chống stale write
        const preWriteValid = await Project.exists({
          _id: projectDoc._id,
          image_sync_lock_owner: projectLeaseId,
          image_sync_locked_until: { $gt: new Date() },
        });

        if (!preWriteValid) {
          console.warn(
            `[SalePro V3] ⚠️ Khóa dự án không còn hiệu lực trên DB ngay trước khi ghi căn [${unit.unit_code}]. Hủy ghi dữ liệu lỗi thời.`
          );
          return { status: 'LOCK_LOST_DURING_UNIT_UPDATE', projectId: projectDoc.project_id };
        }

        // Cập nhật nguyên tử chỉ các trường layout/media (không ghi đè các trường khác của căn)
        await Unit.updateOne(
          { _id: unit._id },
          { $set: unitUpdatePayload }
        );
        unitUpdateSuccessCount++;

        if (matchLevel === 'EXACT') exactCount++;
        else if (matchLevel === 'TYPE_MATCH') typeMatchCount++;
        else unmatchedCount++;
      } catch (unitErr) {
        unitUpdateErrorCount++;
        console.warn(`[SalePro V3] ⚠️ Lỗi cập nhật căn [${unit.unit_code}]:`, unitErr.message);
      }
    }

    stats.unitCount = unitsOfProject.length;
    stats.exactCount = exactCount;
    stats.typeMatchCount = typeMatchCount;
    stats.unmatchedCount = unmatchedCount;

    // Xác định trạng thái đồng bộ chính xác sau khi TOÀN BỘ căn đã xử lý
    let finalStatus = 'SUCCESS';
    let finalError = '';

    if (stats.totalFetched === 0) {
      finalStatus = 'NO_IMAGE';
    } else if (stats.errorCount > 0 || unitUpdateErrorCount > 0) {
      finalStatus = stats.uploadedCount > 0 || unitUpdateSuccessCount > 0 ? 'PARTIAL' : 'FAILED';
      finalError = [
        stats.errorCount > 0 ? `${stats.errorCount} file tải/upload thất bại` : '',
        unitUpdateErrorCount > 0 ? `${unitUpdateErrorCount}/${unitsOfProject.length} căn cập nhật layout thất bại` : '',
      ]
        .filter(Boolean)
        .join('; ');
    } else {
      finalStatus = 'SUCCESS';
    }

    // 6. GIẢI PHÓNG KHÓA DỰ ÁN VÀ CẬP NHẬT TRẠNG THÁI CUỐI CÙNG
    if (projectLockState.isLost) {
      console.warn(
        `[SalePro V3] ⚠️ Tín hiệu Heartbeat báo mất khóa dự án [${projectDoc.project_name}] trước khi cập nhật cuối cùng. Hủy ghi kết quả.`
      );
      return {
        status: 'LOCK_LOST_AT_FINAL_UPDATE',
        projectId: projectDoc.project_id,
        error: 'Heartbeat lost lease before final status update',
      };
    }

    const finalProjectFields = {
      image_sync_status: finalStatus,
      image_sync_error: finalError,
      image_sync_locked_until: null,
      image_sync_lock_owner: null,
    };

    // QUAN TRỌNG: CHỈ set media_schema_version = 3 khi SUCCESS hoặc NO_IMAGE (không còn lỗi nào)
    if (finalStatus === 'SUCCESS' || finalStatus === 'NO_IMAGE') {
      finalProjectFields.media_schema_version = 3;
      finalProjectFields.media_synced_at = new Date();
    }

    const finalUpdateRes = await Project.updateOne(
      {
        _id: projectDoc._id,
        image_sync_lock_owner: projectLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: finalProjectFields,
      }
    );

    if (finalUpdateRes.matchedCount === 0) {
      console.warn(
        `[SalePro V3] ⚠️ Không thể cập nhật trạng thái cuối cùng cho dự án [${projectDoc.project_name}] vì mất quyền sở hữu khóa hoặc khóa đã hết hạn.`
      );
      return {
        status: 'LOCK_LOST_AT_FINAL_UPDATE',
        projectId: projectDoc.project_id,
        error: 'Worker lost project lock or lease expired before final status update',
      };
    }

    console.log(`  ✅ Hoàn tất liên kết:`);
    console.log(`     • Khớp chính xác (EXACT): ${exactCount} căn`);
    console.log(`     • Khớp loại tham khảo (TYPE_MATCH): ${typeMatchCount} căn`);
    console.log(`     • Chưa liên kết được (UNMATCHED): ${unmatchedCount} căn`);
    if (unitUpdateErrorCount > 0) {
      console.warn(`     • Cập nhật thất bại: ${unitUpdateErrorCount} căn (Dự án được đánh dấu PARTIAL để retry)`);
    }
    console.log(`====================================================================\n`);

    return {
      status: finalStatus,
      ...stats,
    };
  } catch (err) {
    console.error(`[SalePro Media V3] ❌ Lỗi nghiêm trọng đồng bộ dự án ${projectDoc.project_name}:`, err.message);
    await Project.updateOne(
      {
        _id: projectDoc._id,
        image_sync_lock_owner: projectLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: {
          image_sync_status: 'FAILED',
          image_sync_error: err.message,
          image_sync_locked_until: null,
          image_sync_lock_owner: null,
        },
      }
    ).catch(() => {});
    return { status: 'FAILED', error: err.message };
  } finally {
    if (projectHeartbeatTimer) {
      clearInterval(projectHeartbeatTimer);
      projectHeartbeatTimer = null;
    }
  }
}

/**
 * Xử lý đồng bộ hình ảnh cho một bản ghi Unit cụ thể (HiSale hoặc SalePro căn riêng)
 */
async function syncSingleUnit(unitDoc, leaseId = null) {
  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    return { status: 'SKIPPED_DRIVE_DISABLED', unit_code: unitDoc.unit_code };
  }

  const effectiveLeaseId = leaseId || unitDoc.image_sync_lock_owner || crypto.randomUUID();

  // Đảm bảo document đã được khóa nguyên tử với leaseId (ngăn tranh chấp worker)
  if (!unitDoc.image_sync_lock_owner || unitDoc.image_sync_lock_owner !== effectiveLeaseId) {
    const lockedUnit = await Unit.findOneAndUpdate(
      {
        _id: unitDoc._id,
        $or: [
          { image_sync_status: { $ne: 'PROCESSING' } },
          { image_sync_locked_until: { $lt: new Date() } },
          { image_sync_locked_until: null },
        ],
      },
      {
        $set: {
          image_sync_status: 'PROCESSING',
          image_sync_locked_until: new Date(Date.now() + LOCK_TIMEOUT_MS),
          image_sync_lock_owner: effectiveLeaseId,
        },
        $inc: { image_sync_retries: 1 },
      },
      { new: true }
    );
    if (!lockedUnit) {
      console.warn(`[ImageSync] ℹ️ Căn ${unitDoc.unit_code} đang được xử lý bởi worker khác.`);
      return { status: 'LOCKED_BY_OTHER', unit_code: unitDoc.unit_code };
    }
  } else {
    // Gia hạn lease khi worker thực sự bắt đầu xử lý căn (tránh hết hạn do xếp hàng trong batch lớn)
    const renewed = await Unit.updateOne(
      {
        _id: unitDoc._id,
        image_sync_lock_owner: effectiveLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: {
          image_sync_locked_until: new Date(Date.now() + LOCK_TIMEOUT_MS),
        },
      }
    );
    if (renewed.matchedCount === 0) {
      return { status: 'LOCK_EXPIRED', unit_code: unitDoc.unit_code };
    }
  }

  const srcLower = (unitDoc.source || 'hisale').toLowerCase();
  const sourceName = srcLower === 'hisale' ? 'HiSale' : srcLower === 'vhub' ? 'VHub' : 'SalePro';
  const rawUrls = Array.isArray(unitDoc.image_urls) ? unitDoc.image_urls.filter(Boolean) : [];

  // Tách tài liệu (Excel, PDF, Word, v.v.) bị up nhầm vào image_urls
  const DOCUMENT_EXTENSIONS = ['.xlsx', '.xls', '.pdf', '.doc', '.docx', '.csv', '.zip', '.rar'];
  unitDoc.document_urls = Array.isArray(unitDoc.document_urls) ? unitDoc.document_urls : [];
  const urlsToSync = [];
  let hasMisplacedDocs = false;

  for (const u of rawUrls) {
    const cleanUrl = String(u).split('?')[0].split('#')[0].toLowerCase();
    const isDoc = DOCUMENT_EXTENSIONS.some((ext) => cleanUrl.endsWith(ext));
    if (isDoc) {
      hasMisplacedDocs = true;
      if (!unitDoc.document_urls.includes(u)) {
        unitDoc.document_urls.push(u);
      }
    } else {
      urlsToSync.push(u);
    }
  }

  if (hasMisplacedDocs) {
    unitDoc.image_urls = urlsToSync;
  }

  // Thu thập danh sách tài liệu / bảng tính / thư mục ngoài cần đồng bộ sang Drive nội bộ
  const docsToSync = [];
  const seenDocUrls = new Set();
  const foldersToSync = [];
  const seenFolderIds = new Set();

  function addDocCandidate(url) {
    if (!url || typeof url !== 'string') return;
    const trimmed = url.trim();
    if (!trimmed) return;

    const folderId = extractDriveFolderId(trimmed);
    if (folderId) {
      if (!seenFolderIds.has(folderId)) {
        seenFolderIds.add(folderId);
        foldersToSync.push(folderId);
      }
      return;
    }

    if (seenDocUrls.has(trimmed)) return;
    const driveId = extractDriveFileId(trimmed);
    const clean = trimmed.split('?')[0].split('#')[0].toLowerCase();
    const isDocExt = DOCUMENT_EXTENSIONS.some((ext) => clean.endsWith(ext));
    if (driveId || isDocExt) {
      seenDocUrls.add(trimmed);
      docsToSync.push(trimmed);
    }
  }

  for (const docUrl of unitDoc.document_urls) {
    addDocCandidate(docUrl);
  }
  if (unitDoc.price_list_url) {
    addDocCandidate(unitDoc.price_list_url);
  }

  // Quét các file nằm trong thư mục Google Drive ngoài (nếu có)
  if (foldersToSync.length > 0) {
    try {
      const drive = getDriveClient();
      for (const extFolderId of foldersToSync) {
        try {
          let folderPageToken;
          do {
          const listRes = await drive.files.list({
            q: `'${extFolderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
            fields: 'nextPageToken, files(id, name, mimeType, size)',
            pageSize: 1000,
            pageToken: folderPageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          const folderFiles = listRes.data.files || [];
          for (const f of folderFiles) {
            const fileDownloadUrl = `https://drive.google.com/file/d/${f.id}`;
            if (!seenDocUrls.has(fileDownloadUrl)) {
              seenDocUrls.add(fileDownloadUrl);
              docsToSync.push(fileDownloadUrl);
            }
          }
          folderPageToken = listRes.data.nextPageToken;
          } while (folderPageToken);
        } catch (fErr) {
          console.warn(`[ImageSync] ⚠️ Không thể duyệt thư mục Drive ngoài (${extFolderId}):`, fErr.message);
        }
      }
    } catch (_) {}
  }

  // Nếu là SalePro và căn không có ảnh riêng và không có tài liệu riêng:
  if (sourceName === 'SalePro' && urlsToSync.length === 0 && docsToSync.length === 0) {
    const noImgRes = await Unit.updateOne(
      {
        _id: unitDoc._id,
        image_sync_lock_owner: effectiveLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: {
          image_sync_status: 'NO_IMAGE',
          image_sync_locked_until: null,
          image_sync_lock_owner: null,
          image_synced_at: new Date(),
          ...(hasMisplacedDocs ? { image_urls: [], document_urls: unitDoc.document_urls } : {}),
        },
      }
    );
    if (noImgRes.matchedCount === 0) {
      return { status: 'LOCK_EXPIRED', unit_code: unitDoc.unit_code };
    }
    return { status: 'NO_IMAGE', unit_code: unitDoc.unit_code };
  }

  if (urlsToSync.length === 0 && docsToSync.length === 0) {
    const noImgRes = await Unit.updateOne(
      {
        _id: unitDoc._id,
        image_sync_lock_owner: effectiveLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: {
          image_sync_status: 'NO_IMAGE',
          image_sync_locked_until: null,
          image_sync_lock_owner: null,
          image_synced_at: new Date(),
          ...(hasMisplacedDocs ? { image_urls: [], document_urls: unitDoc.document_urls } : {}),
        },
      }
    );
    if (noImgRes.matchedCount === 0) {
      return { status: 'LOCK_EXPIRED', unit_code: unitDoc.unit_code };
    }
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
    let permanentFailCount = 0;

    for (let index = 0; index < urlsToSync.length; index++) {
      const originalUrl = urlsToSync[index];

      try {
        const existingStored = unitDoc.stored_images.find((img) => img.original_url === originalUrl);
        if (
          existingStored &&
          existingStored.sha256 &&
          existingStored.drive_file_id &&
          existingStored.drive_url &&
          extractDriveFileId(originalUrl)
        ) {
          const stillExists = await verifyDriveItemExists(existingStored.drive_file_id);
          if (stillExists) {
            if (!unitDoc.drive_image_urls.includes(existingStored.drive_url)) {
              unitDoc.drive_image_urls.push(existingStored.drive_url);
            }
            successCount++;
            continue;
          }
        }

        const { buffer, mimeType, ext, etag, lastModified, originalName } = await downloadBufferWithRetry(
          originalUrl,
          DEFAULT_MAX_RETRIES,
          { allowDrivePdf: sourceName === 'VHub' }
        );
        const sha256 = computeSha256(buffer);

        let needUpload = !existingStored || existingStored.sha256 !== sha256;
        if (existingStored && existingStored.sha256 === sha256 && existingStored.drive_file_id) {
          const stillExists = await verifyDriveItemExists(existingStored.drive_file_id);
          if (!stillExists) {
            needUpload = true;
          }
        }

        if (!needUpload && existingStored && existingStored.drive_url) {
          if (!unitDoc.drive_image_urls.includes(existingStored.drive_url)) {
            unitDoc.drive_image_urls.push(existingStored.drive_url);
          }
          successCount++;
          continue;
        }

        const duplicateHash = unitDoc.stored_images.find((img) => img.sha256 === sha256 && img.drive_url);
        if (duplicateHash) {
          let dupStillExists = true;
          if (duplicateHash.drive_file_id) {
            dupStillExists = await verifyDriveItemExists(duplicateHash.drive_file_id);
          }
          if (dupStillExists) {
            if (!unitDoc.drive_image_urls.includes(duplicateHash.drive_url)) {
              unitDoc.drive_image_urls.push(duplicateHash.drive_url);
            }
            unitDoc.stored_images = unitDoc.stored_images.filter((img) => img.original_url !== originalUrl);
            unitDoc.stored_images.push({
              original_url: originalUrl,
              drive_file_id: duplicateHash.drive_file_id,
              drive_url: duplicateHash.drive_url,
              sha256,
              mime_type: mimeType,
              file_size: buffer.length,
              etag,
              last_modified: lastModified,
              image_type: 'UNIT',
              uploaded_at: new Date(),
            });
            successCount++;
            continue;
          }
        }

        const fileName =
          ext === 'pdf' && originalName
            ? sanitizeDriveName(originalName)
            : `image_${String(index + 1).padStart(2, '0')}.${ext}`;
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

        // Conditional intermediate update: chỉ ghi nếu worker vẫn nắm lease hợp lệ
        const interUpdate = await Unit.updateOne(
          {
            _id: unitDoc._id,
            image_sync_lock_owner: effectiveLeaseId,
            image_sync_locked_until: { $gt: new Date() },
          },
          {
            $set: {
              stored_images: unitDoc.stored_images,
              drive_image_urls: unitDoc.drive_image_urls,
              drive_folder_id: unitDoc.drive_folder_id,
              drive_folder_url: unitDoc.drive_folder_url,
              image_sync_locked_until: new Date(Date.now() + LOCK_TIMEOUT_MS),
            },
          }
        );

        if (interUpdate.matchedCount === 0) {
          throw new Error(
            `LOCK_LOST: Khóa căn ${unitDoc.unit_code} đã hết hạn hoặc bị worker khác chiếm (lease: ${effectiveLeaseId})`
          );
        }

        successCount++;
      } catch (uploadErr) {
        if (uploadErr.message && uploadErr.message.startsWith('LOCK_LOST:')) {
          throw uploadErr;
        }
        if (
          uploadErr.message &&
          (uploadErr.message.includes('spreadsheetml') ||
            uploadErr.message.includes('excel') ||
            uploadErr.message.includes('pdf') ||
            uploadErr.message.includes('msword') ||
            uploadErr.message.includes('officedocument') ||
            uploadErr.message.includes('google-apps'))
        ) {
          console.warn(
            `[ImageSync] ℹ️ File [${originalUrl}] của căn ${unitDoc.unit_code} là tài liệu (không phải ảnh), tự động chuyển sang danh mục tài liệu.`
          );
          unitDoc.document_urls = unitDoc.document_urls || [];
          if (!unitDoc.document_urls.includes(originalUrl)) {
            unitDoc.document_urls.push(originalUrl);
          }
          unitDoc.image_urls = (unitDoc.image_urls || []).filter((u) => u !== originalUrl);
          hasMisplacedDocs = true;
          continue;
        }
        failCount++;
        const errMsg = String(uploadErr.message || '');
        if (
          errMsg.includes('PERMANENT_DEAD_FILE:') ||
          errMsg.includes('thùng rác') ||
          errMsg.includes('File not found')
        ) {
          permanentFailCount++;
        }
        unitDoc.image_sync_error = uploadErr.message;
        console.warn(
          `[ImageSync] ⚠️ Lỗi tải ảnh [${originalUrl}] của căn ${unitDoc.unit_code}:`,
          uploadErr.message
        );
      }
    }

    // ==========================================
    // Đồng bộ tài liệu và bảng tính (Docs / Google Sheets / PDFs) sang thư mục Drive nội bộ
    // ==========================================
    for (let dIndex = 0; dIndex < docsToSync.length; dIndex++) {
      const docUrl = docsToSync[dIndex];
      try {
        const existingStored = unitDoc.stored_images.find((img) => img.original_url === docUrl);
        if (
          existingStored &&
          existingStored.sha256 &&
          existingStored.drive_file_id &&
          existingStored.drive_url &&
          extractDriveFileId(docUrl)
        ) {
          const stillExists = await verifyDriveItemExists(existingStored.drive_file_id);
          if (stillExists) {
            successCount++;
            continue;
          }
        }

        const { buffer, mimeType, ext, etag, lastModified, originalName } = await downloadBufferWithRetry(
          docUrl,
          DEFAULT_MAX_RETRIES,
          { allowDrivePdf: true, allowDriveDoc: true }
        );
        const sha256 = computeSha256(buffer);

        let needUpload = !existingStored || existingStored.sha256 !== sha256;
        if (existingStored && existingStored.sha256 === sha256 && existingStored.drive_file_id) {
          const stillExists = await verifyDriveItemExists(existingStored.drive_file_id);
          if (!stillExists) {
            needUpload = true;
          }
        }

        if (!needUpload && existingStored && existingStored.drive_url) {
          successCount++;
          continue;
        }

        const fileName =
          originalName
            ? sanitizeDriveName(originalName)
            : `Bang_tinh_gia_${unitDoc.unit_code}.${ext || 'xlsx'}`;

        const uploaded = await uploadFile({
          name: fileName,
          buffer,
          mimeType,
          parentFolderId: folder.id,
          description: `Tài liệu/Bảng tính giá căn ${unitDoc.unit_code} - Dự án ${unitDoc.project_name}`,
        });

        unitDoc.stored_images = unitDoc.stored_images.filter((img) => img.original_url !== docUrl);
        unitDoc.stored_images.push({
          original_url: docUrl,
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

        await Unit.updateOne(
          {
            _id: unitDoc._id,
            image_sync_lock_owner: effectiveLeaseId,
            image_sync_locked_until: { $gt: new Date() },
          },
          {
            $set: {
              stored_images: unitDoc.stored_images,
              drive_folder_id: unitDoc.drive_folder_id,
              drive_folder_url: unitDoc.drive_folder_url,
              image_sync_locked_until: new Date(Date.now() + LOCK_TIMEOUT_MS),
            },
          }
        );

        successCount++;
      } catch (docErr) {
        failCount++;
        const errMsg = String(docErr.message || '');
        if (
          errMsg.includes('PERMANENT_DEAD_FILE:') ||
          errMsg.includes('thùng rác') ||
          errMsg.includes('File not found')
        ) {
          permanentFailCount++;
        }
        unitDoc.image_sync_error = docErr.message;
        console.warn(`[ImageSync] ⚠️ Lỗi tải tài liệu/bảng tính [${docUrl}] của căn ${unitDoc.unit_code}:`, docErr.message);
      }
    }

    const totalItems = urlsToSync.length + docsToSync.length;
    let finalStatus = 'SUCCESS';
    if (totalItems === 0) {
      finalStatus = 'NO_IMAGE';
      unitDoc.image_sync_error = '';
    } else if (successCount === totalItems) {
      finalStatus = 'SUCCESS';
      unitDoc.image_sync_error = '';
    } else if (successCount > 0) {
      finalStatus = 'PARTIAL';
    } else {
      finalStatus = 'FAILED';
    }

    // Nếu thất bại hoàn toàn do file gốc đã bị xóa vĩnh viễn / vào thùng rác, đánh dấu hết retry để không lặp vô hạn
    const allFailuresPermanent = failCount > 0 && permanentFailCount === failCount;
    const retryUpdate =
      finalStatus === 'FAILED' || finalStatus === 'PARTIAL'
        ? allFailuresPermanent
          ? { image_sync_retries: DEFAULT_MAX_RETRIES }
          : { image_sync_retries: Math.min(DEFAULT_MAX_RETRIES, Number(unitDoc.image_sync_retries || 0) + 1) }
        : {};

    // Conditional final update: chỉ ghi nếu worker sở hữu lease hợp lệ
    const finalUpdate = await Unit.updateOne(
      {
        _id: unitDoc._id,
        image_sync_lock_owner: effectiveLeaseId,
        image_sync_locked_until: { $gt: new Date() },
      },
      {
        $set: {
          image_sync_status: finalStatus,
          image_sync_error: unitDoc.image_sync_error || '',
          drive_folder_id: unitDoc.drive_folder_id,
          drive_folder_url: unitDoc.drive_folder_url,
          drive_image_urls: unitDoc.drive_image_urls,
          stored_images: unitDoc.stored_images,
          image_synced_at: new Date(),
          image_sync_locked_until: null,
          image_sync_lock_owner: null,
          ...retryUpdate,
          ...(hasMisplacedDocs ? { image_urls: unitDoc.image_urls, document_urls: unitDoc.document_urls } : {}),
        },
      }
    );

    if (finalUpdate.matchedCount === 0) {
      console.warn(
        `[ImageSync] ⚠️ Lease (${effectiveLeaseId}) của căn ${unitDoc.unit_code} đã hết hạn. Hủy ghi kết quả để tránh race condition.`
      );
      return {
        status: 'LOCK_EXPIRED',
        unit_code: unitDoc.unit_code,
        successCount,
        failCount,
      };
    }

    return {
      status: finalStatus,
      unit_code: unitDoc.unit_code,
      successCount,
      failCount,
    };
  } catch (err) {
    if (err.message && err.message.startsWith('LOCK_LOST:')) {
      console.warn(`[ImageSync] ⚠️ ${err.message}`);
      return { status: 'LOCK_EXPIRED', unit_code: unitDoc.unit_code, error: err.message };
    }
    await Unit.updateOne(
      { _id: unitDoc._id, image_sync_lock_owner: effectiveLeaseId },
      {
        $set: {
          image_sync_status: 'FAILED',
          image_sync_error: err.message,
          image_sync_locked_until: null,
          image_sync_lock_owner: null,
        },
      }
    ).catch(() => {});
    return { status: 'FAILED', unit_code: unitDoc.unit_code, error: err.message };
  }
}

/**
 * Xử lý một batch danh sách căn theo mô hình Worker Pool (luồng nào xong trước lập tức bốc căn tiếp theo, không chờ đợi chéo)
 */
async function processBatchWithConcurrency(units, concurrency = DEFAULT_CONCURRENCY) {
  const results = new Array(units.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < units.length) {
      const currentIndex = nextIndex++;
      const unit = units[currentIndex];
      results[currentIndex] = await syncSingleUnit(unit, unit._leaseId);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), units.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
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
        {
          image_sync_status: { $in: ['PENDING', 'PARTIAL'] },
          $or: [
            { image_sync_retries: { $lt: DEFAULT_MAX_RETRIES } },
            { image_sync_retries: { $exists: false } },
          ],
        },
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

    // Phát hiện các căn có ảnh mới hoặc URL ảnh bị thay thế (kể cả khi tổng số lượng URL không đổi)
    filterConditions.push({
      image_sync_status: 'SUCCESS',
      $expr: {
        $gt: [
          {
            $size: {
              $setDifference: [
                { $ifNull: ['$image_urls', []] },
                { $ifNull: ['$stored_images.original_url', []] },
              ],
            },
          },
          0,
        ],
      },
    });

    // Căn chưa có thư mục Drive nhưng có tài liệu / bảng tính cần đồng bộ
    filterConditions.push({
      $and: [
        {
          $or: [
            { drive_folder_url: null },
            { drive_folder_url: '' },
            { drive_folder_url: { $exists: false } },
          ],
        },
        {
          $or: [
            { 'document_urls.0': { $exists: true } },
            { price_list_url: { $regex: /(?:drive\.google\.com|docs\.google\.com)/i } },
          ],
        },
        {
          $or: [
            { image_sync_retries: { $lt: DEFAULT_MAX_RETRIES } },
            { image_sync_retries: { $exists: false } },
          ],
        },
      ],
    });

    const hasMediaConditions = [
      { 'image_urls.0': { $exists: true } },
      { 'document_urls.0': { $exists: true } },
      { price_list_url: { $regex: /(?:drive\.google\.com|docs\.google\.com)/i } },
    ];

    const query = {
      $and: [
        { $or: filterConditions },
        { $or: hasMediaConditions },
      ],
    };
    if (source && source !== 'all') {
      query.source = source.toLowerCase();
    }

    const candidateUnits = await Unit.find(query)
      .sort({ created_at: -1 })
      .limit(batchSize);

    if (candidateUnits.length === 0) {
      console.log(`[ImageSync] ✨ Không còn căn [${source}] nào đang chờ đồng bộ hình ảnh.`);
      return { total: 0, success: 0 };
    }

    // Khóa nguyên tử (Atomic locking) với lease ID để ngăn tranh chấp giữa CLI và background Scheduler
    const pendingUnits = [];
    for (const rawUnit of candidateUnits) {
      const leaseId = crypto.randomUUID();
      const lockedUnit = await Unit.findOneAndUpdate(
        {
          _id: rawUnit._id,
          $or: [
            { image_sync_status: { $ne: 'PROCESSING' } },
            { image_sync_locked_until: { $lt: new Date() } },
            { image_sync_locked_until: null },
          ],
        },
        {
          $set: {
            image_sync_status: 'PROCESSING',
            image_sync_locked_until: new Date(Date.now() + LOCK_TIMEOUT_MS),
            image_sync_lock_owner: leaseId,
          },
        },
        { new: true }
      );
      if (lockedUnit) {
        lockedUnit._leaseId = leaseId;
        pendingUnits.push(lockedUnit);
      }
    }

    if (pendingUnits.length === 0) {
      console.log(`[ImageSync] ℹ️ Các bản ghi hiện đang được xử lý bởi tiến trình khác.`);
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

/**
 * Tự động đồng bộ media cho các dự án SalePro V3 theo batch (Cron Job & CLI)
 */
async function syncPendingProjectMedia({ limit = 10, force = false } = {}) {
  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    console.log(`[ProjectMediaSync] ℹ️ Google Drive chưa bật, bỏ qua.`);
    return { enabled: false, reason: driveCheck.reason };
  }

  const query = { source: 'salepro' };
  if (!force) {
    query.$or = [
      { media_schema_version: { $exists: false } },
      { media_schema_version: { $lt: 3 } },
      { image_sync_status: { $in: ['PENDING', 'PARTIAL', 'FAILED'] } },
      { media_synced_at: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    ];
  }

  const projects = await Project.find(query)
    .sort({ media_schema_version: 1, media_synced_at: 1, apartment_count: -1 })
    .limit(limit);

  if (projects.length === 0) {
    console.log('[ProjectMediaSync] ✨ Tất cả dự án SalePro đã được đồng bộ đầy đủ media V3.');
    return { total: 0, results: [] };
  }

  console.log(`\n====================================================================`);
  console.log(`📁 [PROJECT MEDIA SYNC] TỰ ĐỘNG ĐỒNG BỘ ${projects.length} DỰ ÁN SALEPRO V3`);
  console.log(`====================================================================`);

  const results = [];
  for (const proj of projects) {
    const res = await syncSaleProProjectMedia(proj);
    results.push(res);
  }

  return { total: projects.length, results };
}

module.exports = {
  syncPendingImages,
  syncPendingProjectMedia,
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
