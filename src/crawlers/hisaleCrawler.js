const { isDocumentUrl } = require('../services/fileFormats');
const { trackedBulkWrite, markMissing } = require('../services/inventoryHistory');
const axios = require('axios');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const { getHisaleSession } = require('../services/hisaleAuth');

const BASE_URL = 'https://www.hisale.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

// Hàm delay giữa các tác vụ để tránh quá tải server nguồn
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Map tên dự án mặc định nếu chạy lẻ theo ID mà chưa có thông tin trong DB
 */
const PROJECT_NAMES = {
  19: 'Vinhomes Global Gate Hạ Long',
  39: 'VINHOMES GRAND PARK'
};

/**
 * Giải mã HTML entities phổ biến do Laravel Blade render (giữ nguyên thứ tự để decode &amp; sau cùng)
 */
function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Làm sạch chuỗi text hiển thị trong thẻ HTML (tên dự án, địa chỉ)
 */
function cleanHtmlText(str = '') {
  return decodeHtmlEntities(String(str).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Xóa trường base64 QR nặng trước khi lưu raw_data dự án vào MongoDB
 */
function stripHeavyProjectFields(data) {
  if (!data || typeof data !== 'object') return data;
  const copy = { ...data };
  delete copy.bank_qr_image;
  if (Array.isArray(copy.children)) {
    copy.children = copy.children.map(stripHeavyProjectFields);
  }
  if (copy.parent && typeof copy.parent === 'object') {
    copy.parent = stripHeavyProjectFields(copy.parent);
  }
  return copy;
}

/**
 * Tạo headers chuẩn cho request HiSale (HTML hoặc AJAX JSON)
 */
function buildHisaleHeaders(session, { isJson = true, referer = `${BASE_URL}/du-an?tab=0` } = {}) {
  const headers = {
    'accept-language': 'en-US,en;q=0.9,vi;q=0.8,vi-VN;q=0.7',
    cookie: session.cookie || '',
    referer,
    'user-agent': DEFAULT_USER_AGENT
  };

  if (isJson) {
    headers.accept = 'application/json, text/plain, */*';
    headers['x-requested-with'] = 'XMLHttpRequest';
    headers['x-xsrf-token'] = session.xsrfToken || '';
  } else {
    headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  }

  return headers;
}

/**
 * Kiểm tra phản hồi có dấu hiệu hết phiên đăng nhập HiSale không
 */
function isAuthExpiredResponse(res, isJson) {
  const finalUrl = res && res.request && res.request.res && res.request.res.responseUrl
    ? String(res.request.res.responseUrl)
    : '';
  if (finalUrl.includes('/login')) return true;

  if (isJson && typeof res.data === 'string') {
    return true;
  }

  if (!isJson && typeof res.data === 'string') {
    const html = res.data;
    if (
      html.includes('action="https://www.hisale.com/login"') &&
      !html.includes('project-card') &&
      !html.includes(':project-data')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Gọi GET HiSale kèm tự động đăng nhập lại tối đa 1 lần nếu gặp 401/419/redirect login
 */
async function fetchWithHisaleSession(url, { params = undefined, isJson = true, referer, timeout = 30000 } = {}, sessionState) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(url, {
        params,
        headers: buildHisaleHeaders(sessionState.current, { isJson, referer }),
        timeout
      });

      if (attempt === 0 && isAuthExpiredResponse(res, isJson)) {
        console.warn(`[HiSale] Session hết hạn hoặc bị chuyển về /login (${url}). Đang tự động đăng nhập lại...`);
        sessionState.current = await getHisaleSession(true);
        continue;
      }

      return res;
    } catch (err) {
      const status = err.response && err.response.status;
      if (attempt === 0 && (status === 401 || status === 419 || status === 403)) {
        console.warn(`[HiSale] HTTP ${status} tại ${url}! Đang tự động đăng nhập lại...`);
        sessionState.current = await getHisaleSession(true);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Không thể tải dữ liệu HiSale sau khi tự động đăng nhập lại: ${url}`);
}

/**
 * Phân tích trang danh sách dự án /du-an?tab=0&page=N để lấy slug, tên, loại (cao tầng/thấp tầng) và maxPage
 */
function parseCatalogPageHtml(html = '') {
  const pagIdx = html.indexOf('<div class="pagination">');
  let maxPage = 1;

  if (pagIdx !== -1) {
    const pagSnippet = html.slice(pagIdx, pagIdx + 6000);
    const pageRegex = /(?:[?&]|&amp;)page=(\d+)/g;
    let m;
    while ((m = pageRegex.exec(pagSnippet)) !== null) {
      const pageNum = Number(m[1]);
      if (Number.isInteger(pageNum) && pageNum > maxPage) {
        maxPage = pageNum;
      }
    }
  }

  const startIdx = html.indexOf('Danh sách dự án');
  const gridHtml = html.slice(startIdx !== -1 ? startIdx : 0, pagIdx !== -1 ? pagIdx : html.length);
  const cardBlocks = gridHtml.split('<div class="project-card">').slice(1);

  const projects = [];
  for (const block of cardBlocks) {
    const titleMatch = block.match(/<h3>\s*<a[^>]*href="(?:https?:\/\/www\.hisale\.com)?\/du-an\/([^"?#/]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i);
    if (!titleMatch) continue;

    const slug = titleMatch[1].trim();
    const name = cleanHtmlText(titleMatch[2]);

    const tagsMatch = block.match(/<div class="project-tags">([\s\S]*?)<\/div>/i);
    const tagText = tagsMatch ? cleanHtmlText(tagsMatch[1]) : '';
    let projectType = '';
    if (/cao\s*tầng/i.test(tagText)) {
      projectType = 'high_rise';
    } else if (/thấp\s*tầng/i.test(tagText)) {
      projectType = 'low_rise';
    }

    const locMatch = block.match(/<div class="project-location">([\s\S]*?)<\/div>/i);
    const address = locMatch ? cleanHtmlText(locMatch[1]) : '';

    projects.push({
      project_slug: slug,
      project_name: name,
      project_type: projectType,
      project_address: address,
      has_fund_tab: block.includes('pills-menu-project-danh-sach')
    });
  }

  return { projects, maxPage };
}

/**
 * Giải mã thuộc tính Vue :project-data="..." trên trang /du-an/<slug> để lấy chính xác project_id
 */
function parseHisaleProjectDataFromHtml(html = '', fallbackCard = {}) {
  const attrMatch =
    html.match(/<list-fund[^>]*:project-data=(["'])([\s\S]*?)\1/i) ||
    html.match(/:project-data=(["'])([\s\S]*?)\1/i);

  let raw = null;
  if (attrMatch && attrMatch[2]) {
    const decodedJson = decodeHtmlEntities(attrMatch[2]);
    try {
      raw = JSON.parse(decodedJson);
    } catch (err) {
      // Fallback trích các trường cốt lõi bằng regex nếu chuỗi mô tả HTML bên trong có ký tự lạ
      const idMatch = decodedJson.match(/"id"\s*:\s*(\d+)/);
      const nameMatch = decodedJson.match(/"name"\s*:\s*"((?:\\.|[^"])*)"/);
      const slugMatch = decodedJson.match(/"slug"\s*:\s*"((?:\\.|[^"])*)"/);
      const typeMatch = decodedJson.match(/"type"\s*:\s*(\d+)/);
      const parentMatch = decodedJson.match(/"parent_id"\s*:\s*(\d+|null)/);
      const activeMatch = decodedJson.match(/"is_active"\s*:\s*(\d+)/);
      const shortCodeMatch = decodedJson.match(/"short_code"\s*:\s*"((?:\\.|[^"])*)"/);
      const investorMatch = decodedJson.match(/"investor"\s*:\s*"((?:\\.|[^"])*)"/);
      const addressMatch = decodedJson.match(/"address"\s*:\s*"((?:\\.|[^"])*)"/);

      if (idMatch) {
        const parseStr = (m) => {
          if (!m) return '';
          try {
            return JSON.parse(`"${m[1]}"`);
          } catch {
            return m[1];
          }
        };
        raw = {
          id: Number(idMatch[1]),
          name: parseStr(nameMatch),
          slug: parseStr(slugMatch),
          type: typeMatch ? Number(typeMatch[1]) : null,
          parent_id: parentMatch && parentMatch[1] !== 'null' ? Number(parentMatch[1]) : null,
          is_active: activeMatch ? Number(activeMatch[1]) : 1,
          short_code: parseStr(shortCodeMatch),
          investor: parseStr(investorMatch),
          address: parseStr(addressMatch)
        };
      }
    }
  }

  if (!raw || !raw.id) {
    // Fallback cuối: tìm project_id= trong script inline nếu dự án chỉ dùng map
    const pidMatch = html.match(/(?:project_id|search-project-info\?project_id)\s*[:=]\s*["']?(\d+)/);
    if (!pidMatch) return null;
    raw = {
      id: Number(pidMatch[1]),
      name: fallbackCard.project_name || `Dự án ID ${pidMatch[1]}`,
      slug: fallbackCard.project_slug || '',
      is_active: 1
    };
  }

  const rawTypeNum = Number(raw.type);
  const typeName = raw.typeName || '';
  let projectType = fallbackCard.project_type || '';
  if (rawTypeNum === 1 || /thấp\s*tầng/i.test(typeName)) {
    projectType = 'low_rise';
  } else if (rawTypeNum === 2 || /cao\s*tầng/i.test(typeName)) {
    projectType = 'high_rise';
  }

  let initialApartmentCount = Number(raw.available_apartments_count) || 0;
  if (!initialApartmentCount && Array.isArray(raw.children)) {
    initialApartmentCount = raw.children.reduce(
      (sum, child) => sum + (Number(child && child.available_apartments_count) || 0),
      0
    );
  }

  const isActive =
    raw.is_active === undefined || raw.is_active === null ? true : Boolean(Number(raw.is_active));

  return {
    source: 'hisale',
    project_id: Number(raw.id),
    project_code: raw.short_code || '',
    project_name: raw.name || fallbackCard.project_name || `Dự án ID ${raw.id}`,
    project_slug: raw.slug || fallbackCard.project_slug || '',
    project_type: projectType,
    investor: raw.investor || '',
    project_address: raw.address || fallbackCard.project_address || '',
    state: isActive ? 'public' : 'inactive',
    out_of_stock: 0,
    apartment_count: initialApartmentCount,
    parent_id: raw.parent_id ? Number(raw.parent_id) : null,
    raw_data: stripHeavyProjectFields(raw)
  };
}

/**
 * Quét toàn bộ dự án từ /du-an?tab=0&page=1..N, giải mã project_id từ trang chi tiết và đồng bộ vào collection 'projects'
 */
async function fetchAllHisaleProjects(sessionStateInput = null) {
  const sessionState = sessionStateInput || { current: await getHisaleSession() };
  console.log(`[HiSale] 📋 Đang tải danh mục toàn bộ dự án từ ${BASE_URL}/du-an?tab=0...`);

  const cardMap = new Map();
  let currentPage = 1;
  let maxPage = 1;

  while (currentPage <= maxPage) {
    const pageUrl = `${BASE_URL}/du-an?tab=0&page=${currentPage}`;
    const res = await fetchWithHisaleSession(
      pageUrl,
      { isJson: false, referer: `${BASE_URL}/du-an?tab=0`, timeout: 25000 },
      sessionState
    );

    const parsed = parseCatalogPageHtml(res.data || '');
    if (currentPage === 1) {
      maxPage = parsed.maxPage || 1;
    }

    parsed.projects.forEach((card) => {
      if (!cardMap.has(card.project_slug)) {
        cardMap.set(card.project_slug, card);
      }
    });

    console.log(`[HiSale] Trang danh sách dự án ${currentPage}/${maxPage}: +${parsed.projects.length} thẻ (Đã gom: ${cardMap.size})`);
    currentPage++;
    if (currentPage <= maxPage) {
      await sleep(400);
    }
  }

  const cards = Array.from(cardMap.values());
  console.log(`[HiSale] 🔍 Đang phân giải project_id cho ${cards.length} dự án từ HTML chi tiết...`);

  const resolvedProjects = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const detailUrl = `${BASE_URL}/du-an/${card.project_slug}?tab=pills-menu-project-danh-sach`;
    try {
      const res = await fetchWithHisaleSession(
        detailUrl,
        { isJson: false, referer: `${BASE_URL}/du-an?tab=0`, timeout: 25000 },
        sessionState
      );
      const projectMeta = parseHisaleProjectDataFromHtml(res.data || '', card);
      if (projectMeta) {
        resolvedProjects.push(projectMeta);
      } else {
        console.warn(`[HiSale] ⚠️ Bỏ qua [${card.project_slug}]: chưa có bảng quỹ căn (<list-fund>) trên trang.`);
      }
    } catch (err) {
      console.warn(`[HiSale] ⚠️ Lỗi khi lấy thông tin dự án [${card.project_slug}]: ${err.message}`);
    }
    await sleep(300);
  }

  // Khử trùng lặp theo project_id
  const uniqueById = new Map();
  resolvedProjects.forEach((proj) => {
    if (!uniqueById.has(proj.project_id)) {
      uniqueById.set(proj.project_id, proj);
    }
  });
  const finalProjects = Array.from(uniqueById.values());

  if (finalProjects.length > 0) {
    const bulkOps = finalProjects.map((proj) => ({
      updateOne: {
        filter: { source: 'hisale', project_id: proj.project_id },
        update: {
          $set: {
            project_code: proj.project_code,
            project_name: proj.project_name,
            project_slug: proj.project_slug,
            project_type: proj.project_type,
            investor: proj.investor,
            project_address: proj.project_address,
            state: proj.state,
            raw_data: proj.raw_data,
            updated_at: new Date()
          },
          $setOnInsert: {
            out_of_stock: proj.out_of_stock,
            apartment_count: proj.apartment_count
          }
        },
        upsert: true
      }
    }));

    await Project.bulkWrite(bulkOps, { ordered: false });
    console.log(`[HiSale] 💾 Đã đồng bộ ${finalProjects.length} dự án vào collection 'projects'.`);
  }

  return finalProjects;
}

/**
 * Lưu hàng loạt danh sách căn của HiSale vào MongoDB (Upsert vào chung collection 'units')
 */
async function saveUnitsToMongo(units, projectId, isInitialSync, projectMeta = null) {
  if (!units || units.length === 0) return { newCount: 0, modCount: 0 };

  const fallbackProjectName =
    (projectMeta && projectMeta.project_name) || PROJECT_NAMES[projectId] || `Dự án ID ${projectId}`;

  const bulkOps = units.map((item) => {
    // Nếu unit thuộc phân khu con của dự án đang cào (VD: THE BEVERLY parent_id=39 -> gộp dưới VINHOMES GRAND PARK)
    const isChildOfCurrent =
      Boolean(projectMeta && projectMeta.project_name && item.project && item.project.parent_id) &&
      Number(item.project.parent_id) === Number(projectId);

    const projectName = isChildOfCurrent
      ? projectMeta.project_name
      : (item.project && item.project.name) || item.project_name || fallbackProjectName;

    const effectiveProjectId = isChildOfCurrent ? projectId : item.project_id || projectId;
    const unitCode = item.code || item.name || `UNKNOWN_${item.id}`;

    const images = [];
    const documents = [];
    let rawImageList = item.image_price_list_json;
    if (!Array.isArray(rawImageList) && typeof item.image_price_list === 'string' && item.image_price_list.trim()) {
      try {
        rawImageList = JSON.parse(item.image_price_list);
      } catch {
        rawImageList = [];
      }
    }
    const DOCUMENT_EXTENSIONS = ['.xlsx', '.xls', '.pdf', '.doc', '.docx', '.csv', '.zip', '.rar'];
    if (Array.isArray(rawImageList)) {
      rawImageList.forEach((img) => {
        if (img && img.url) {
          const cleanUrl = String(img.url).split('?')[0].split('#')[0].toLowerCase();
          const isDoc = isDocumentUrl(img.url);
          if (isDoc) {
            documents.push(img.url);
          } else {
            images.push(img.url);
          }
        }
      });
    }

    return {
      updateOne: {
        filter: {
          source: 'hisale',
          project_name: projectName,
          unit_code: unitCode
        },
        update: {
          $set: {
            project_id: effectiveProjectId,
            project_name: projectName,
            subdivision: item.area || (item.project && item.project.name) || '',
            building: item.building || item.block || '',
            floor: item.floor !== null && item.floor !== undefined ? String(item.floor) : '',
            unit_type: item.type || '',
            area_land: Number(item.area_land) || 0,
            area_build: Number(item.area_build) || 0,
            price: Number(item.price) || 0,
            price_text: item.priceName || (item.price ? `${(Number(item.price) / 1e9).toFixed(2)} tỷ` : ''),
            price_tts: Number(item.price_tts) || 0,
            status: item.statusName || 'Còn hàng',
            direction: item.directionName || '',
            delivery_standard: item.delivery_standard || '',
            bank_support: item.bank_cart || '',
            price_list_url: item.price_list || '',
            image_urls: images,
            ...(documents.length > 0 ? { document_urls: documents } : {}),
            raw_data: item,
            updated_at: new Date()
          },
          $setOnInsert: {
            created_at: new Date(),
            // Căn mới tinh: nếu là cào lần đầu thì true (không spam mail), còn chạy hằng ngày thì false
            is_notified: isInitialSync ? true : false
          }
        },
        upsert: true
      }
    };
  });

  // Chia theo chunk 500 bản ghi để bulkWrite nhẹ nhàng
  const CHUNK_SIZE = 500;
  let totalNew = 0;
  let totalMod = 0;

  for (let i = 0; i < bulkOps.length; i += CHUNK_SIZE) {
    const chunk = bulkOps.slice(i, i + CHUNK_SIZE);
    const bulkResult = await trackedBulkWrite(Unit, chunk, { ordered: false });
    totalNew += bulkResult.upsertedCount || 0;
    totalMod += bulkResult.modifiedCount || 0;
  }

  return { newCount: totalNew, modCount: totalMod };
}

/**
 * Thử lấy rổ hàng qua /get-map-data (1 request cho toàn bộ mặt bằng)
 */
async function fetchViaMapData(projectId, referer, sessionState) {
  const mapUrl = `${BASE_URL}/get-map-data?code=&direction=&status=&fund_type=&project_id=${projectId}`;
  const res = await fetchWithHisaleSession(
    mapUrl,
    { isJson: true, referer, timeout: 30000 },
    sessionState
  );

  if (Array.isArray(res.data)) return res.data;
  if (res.data && Array.isArray(res.data.data)) return res.data.data;
  return null;
}

/**
 * Lấy rổ hàng phân trang qua /get-map-data-paginate (dùng cho cao tầng và fallback thấp tầng)
 */
async function fetchViaPaginate(projectId, isInitialSync, projectMeta, referer, sessionState) {
  const paginateUrl = `${BASE_URL}/get-map-data-paginate`;
  let currentPage = 1;
  let lastPage = 1;
  let totalScanned = 0;
  let totalNewUnits = 0;
  let totalUpdatedUnits = 0;
  let expectedTotal = null;

  while (currentPage <= lastPage && currentPage <= 500) {
    const response = await fetchWithHisaleSession(
      paginateUrl,
      {
        params: {
          project_id: projectId,
          list: 'true',
          page: currentPage,
          code: '',
          area_build: '',
          'area_land_range[]': [0, 5000],
          'price_range[]': [0, 1000],
          sort_by: 'hot_priority',
          sort_desc: 'false'
        },
        isJson: true,
        referer,
        timeout: 25000
      },
      sessionState
    );

    const data = response.data;
    if (!data || !Array.isArray(data.data)) {
      if (currentPage === 1) {
        return null; // Cho phép fallback sang /get-map-data nếu cấu trúc API không hợp lệ
      }
      break;
    }

    lastPage = Number(data.last_page) || 1;
    const totalExpected = Number(data.total) || '?';
    if (Number.isFinite(Number(data.total))) expectedTotal = Number(data.total);
    const unitsOnPage = data.data;
    totalScanned += unitsOnPage.length;

    if (unitsOnPage.length === 0) {
      break;
    }

    const { newCount, modCount } = await saveUnitsToMongo(unitsOnPage, projectId, isInitialSync, projectMeta);
    totalNewUnits += newCount;
    totalUpdatedUnits += modCount;

    console.log(
      `[HiSale] [ID ${projectId}] Trang ${currentPage}/${lastPage}: ${unitsOnPage.length} căn (Đã gom: ${totalScanned}/${totalExpected}) | +${newCount} mới, ${modCount} cập nhật`
    );

    currentPage++;
    if (currentPage <= lastPage) {
      await sleep(500);
    }
  }

  return {
    totalScanned,
    newUnitsCount: totalNewUnits,
    updatedUnitsCount: totalUpdatedUnits,
    scanComplete: (expectedTotal !== null && totalScanned >= expectedTotal && currentPage >= lastPage) || currentPage > lastPage,
  };
}

/**
 * Cào toàn bộ danh sách căn của 1 dự án trên HiSale (hỗ trợ cả thấp tầng & cao tầng)
 *
 * @param {number|object} projectIdOrMeta - ID dự án hoặc object metadata từ collection Project
 * @param {boolean} isInitialSync - Lần cào đầu tiên (nếu true: gán is_notified = true để không bắn mail)
 * @param {object|null} sharedSessionState - State session dùng chung khi chạy nhiều dự án
 */
async function crawlHisaleProject(projectIdOrMeta = 19, isInitialSync = false, sharedSessionState = null) {
  const scanStartedAt = new Date();
  let projectMeta = null;
  let projectId;

  if (projectIdOrMeta && typeof projectIdOrMeta === 'object') {
    projectMeta = projectIdOrMeta;
    projectId = Number(projectIdOrMeta.project_id);
  } else {
    projectId = Number(projectIdOrMeta);
    projectMeta = await Project.findOne({ source: 'hisale', project_id: projectId }).lean();
  }

  const projectName =
    (projectMeta && projectMeta.project_name) || PROJECT_NAMES[projectId] || `Dự án ID ${projectId}`;
  const projectType = (projectMeta && projectMeta.project_type) || '';
  const projectSlug = (projectMeta && projectMeta.project_slug) || '';
  const referer = projectSlug ? `${BASE_URL}/du-an/${projectSlug}` : `${BASE_URL}/du-an?tab=0`;

  console.log(`\n--------------------------------------------------`);
  console.log(`[HiSale] Đang cào dự án [${projectId}] ${projectName}${projectType ? ` (${projectType})` : ''}`);
  console.log(`--------------------------------------------------`);

  const sessionState = sharedSessionState || { current: await getHisaleSession() };

  let stats = null;

  if (projectType === 'high_rise') {
    // Cao tầng: ưu tiên /get-map-data-paginate (đúng API tab Quỹ căn trên trình duyệt, lấy đủ các tòa/tầng)
    try {
      stats = await fetchViaPaginate(projectId, isInitialSync, projectMeta, referer, sessionState);
    } catch (err) {
      console.warn(`[HiSale] [ID ${projectId}] Lỗi /get-map-data-paginate: ${err.message}. Thử fallback /get-map-data...`);
    }

    if (!stats) {
      const units = await fetchViaMapData(projectId, referer, sessionState);
      if (units && units.length > 0) {
        const { newCount, modCount } = await saveUnitsToMongo(units, projectId, isInitialSync, projectMeta);
        stats = { totalScanned: units.length, newUnitsCount: newCount, updatedUnitsCount: modCount, scanComplete: true };
      } else {
        stats = { totalScanned: 0, newUnitsCount: 0, updatedUnitsCount: 0, scanComplete: Array.isArray(units) };
      }
    }
  } else {
    // Thấp tầng (hoặc chưa rõ loại): ưu tiên /get-map-data (1 request toàn bộ mặt bằng), fallback sang /get-map-data-paginate
    let mapUnits = null;
    try {
      mapUnits = await fetchViaMapData(projectId, referer, sessionState);
    } catch (err) {
      console.warn(`[HiSale] [ID ${projectId}] Lỗi /get-map-data: ${err.message}. Chuyển sang /get-map-data-paginate...`);
    }

    if (mapUnits && mapUnits.length > 0) {
      const { newCount, modCount } = await saveUnitsToMongo(mapUnits, projectId, isInitialSync, projectMeta);
      stats = { totalScanned: mapUnits.length, newUnitsCount: newCount, updatedUnitsCount: modCount, scanComplete: true };
    } else {
      stats =
        (await fetchViaPaginate(projectId, isInitialSync, projectMeta, referer, sessionState)) || {
          totalScanned: 0,
          newUnitsCount: 0,
          updatedUnitsCount: 0
        };
    }
  }

  // Cập nhật số lượng căn thực tế vào collection 'projects'
  if (!stats.scanComplete) throw new Error('Incomplete HiSale inventory scan');
  await markMissing(Unit, {source:'hisale', project_id: {$in:[projectId,String(projectId)]}}, scanStartedAt);
  await Project.updateOne(
    { source: 'hisale', project_id: projectId },
    {
      $set: {
        apartment_count: stats.totalScanned,
        out_of_stock: stats.totalScanned > 0 ? 0 : 1,
        updated_at: new Date()
      }
    }
  );

  console.log(
    `[HiSale] ✅ Xong [${projectId}] ${projectName}: Quét ${stats.totalScanned} căn | Mới +${stats.newUnitsCount} | Cập nhật ${stats.updatedUnitsCount}`
  );

  return stats;
}

/**
 * Cào toàn bộ dự án đang mở bán trên HiSale (cả thấp tầng & cao tầng) hoặc theo danh sách ID chỉ định
 */
async function crawlAllHisaleProjects(isInitialSync = false, scopeOverride = null) {
  console.log(`\n==================================================`);
  console.log(`[HiSale] Bắt đầu phiên cào HiSale`);
  console.log(`[HiSale] Chế độ: ${isInitialSync ? 'KHỞI TẠO LẦN ĐẦU (Không gửi mail)' : 'CÀO BÌNH THƯỜNG'}`);
  console.log(`==================================================\n`);

  const sessionState = { current: await getHisaleSession() };
  const rawScope = String(
    scopeOverride || process.env.HISALE_PROJECT_IDS || process.env.HISALE_PROJECT_ID || 'ALL'
  ).trim();
  const isAll = !rawScope || rawScope.toUpperCase() === 'ALL';

  let targetProjects = [];

  if (isAll) {
    const allProjects = await fetchAllHisaleProjects(sessionState);
    const activeProjects = allProjects.filter((p) => p.state === 'public' && Number.isInteger(p.project_id));
    const activeIds = new Set(activeProjects.map((p) => p.project_id));

    // Nếu cả dự án cha (VD: 39) lẫn phân khu con đều xuất hiện, bỏ qua phân khu con vì API dự án cha trả về toàn bộ
    targetProjects = activeProjects.filter((p) => !p.parent_id || !activeIds.has(p.parent_id));

    const lowRiseCount = targetProjects.filter((p) => p.project_type === 'low_rise').length;
    const highRiseCount = targetProjects.filter((p) => p.project_type === 'high_rise').length;
    const otherCount = targetProjects.length - lowRiseCount - highRiseCount;

    console.log(`\n[HiSale] 📊 Thống kê danh mục dự án HiSale:`);
    console.log(`- Tổng dự án phân giải được: ${allProjects.length}`);
    console.log(`- Đang kích hoạt & sẵn sàng cào: ${targetProjects.length}`);
    console.log(`  + Thấp tầng (low_rise): ${lowRiseCount}`);
    console.log(`  + Cao tầng (high_rise): ${highRiseCount}`);
    if (otherCount > 0) {
      console.log(`  + Khác / chưa phân loại: ${otherCount}`);
    }
  } else {
    const requestedIds = rawScope
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);

    const dbProjects = await Project.find({
      source: 'hisale',
      project_id: { $in: requestedIds }
    }).lean();
    const dbMap = new Map(dbProjects.map((p) => [p.project_id, p]));

    targetProjects = requestedIds.map(
      (id) =>
        dbMap.get(id) || {
          project_id: id,
          project_name: PROJECT_NAMES[id] || `Dự án ID ${id}`,
          project_type: ''
        }
    );
  }

  let totalScanned = 0;
  let totalNewUnits = 0;
  let totalUpdatedUnits = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const proj of targetProjects) {
    try {
      const stats = await crawlHisaleProject(proj, isInitialSync, sessionState);
      totalScanned += stats.totalScanned;
      totalNewUnits += stats.newUnitsCount;
      totalUpdatedUnits += stats.updatedUnitsCount;
      successCount++;
    } catch (err) {
      errorCount++;
      console.error(`[HiSale] ❌ Lỗi khi cào dự án [${proj.project_id}] ${proj.project_name}: ${err.message}`);
    }
    await sleep(600);
  }

  console.log(`\n==================================================`);
  console.log(`[HiSale] TỔNG KẾT PHIÊN CÀO HISALE:`);
  console.log(`- Số dự án đã quét thành công: ${successCount}/${targetProjects.length} (lỗi: ${errorCount})`);
  console.log(`- Tổng số căn quét được: ${totalScanned}`);
  console.log(`- Số căn mới phát hiện: ${totalNewUnits}`);
  console.log(`- Số căn được cập nhật: ${totalUpdatedUnits}`);
  console.log(`==================================================\n`);

  if (targetProjects.length > 0 && successCount === 0 && errorCount > 0) {
    throw new Error('Toàn bộ dự án HiSale đều gặp lỗi khi cào.');
  }

  return {
    totalScanned,
    newUnitsCount: totalNewUnits,
    updatedUnitsCount: totalUpdatedUnits,
    successProjects: successCount,
    errorProjects: errorCount,
    skippedProjects: Math.max(0, targetProjects.length - successCount - errorCount),
  };
}

module.exports = {
  fetchAllHisaleProjects,
  crawlHisaleProject,
  crawlAllHisaleProjects,
  parseCatalogPageHtml,
  parseHisaleProjectDataFromHtml,
  saveUnitsToMongo
};
