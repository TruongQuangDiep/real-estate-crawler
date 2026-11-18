const axios = require('axios');
const Unit = require('../models/Unit');
const Project = require('../models/Project');

const SALEPRO_HIGH_RISE_API_URL =
  'https://salepro.com/api/rest_api/pu/property/master/data/search_tindang_data/';
const DEFAULT_PAGE_LIMIT = 24;
const BULK_WRITE_BATCH_SIZE = 500;
const PAGE_DELAY_MS = 450;
const PROJECT_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 25000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Format VND price into concise readable Vietnamese text matching UI display.
 */
function formatPriceText(price) {
  const numeric = toNumberOrNull(price);
  if (!numeric || numeric <= 0) return '';
  if (numeric >= 1e9) return `${(numeric / 1e9).toFixed(2)} tỷ`;
  if (numeric >= 1e6) return `${(numeric / 1e6).toFixed(0)} triệu`;
  return `${numeric.toLocaleString('vi-VN')} đ`;
}

/**
 * Parse SALEPRO_PROJECT_IDS / SALEPRO_PROJECT_ID env into null (ALL) or Set of string IDs.
 */
function parseSaleProProjectScope() {
  const raw = (process.env.SALEPRO_PROJECT_IDS || process.env.SALEPRO_PROJECT_ID || 'ALL').trim();
  if (!raw || raw.toUpperCase() === 'ALL') return null;

  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * Build request headers matching SalePro web frontend XHR calls.
 */
function buildSaleProHeaders(projectSlug) {
  const rawToken = (process.env.SALEPRO_AUTH_TOKEN || '').trim();
  const authToken = rawToken && !/^bearer\s+/i.test(rawToken) ? `Bearer ${rawToken}` : rawToken;
  const cookie = (process.env.SALEPRO_COOKIE || '').trim();
  const slugPath = projectSlug ? `/${String(projectSlug).replace(/^\/+/, '')}` : '';

  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'vi',
    priority: 'u=1, i',
    referer: `https://salepro.com/project-detail${slugPath}`,
    'sec-ch-ua': '"Not-A.Brand";v="99", "Microsoft Edge";v="157", "Chromium";v="157"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0',
  };

  if (authToken) headers.authorization = authToken;
  if (cookie) headers.cookie = cookie;
  return headers;
}

/**
 * Check whether an axios error or HTML payload indicates auth expiry or Cloudflare block.
 */
function isCloudflareOrAuthError(status, payload) {
  if (status === 401 || status === 403) return true;
  if (typeof payload === 'string') {
    const lower = payload.toLowerCase();
    return lower.includes('just a moment') || lower.includes('cf-chl') || lower.includes('<html');
  }
  return false;
}

/**
 * Map one raw SalePro high-rise item into the shared MongoDB Unit shape.
 * Returns null if the item should be excluded (hidden, non-public, sold, or missing code).
 */
function normalizeHighRiseUnit(item, project = {}) {
  if (!item || typeof item !== 'object') return null;
  if (item.is_not_show === true) return null;
  if (item.state && item.state !== 'public') return null;
  if (String(item.state_line || '').toLowerCase() === 'sold') return null;

  const unitCode = String(item.product_code || item.product_name || '').trim();
  if (!unitCode) return null;

  const projectId = String(item.project_id ?? project.project_id ?? '').trim();
  const projectName = String(project.project_name || item.project_name || '')
    .trim()
    .toUpperCase();
  if (!projectName) return null;

  const areaCarpet = toNumberOrNull(item.carpet_area);
  const areaBuiltUp = toNumberOrNull(item.built_up_area);
  const price = toNumberOrNull(item.apartment_price);
  const earlyPrice = toNumberOrNull(item.early_payment_price);
  const slug = project.project_slug ? String(project.project_slug).trim() : '';

  return {
    source: 'salepro',
    project_id: projectId,
    project_name: projectName,
    subdivision: String(item.subdivision_name || '').trim() || '',
    building: String(item.building_name || '').trim() || '',
    floor: item.number_of_floor != null ? String(item.number_of_floor).trim() : '',
    unit_code: unitCode,
    unit_type: String(item.apartment_type_name || '').trim() || '',
    area_land: areaCarpet,
    area_build: areaBuiltUp,
    price,
    price_text: formatPriceText(price),
    price_tts: earlyPrice && earlyPrice > 0 ? earlyPrice : null,
    status:
      String(item.state_line_name || '').trim() ||
      (item.state_line === 'available' ? 'Còn hàng' : String(item.state_line || 'Còn hàng')),
    direction: String(item.base_direction_name || '').trim() || '',
    delivery_standard: '',
    bank_support: '',
    price_list_url: slug ? `https://salepro.com/project-detail/${slug}#quy-can-cao-tang` : '',
    image_urls: [],
    raw_data: item,
  };
}

/**
 * Deduplicate and upsert normalized units into MongoDB via batched bulkWrite.
 */
async function saveSaleProUnitsToMongo(unitDocs, isInitialSync = false) {
  if (!Array.isArray(unitDocs) || unitDocs.length === 0) {
    return { newCount: 0, updatedCount: 0, savedCount: 0 };
  }

  const dedupedMap = new Map();
  for (const doc of unitDocs) {
    const key = `${doc.project_name}:::${doc.unit_code}`;
    dedupedMap.set(key, doc);
  }

  const uniqueDocs = Array.from(dedupedMap.values());
  const now = new Date();
  let newCount = 0;
  let updatedCount = 0;

  for (let i = 0; i < uniqueDocs.length; i += BULK_WRITE_BATCH_SIZE) {
    const batch = uniqueDocs.slice(i, i + BULK_WRITE_BATCH_SIZE);
    const ops = batch.map((doc) => ({
      updateOne: {
        filter: {
          source: doc.source,
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
            raw_data: doc.raw_data,
            updated_at: now,
          },
          $setOnInsert: {
            is_notified: Boolean(isInitialSync),
            created_at: now,
          },
        },
        upsert: true,
      },
    }));

    const result = await Unit.bulkWrite(ops, { ordered: false });
    newCount += result.upsertedCount || 0;
    updatedCount += (result.matchedCount || 0);
  }

  return { newCount, updatedCount, savedCount: uniqueDocs.length };
}

/**
 * Fetch all paginated high-rise units for one SalePro project.
 */
async function fetchProjectHighRiseUnits(project, options = {}) {
  const httpClient = options.httpClient || axios;
  const pageLimit = Number(options.limit || process.env.SALEPRO_HIGH_RISE_LIMIT || DEFAULT_PAGE_LIMIT);
  const pageDelayMs = options.pageDelayMs ?? PAGE_DELAY_MS;
  const headers = buildSaleProHeaders(project.project_slug);

  const collected = [];
  const seenKeys = new Set();
  let apiTotal = null;
  let page = 1;
  let maxPages = 500;

  while (page <= maxPages) {
    let response;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        response = await httpClient.get(SALEPRO_HIGH_RISE_API_URL, {
          params: {
            state: 'notSold',
            project_id: project.project_id,
            page,
            limit: pageLimit,
          },
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        });
        break;
      } catch (err) {
        const status = err.response?.status;
        const payload = err.response?.data;
        if (isCloudflareOrAuthError(status, payload)) {
          const authErr = new Error(
            status === 401
              ? 'Token SALEPRO_AUTH_TOKEN đã hết hạn (401).'
              : 'Bị Cloudflare chặn (403) hoặc SALEPRO_COOKIE (cf_clearance) đã hết hạn.'
          );
          authErr.isAuthOrCloudflare = true;
          authErr.statusCode = status;
          throw authErr;
        }

        const isTransient =
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNABORTED' ||
          err.code === 'ENOTFOUND' ||
          err.message?.includes('socket hang up') ||
          err.message?.includes('ECONNRESET') ||
          err.message?.includes('timeout');

        if (isTransient && attempts < maxAttempts) {
          console.warn(
            `[SalePro Cao tầng] ⚠️ Gián đoạn mạng (${err.code || err.message}) tại dự án [${project.project_id}] trang ${page}. Đang tự động kết nối lại lần ${attempts}/${maxAttempts}...`
          );
          await delay(1200 * attempts);
          continue;
        }

        throw err;
      }
    }

    const body = response.data;
    if (typeof body === 'string' && isCloudflareOrAuthError(response.status, body)) {
      const cfErr = new Error('Phản hồi HTML Cloudflare/Login thay vì JSON. Kiểm tra SALEPRO_COOKIE / SALEPRO_AUTH_TOKEN.');
      cfErr.isAuthOrCloudflare = true;
      throw cfErr;
    }

    if (!body || body.error === true || (body.code !== undefined && body.code !== 1)) {
      throw new Error(body?.message || `API trả về lỗi (code=${body?.code}, error=${body?.error})`);
    }

    const rows = Array.isArray(body.data) ? body.data : [];
    if (apiTotal === null) {
      const reportedTotal = toNumberOrNull(body.total ?? rows[0]?.total_records);
      if (reportedTotal !== null && reportedTotal >= 0) {
        apiTotal = reportedTotal;
        maxPages = Math.min(500, Math.max(1, Math.ceil(apiTotal / pageLimit)));
      }
    }

    if (rows.length === 0) break;

    let addedThisPage = 0;
    for (const row of rows) {
      const code = String(row.product_code || row.product_name || `idx_${collected.length}`);
      const sub = String(row.subdivision_name || '');
      const dedupeKey = `${code}::${sub}`;
      if (!seenKeys.has(dedupeKey)) {
        seenKeys.add(dedupeKey);
        collected.push(row);
        addedThisPage += 1;
      }
    }

    // Stop early if backend repeats the exact same page or returns fewer rows than pageLimit
    if (page > 1 && addedThisPage === 0) break;
    if (apiTotal !== null && collected.length >= apiTotal) break;
    if (rows.length < pageLimit) break;

    page += 1;
    if (pageDelayMs > 0) await delay(pageDelayMs);
  }

  return {
    rawItems: collected,
    apiTotal: apiTotal ?? collected.length,
    pagesFetched: page,
  };
}

/**
 * Crawl all public in-stock high-rise projects for SalePro stored in MongoDB Project collection.
 */
async function crawlAllSaleProHighRiseProjects(isInitialSync = false, options = {}) {
  if (!process.env.SALEPRO_AUTH_TOKEN) {
    throw new Error('Thiếu cấu hình xác thực SALEPRO_AUTH_TOKEN cho phân khúc SalePro Cao tầng trong .env.');
  }

  const scopeSet = parseSaleProProjectScope();
  const candidates = options.projects
    ? options.projects
    : await Project.find({
        source: 'salepro',
        project_type: 'high_rise',
        state: 'public',
        out_of_stock: 0,
        apartment_count: { $gt: 0 },
      })
        .sort({ apartment_count: -1, project_id: 1 })
        .lean();

  const targetProjects = scopeSet
    ? candidates.filter((p) => scopeSet.has(String(p.project_id).trim()))
    : candidates;

  console.log(`\n==================================================`);
  console.log(`[SalePro Cao tầng] Bắt đầu quét ${targetProjects.length} dự án cao tầng đang mở bán`);
  console.log(`==================================================`);

  if (targetProjects.length === 0) {
    console.log('[SalePro Cao tầng] Không có dự án cao tầng nào phù hợp để quét.');
    return {
      totalScanned: 0,
      newUnitsCount: 0,
      updatedUnitsCount: 0,
      successProjects: 0,
      errorProjects: 0,
    };
  }

  let totalScanned = 0;
  let newCount = 0;
  let updatedCount = 0;
  let successProjects = 0;
  let errorProjects = 0;
  let consecutiveAuthErrors = 0;

  for (let idx = 0; idx < targetProjects.length; idx += 1) {
    const project = targetProjects[idx];
    const label = `[${project.project_id}] ${project.project_name}`;

    try {
      const { rawItems, apiTotal, pagesFetched } = await fetchProjectHighRiseUnits(project, options);
      const unitDocs = rawItems.map((item) => normalizeHighRiseUnit(item, project)).filter(Boolean);
      const saveRes = await saveSaleProUnitsToMongo(unitDocs, isInitialSync);

      consecutiveAuthErrors = 0;
      successProjects += 1;
      totalScanned += saveRes.savedCount;
      newCount += saveRes.newCount;
      updatedCount += saveRes.updatedCount;

      if (Number.isFinite(apiTotal) && apiTotal >= 0) {
        await Project.updateOne(
          { source: 'salepro', project_id: project.project_id },
          {
            $set: {
              apartment_count: apiTotal,
              out_of_stock: apiTotal === 0 ? 1 : 0,
              updated_at: new Date(),
            },
          }
        );
      }

      console.log(
        `[SalePro Cao tầng] (${idx + 1}/${targetProjects.length}) ✅ ${label}: ${saveRes.savedCount}/${apiTotal} căn (${pagesFetched} trang | +${saveRes.newCount} mới, ${saveRes.updatedCount} cập nhật)`
      );
    } catch (err) {
      errorProjects += 1;
      console.error(`[SalePro Cao tầng] (${idx + 1}/${targetProjects.length}) ❌ ${label}: ${err.message}`);

      if (err.isAuthOrCloudflare) {
        consecutiveAuthErrors += 1;
        if (consecutiveAuthErrors >= 2) {
          console.error(
            '[SalePro Cao tầng] 🛑 Dừng sớm nhóm cao tầng vì lỗi xác thực/Cloudflare liên tiếp. Hãy cập nhật SALEPRO_COOKIE hoặc SALEPRO_AUTH_TOKEN trong .env rồi chạy lại.'
          );
          break;
        }
      }
    }

    if (idx < targetProjects.length - 1 && PROJECT_DELAY_MS > 0) {
      await delay(PROJECT_DELAY_MS);
    }
  }

  console.log(`\n[SalePro Cao tầng] Tổng kết:`);
  console.log(`- Số dự án cao tầng đã quét thành công: ${successProjects}/${targetProjects.length} (lỗi: ${errorProjects})`);
  console.log(`- Tổng số căn cao tầng quét được: ${totalScanned} (+${newCount} mới, ${updatedCount} cập nhật)`);

  return {
    totalScanned,
    newUnitsCount: newCount,
    updatedUnitsCount: updatedCount,
    successProjects,
    errorProjects,
    skippedProjects: Math.max(0, targetProjects.length - successProjects - errorProjects),
  };
}

module.exports = {
  SALEPRO_HIGH_RISE_API_URL,
  formatPriceText,
  normalizeHighRiseUnit,
  saveSaleProUnitsToMongo,
  fetchProjectHighRiseUnits,
  crawlAllSaleProHighRiseProjects,
};
