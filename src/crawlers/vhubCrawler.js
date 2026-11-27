const { trackedBulkWrite, markMissing } = require('../services/inventoryHistory');
const axios = require('axios');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const { getVhubApiBaseUrl, getVhubSession } = require('../services/vhubAuth');

const DEFAULT_PAGE_LIMIT = 200;
const BULK_WRITE_BATCH_SIZE = 500;
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const DOCUMENT_EXTENSIONS = ['.xlsx', '.xls', '.pdf', '.doc', '.docx', '.csv', '.zip', '.rar'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.avif'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Phân tích cấu hình VHUB_PROJECT_IDS từ .env (trả về null nếu 'ALL' hoặc Set các slug dự án)
 */
function parseVhubProjectScope() {
  const raw = (process.env.VHUB_PROJECT_IDS || 'ALL').trim();
  if (!raw || raw.toUpperCase() === 'ALL') {
    return null;
  }
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * Chuyển giá trị chuỗi/số thành Number hợp lệ hoặc fallback
 */
function toNumber(val, fallback = 0) {
  if (val === null || val === undefined || val === '') return fallback;
  const num = Number(val);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Định dạng text giá bán (tỷ / triệu)
 */
function formatPriceText(price) {
  const num = Number(price);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)} tỷ`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(0)} triệu`;
  return `${num.toLocaleString('vi-VN')} đ`;
}

/**
 * Trích xuất Google Drive file ID nếu URL là link file Google Drive (không phải folder/sheets)
 */
function extractDriveFileId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!/drive\.google\.com/i.test(trimmed) || trimmed.includes('/folders/')) {
    return null;
  }
  const fileMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  return null;
}

/**
 * Phân loại URL là ảnh tải trực tiếp hoặc link file Drive có thể tải ảnh về
 */
function isDirectImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (
    lower.includes('/folders/') ||
    lower.includes('docs.google.com') ||
    lower.includes('bom.so')
  ) {
    return false;
  }

  if (extractDriveFileId(trimmed)) {
    return true;
  }

  const cleanPath = lower.split('?')[0].split('#')[0];
  if (DOCUMENT_EXTENSIONS.some((ext) => cleanPath.endsWith(ext))) {
    return false;
  }
  if (IMAGE_EXTENSIONS.some((ext) => cleanPath.endsWith(ext))) {
    return true;
  }

  return false;
}

/**
 * Phân loại danh mục tài liệu ebrochure của VHub
 */
function classifyVhubDocument(title = '', url = '') {
  const text = `${title} ${url}`.toLowerCase();
  if (text.includes('giá') || text.includes('gia') || text.includes('price')) return 'BANG_GIA';
  if (text.includes('csbh') || text.includes('chính sách') || text.includes('policy')) return 'CSBH';
  if (text.includes('layout') || text.includes('mặt bằng') || text.includes('mat bang') || text.includes('thiết kế')) {
    return 'LAYOUT';
  }
  if (text.includes('pháp lý') || text.includes('hợp đồng') || text.includes('hdmb')) return 'PHAP_LY';
  if (text.includes('biểu mẫu') || text.includes('đặt cọc')) return 'BIEU_MAU';
  return 'OTHER';
}

/**
 * Gọi GET API VHub kèm tự động làm mới token nếu gặp lỗi 401
 */
async function fetchVhubGet(endpoint, params = {}, sessionState) {
  const baseURL = getVhubApiBaseUrl();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(`${baseURL}${endpoint}`, {
        params,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${sessionState.current.accessToken}`,
          Origin: 'https://vhub.com.vn',
          Referer: 'https://vhub.com.vn/',
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (attempt === 0 && (status === 401 || status === 403)) {
        console.warn(`[VHub] Token hết hạn (HTTP ${status}) tại ${endpoint}. Đang làm mới phiên đăng nhập...`);
        sessionState.current = await getVhubSession(true);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Lấy danh sách toàn bộ dự án (tours) đang công bố từ /tours/published và lưu vào MongoDB Project
 */
async function fetchAndSaveVhubProjects(sessionState, projectScope = null) {
  const allTours = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const resData = await fetchVhubGet('/tours/published', { page, limit: 100 }, sessionState);
    const items = Array.isArray(resData?.data) ? resData.data : [];
    allTours.push(...items);

    const meta = resData?.meta;
    hasNext = Boolean(meta && meta.hasNextPage);
    page++;
    if (page > 20) break; // Chặn vòng lặp an toàn
  }

  const filteredTours = projectScope
    ? allTours.filter((t) => projectScope.has(String(t.id)))
    : allTours;

  const projectMap = new Map();
  const projectDocsToSave = [];

  for (const tour of filteredTours) {
    const projectId = String(tour.id || '').trim();
    const projectName = String(tour.name || tour.title || projectId).trim().toUpperCase();
    if (!projectId || !projectName) continue;

    const ui = tour.uiSettings || {};
    const typeLabelNorm = String(ui.typeLabel || '').toLowerCase();
    let projectType = '';
    if (typeLabelNorm.includes('cao tầng') || typeLabelNorm.includes('cao tang')) {
      projectType = 'high_rise';
    } else if (typeLabelNorm.includes('thấp tầng') || typeLabelNorm.includes('thap tang')) {
      projectType = 'low_rise';
    }

    // Gom ảnh phối cảnh dự án từ thumb, gallery và projectInfo hero blocks
    const projImages = new Set();
    if (isDirectImageUrl(tour.thumb)) projImages.add(tour.thumb);
    if (Array.isArray(ui.gallery)) {
      ui.gallery.forEach((g) => {
        if (g && Array.isArray(g.value)) {
          g.value.forEach((imgUrl) => {
            if (isDirectImageUrl(imgUrl)) projImages.add(imgUrl);
          });
        }
      });
    }
    if (ui.projectInfo && Array.isArray(ui.projectInfo.blocks)) {
      ui.projectInfo.blocks.forEach((b) => {
        if (b && b.type === 'hero' && Array.isArray(b.data)) {
          b.data.forEach((imgUrl) => {
            if (isDirectImageUrl(imgUrl)) projImages.add(imgUrl);
          });
        }
      });
    }

    // Gom tài liệu ebrochure của dự án
    const docUrls = new Set();
    const docsClassified = [];
    if (Array.isArray(ui.ebrochure)) {
      ui.ebrochure.forEach((doc) => {
        if (doc && doc.url) {
          docUrls.add(doc.url);
          docsClassified.push({
            title: String(doc.title || '').trim(),
            category: classifyVhubDocument(doc.title, doc.url),
            source_url: doc.url,
            target_url: doc.url,
          });
        }
      });
    }

    const investors = Array.isArray(tour.investors)
      ? tour.investors.join(', ')
      : String(ui.investor || tour.investor || '').trim();

    const projectInfo = {
      source: 'vhub',
      project_id: projectId,
      project_code: projectId,
      project_name: projectName,
      project_slug: projectId,
      project_type: projectType,
      investor: investors,
      project_address: String(ui.address || '').trim(),
      state: 'public',
      out_of_stock: Number(tour.availableCount) > 0 ? 0 : 1,
      apartment_count: Number(tour.productCount) || 0,
      project_image_urls: Array.from(projImages),
      document_urls: Array.from(docUrls),
      documents_classified: docsClassified,
      raw_data: {
        id: tour.id,
        title: tour.title,
        status: tour.status,
        typeLabel: ui.typeLabel || '',
        region: ui.region || '',
        address: ui.address || '',
        productCount: tour.productCount || 0,
        availableCount: tour.availableCount || 0,
      },
      updated_at: new Date(),
    };

    projectMap.set(projectId, projectInfo);
    projectDocsToSave.push(projectInfo);
  }

  if (projectDocsToSave.length > 0) {
    const bulkProjOps = projectDocsToSave.map((p) => ({
      updateOne: {
        filter: { source: 'vhub', project_id: p.project_id },
        update: { $set: p },
        upsert: true,
      },
    }));
    await Project.bulkWrite(bulkProjOps, { ordered: false });
  }

  return { projectMap, totalTours: filteredTours.length };
}

/**
 * Chuẩn hóa 1 bản ghi sản phẩm từ API /products/published của VHub thành schema Unit dùng chung
 */
function normalizeVhubUnit(item, projectMap) {
  if (!item || typeof item !== 'object') return null;
  if (item.isNotShow === true) return null;


  const unitCode = String(item.productCode || item.productName || '').trim();
  if (!unitCode) return null;

  const projectId = String(item.projectId || '').trim();
  const matchedProj = projectMap.get(projectId);
  const projectName = String(matchedProj?.project_name || item.projectName || projectId)
    .trim()
    .toUpperCase();
  if (!projectName) return null;

  // Phân loại diện tích theo cao tầng / thấp tầng
  const isHighRise = String(item.productType || '').toLowerCase() === 'cao_tang';
  const areaLand = isHighRise
    ? toNumber(item.carpetArea) || toNumber(item.landArea)
    : toNumber(item.landArea) || toNumber(item.carpetArea);
  const areaBuild = isHighRise
    ? toNumber(item.builtUpArea) || toNumber(item.constructionArea)
    : toNumber(item.constructionArea) || toNumber(item.builtUpArea);

  const price =
    toNumber(item.totalPrice) ||
    toNumber(item.progressPaymentPrice) ||
    toNumber(item.loanPrice) ||
    toNumber(item.samplePrice);
  const priceTts = toNumber(item.earlyPaymentPrice);

  // Phân tách rõ URL ảnh trực tiếp và URL tài liệu / link Drive bên ngoài
  const imageUrls = new Set();
  const documentUrls = new Set();
  const layoutImageUrls = new Set();

  const rawMedia = [
    ...(Array.isArray(item.productImages) ? item.productImages : []),
    ...(Array.isArray(item.pricingSheetImages) ? item.pricingSheetImages : []),
  ];

  const seenDriveFileIds = new Set();
  for (const url of rawMedia) {
    if (!url || typeof url !== 'string') continue;
    const trimmed = url.trim();
    if (isDirectImageUrl(trimmed)) {
      const driveId = extractDriveFileId(trimmed);
      if (driveId) {
        if (seenDriveFileIds.has(driveId)) continue;
        seenDriveFileIds.add(driveId);
      }
      imageUrls.add(trimmed);
    } else if (/^https?:\/\//i.test(trimmed)) {
      documentUrls.add(trimmed);
    }
  }

  // Các link tài liệu & bảng tính đính kèm từ API VHub
  const extraDocLinks = [
    item.xSaleLinkFull,
    item.xSaleLinkSummary,
    item.xLinkLayoutDesign,
    item.floorPlanUrl,
    item.csbhSummaryUrl,
    item.csbhDetailUrl,
    item.layoutUrl,
  ];
  for (const link of extraDocLinks) {
    if (link && typeof link === 'string' && /^https?:\/\//i.test(link.trim())) {
      const cleanLink = link.trim();
      if (link === item.layoutUrl && isDirectImageUrl(cleanLink)) {
        layoutImageUrls.add(cleanLink);
      } else {
        documentUrls.add(cleanLink);
      }
    }
  }

  const priceListUrl =
    String(
      item.xSaleLinkFull ||
        item.xSaleLinkSummary ||
        item.csbhSummaryUrl ||
        (projectId ? `https://vhub.com.vn/quy-can?projectId=${projectId}` : '')
    ).trim();

  const normalizedRawData = {
    ...item,
    project_type: isHighRise ? 'high_rise' : 'low_rise',
  };

  return {
    source: 'vhub',
    project_id: projectId,
    project_name: projectName,
    subdivision: String(item.subdivisionName || item.subdivision || '').trim(),
    building: String(item.buildingName || item.buildingCode || '').trim(),
    floor: String(item.floorNumber || item.numberOfFloor || '').trim(),
    unit_code: unitCode,
    unit_type: String(item.apartmentTypeName || item.propertyType || '').trim(),
    area_land: areaLand,
    area_build: areaBuild,
    price,
    price_text: formatPriceText(price),
    price_tts: priceTts,
    status: String(
      (item.stateLine === 'sold' ? '\u0110\u00e3 b\u00e1n' : item.stateLineName) || (item.stateLine === 'locked' ? 'Đang lock' : 'Còn hàng')
    ).trim(),
    direction: String(item.baseDirectionName || item.direction || '').trim(),
    delivery_standard: String(item.deliveryStandards || '').trim(),
    bank_support: String(item.supportingBanks || '').trim(),
    price_list_url: priceListUrl,
    image_urls: Array.from(imageUrls),
    layout_image_urls: Array.from(layoutImageUrls),
    project_image_urls: matchedProj?.project_image_urls || [],
    document_urls: Array.from(documentUrls),
    raw_data: normalizedRawData,
  };
}

/**
 * Lưu hàng loạt bản ghi căn hộ VHub vào MongoDB Unit
 */
async function saveVhubUnitsToMongo(unitDocs, isInitialSync = false) {
  if (!Array.isArray(unitDocs) || unitDocs.length === 0) {
    return { newCount: 0, updatedCount: 0 };
  }

  // Chống trùng lặp theo key (project_name + unit_code) trong cùng batch
  const dedupedMap = new Map();
  for (const doc of unitDocs) {
    const key = `${doc.project_name}:::${doc.unit_code}`;
    dedupedMap.set(key, doc);
  }

  const uniqueDocs = Array.from(dedupedMap.values());
  const now = new Date();
  let totalNew = 0;
  let totalUpdated = 0;

  for (let i = 0; i < uniqueDocs.length; i += BULK_WRITE_BATCH_SIZE) {
    const chunk = uniqueDocs.slice(i, i + BULK_WRITE_BATCH_SIZE);
    const ops = chunk.map((doc) => ({
      updateOne: {
        filter: {
          source: 'vhub',
          project_name: doc.project_name,
          unit_code: doc.unit_code,
        },
        update: {
          $set: {
            project_id: doc.project_id,
            subdivision: doc.subdivision,
            building: doc.building,
            floor: doc.floor,
            unit_type: doc.unit_type,
            area_land: doc.area_land,
            area_build: doc.area_build,
            price: doc.price,
            price_text: doc.price_text,
            price_tts: doc.price_tts,
            status: doc.status,
            direction: doc.direction,
            delivery_standard: doc.delivery_standard,
            bank_support: doc.bank_support,
            price_list_url: doc.price_list_url,
            image_urls: doc.image_urls,
            layout_image_urls: doc.layout_image_urls,
            project_image_urls: doc.project_image_urls,
            document_urls: doc.document_urls,
            raw_data: doc.raw_data,
            updated_at: now,
          },
          $setOnInsert: {
            created_at: now,
            is_notified: Boolean(isInitialSync),
            image_sync_status: doc.image_urls.length === 0 ? 'NO_IMAGE' : 'PENDING',
          },
        },
        upsert: true,
      },
    }));

    const result = await trackedBulkWrite(Unit, ops, { ordered: false });
    totalNew += result.upsertedCount || 0;
    totalUpdated += result.modifiedCount || 0;
  }

  // Mở lại trạng thái PENDING cho các căn trước đó từng là NO_IMAGE nhưng nay đã có URL ảnh
  await Unit.updateMany(
    { source: 'vhub', image_sync_status: 'NO_IMAGE', 'image_urls.0': { $exists: true } },
    { $set: { image_sync_status: 'PENDING', image_sync_retries: 0 } }
  );

  return { newCount: totalNew, updatedCount: totalUpdated };
}

/**
 * Hàm điều phối cào toàn bộ dữ liệu dự án & rổ hàng từ VHub 360 (vhub.com.vn)
 */
async function crawlAllVhubProjects(isInitialSync = false) {
  const scanStartedAt = new Date();
  console.log('\n====================================================================');
  console.log('🌐 [VHUB CRAWLER] BẮT ĐẦU QUÉT DỮ LIỆU TỪ VHUB.COM.VN');
  console.log('====================================================================');

  const sessionState = { current: await getVhubSession() };
  const projectScope = parseVhubProjectScope();

  // 1. Lấy và lưu danh sách dự án
  const { projectMap, totalTours } = await fetchAndSaveVhubProjects(sessionState, projectScope);
  console.log(`[VHub] 📋 Đã đồng bộ ${totalTours} dự án từ /tours/published.`);

  // 2. Lấy toàn bộ quỹ căn từ /products/published (có phân trang)
  const rawUnits = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const resData = await fetchVhubGet(
      '/products/published',
      { page, limit: DEFAULT_PAGE_LIMIT },
      sessionState
    );

    if (!Array.isArray(resData?.data) || !resData.meta) throw new Error('Invalid VHub inventory response');
    const items = resData.data;
    const meta = resData?.meta || {};
    totalPages = Number(meta.totalPages) || 1;

    for (const item of items) {
      if (projectScope && !projectScope.has(String(item.projectId || ''))) {
        continue;
      }
      rawUnits.push(item);
    }

    if (page === 1 || page % 10 === 0 || page === totalPages) {
      console.log(`[VHub] 📥 Đã tải trang ${page}/${totalPages} (${rawUnits.length} căn)...`);
    }

    if (!meta.hasNextPage) break;
    page++;
    await sleep(150);
  }

  // 3. Chuẩn hóa & lưu vào MongoDB
  const normalizedUnits = rawUnits
    .map((item) => normalizeVhubUnit(item, projectMap))
    .filter(Boolean);

  if (page < totalPages) throw new Error('Incomplete VHub pagination');
  const { newCount, updatedCount } = await saveVhubUnitsToMongo(normalizedUnits, isInitialSync);
  await markMissing(Unit, {source:'vhub', ...(projectScope ? {project_id:{$in:[...projectScope]}} : {})}, scanStartedAt);

  console.log(
    `[VHub] ✅ Hoàn tất! Đã quét ${normalizedUnits.length} căn hợp lệ từ ${totalTours} dự án | Thêm mới: ${newCount} | Cập nhật: ${updatedCount}`
  );

  return {
    totalScanned: normalizedUnits.length,
    newUnitsCount: newCount,
    updatedUnitsCount: updatedCount,
    successProjects: totalTours,
    errorProjects: 0,
    skippedProjects: 0,
  };
}

module.exports = {
  crawlAllVhubProjects,
  normalizeVhubUnit,
  isDirectImageUrl,
  parseVhubProjectScope,
};
