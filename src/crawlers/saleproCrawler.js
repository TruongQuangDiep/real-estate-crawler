const axios = require('axios');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const { getSaleProSession, loginSalePro, buildSaleProHeaders } = require('../services/saleproAuth');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SALEPRO_API_BASE = 'https://salepro.com/api/rest_api/pu/property/master/data';
const DEFAULT_PROJECT_NAME = 'VINHOMES GREEN PARADISE';

/**
 * Tạo Axios client với headers & session cho SalePro
 */
function createSaleProClient(session = {}, referer = 'https://salepro.com/project-page') {
  return axios.create({
    baseURL: SALEPRO_API_BASE,
    timeout: 30000,
    headers: buildSaleProHeaders(session, referer)
  });
}

/**
 * Kiểm tra xem lỗi có phải do hết hạn token / chưa đăng nhập (401/403) hay không
 */
function isAuthError(err) {
  if (!err) return false;
  if (err.isAuthError) return true;
  const status = err.response && err.response.status;
  return status === 401 || status === 403;
}

/**
 * Tạo error auth thống nhất khi API trả code !== 1 với dấu hiệu chưa xác thực
 */
function isApiAuthRejection(resData) {
  if (!resData || resData.code === 1) return false;
  const msg = String(resData.message || resData.error_message || '').toLowerCase();
  return (
    resData.code === 401 ||
    resData.code === 403 ||
    msg.includes('token') ||
    msg.includes('auth') ||
    msg.includes('login') ||
    msg.includes('đăng nhập')
  );
}

/**
 * Thực thi tác vụ với SalePro client; nếu token hết hạn (401/403) sẽ tự động đăng nhập lại 1 lần và thử lại
 */
async function withSaleProRetry(sessionHolder, referer, taskFn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = createSaleProClient(sessionHolder.session, referer);
    try {
      return await taskFn(client);
    } catch (err) {
      if (attempt === 0 && isAuthError(err)) {
        console.warn('[SalePro] 🔄 Session hết hạn hoặc bị từ chối. Đang tự động đăng nhập lại...');
        sessionHolder.session = await loginSalePro();
        continue;
      }
      throw err;
    }
  }
}

/**
 * Thực hiện bulkWrite theo từng chunk 500 bản ghi để tránh quá tải MongoDB
 */
async function saveUnitBulkOps(bulkOps) {
  if (!bulkOps || bulkOps.length === 0) {
    return { totalNew: 0, totalMod: 0 };
  }

  const CHUNK_SIZE = 500;
  let totalNew = 0;
  let totalMod = 0;

  for (let i = 0; i < bulkOps.length; i += CHUNK_SIZE) {
    const chunk = bulkOps.slice(i, i + CHUNK_SIZE);
    const bulkResult = await Unit.bulkWrite(chunk, { ordered: false });
    totalNew += bulkResult.upsertedCount || 0;
    totalMod += bulkResult.modifiedCount || 0;
  }

  return { totalNew, totalMod };
}

/**
 * Lấy toàn bộ danh sách dự án từ SalePro, lưu vào collection `projects`,
 * và lọc ra các dự án đang mở bán (state === 'public', out_of_stock === 0, apartment_count > 0)
 */
async function fetchAllSaleProProjects(sessionHolderOrClient) {
  console.log('[SalePro] 📋 Đang tải danh sách toàn bộ dự án từ API /search_duan_data/...');

  const sessionHolder =
    sessionHolderOrClient && sessionHolderOrClient.session !== undefined
      ? sessionHolderOrClient
      : { session: await getSaleProSession() };

  const limit = 50;
  let allProjects = [];

  await withSaleProRetry(sessionHolder, 'https://salepro.com/project-page', async (client) => {
    allProjects = [];
    let currentPage = 1;
    let totalProjects = 0;

    while (true) {
      const res = await client.get('/search_duan_data/', {
        params: {
          limit,
          page: currentPage
        }
      });

      if (isApiAuthRejection(res.data)) {
        const authErr = new Error(`[SalePro] Yêu cầu đăng nhập: ${JSON.stringify(res.data).slice(0, 250)}`);
        authErr.isAuthError = true;
        throw authErr;
      }

      if (!res.data || res.data.code !== 1 || !Array.isArray(res.data.data)) {
        const apiMsg = res.data ? JSON.stringify(res.data).slice(0, 300) : 'Empty response';
        throw new Error(`[SalePro] API danh sách dự án trả về lỗi: ${apiMsg}`);
      }

      const batch = res.data.data;
      totalProjects = Number(res.data.total) || batch.length;
      if (batch.length === 0) break;

      allProjects = allProjects.concat(batch);
      console.log(
        `[SalePro] Trang dự án ${currentPage}: ${batch.length} dự án (Đã gom: ${allProjects.length}/${totalProjects})`
      );

      if (allProjects.length >= totalProjects || batch.length < limit) break;

      currentPage++;
      await sleep(250);
    }
  });

  // Lưu toàn bộ dự án vào collection `projects` để quản lý & đối chiếu
  if (allProjects.length > 0) {
    const projectBulkOps = allProjects.map((p) => ({
      updateOne: {
        filter: {
          source: 'salepro',
          project_id: Number(p.project_id)
        },
        update: {
          $set: {
            source: 'salepro',
            project_id: Number(p.project_id),
            project_code: p.project_code || '',
            project_name: p.project_name || `SALEPRO_${p.project_id}`,
            project_slug: p.project_slug || '',
            project_type: p.project_type || '',
            investor: p.investor || '',
            project_address: p.project_address || '',
            state: p.state || '',
            out_of_stock: Number(p.out_of_stock ?? 0),
            apartment_count: Number(p.apartment_count ?? 0),
            min_price: Number(p.min_apartment_price) || 0,
            max_price: Number(p.max_apartment_price) || 0,
            raw_data: p,
            updated_at: new Date()
          }
        },
        upsert: true
      }
    }));

    await Project.bulkWrite(projectBulkOps, { ordered: false });
    console.log(`[SalePro] 💾 Đã đồng bộ ${allProjects.length} dự án vào collection 'projects'.`);
  }

  // Chỉ lấy dự án đang mở bán & còn căn
  const activeProjects = allProjects.filter(
    (p) => p.state === 'public' && Number(p.out_of_stock ?? 0) === 0 && Number(p.apartment_count ?? 0) > 0
  );

  return {
    allProjects,
    activeProjects
  };
}

/**
 * Cào 1 dự án thấp tầng (low_rise) qua API Quỹ Căn: /search_tindang_low_rise_data/
 */
async function crawlSaleProLowRise(client, projectId, isInitialSync, projectMeta = {}) {
  let currentPage = 1;
  const limit = 100;
  let totalRecords = 0;
  let allUnits = [];

  while (true) {
    const res = await client.get('/search_tindang_low_rise_data/', {
      params: {
        state: 'notSold',
        project_id: projectId,
        page: currentPage,
        limit
      }
    });

    if (isApiAuthRejection(res.data)) {
      const authErr = new Error(`[SalePro] Lỗi xác thực khi cào dự án ${projectId}`);
      authErr.isAuthError = true;
      throw authErr;
    }

    if (!res.data || res.data.code !== 1 || !Array.isArray(res.data.data)) {
      break;
    }

    const units = res.data.data;
    totalRecords = Number(res.data.total) || units.length;

    if (units.length === 0) break;

    allUnits = allUnits.concat(units);
    console.log(
      `[SalePro] [ID ${projectId}] Trang ${currentPage}: ${units.length} căn (Đã gom: ${allUnits.length}/${totalRecords})`
    );

    if (allUnits.length >= totalRecords || units.length < limit) break;

    currentPage++;
    await sleep(200);
  }

  if (allUnits.length === 0) {
    return null;
  }

  const fallbackProjectName =
    projectMeta.project_name || (Number(projectId) === 1277 ? DEFAULT_PROJECT_NAME : `SALEPRO_${projectId}`);

  const bulkOps = allUnits.map((item, idx) => {
    const projectName = item.project_name || fallbackProjectName;
    const unitCode = item.product_code || item.product_name || `UNKNOWN_${item.id || item.product_id || idx}`;
    const priceNum = Number(item.apartment_price) || 0;
    const priceTtsNum = Number(item.early_payment_price) || 0;
    const priceText = priceNum ? `${(priceNum / 1e9).toFixed(2)} tỷ` : '';

    return {
      updateOne: {
        filter: {
          source: 'salepro',
          project_name: projectName,
          unit_code: unitCode
        },
        update: {
          $set: {
            project_id: item.project_id || Number(projectId),
            project_name: projectName,
            subdivision: item.subdivision_name || item.row_name || '',
            unit_type: item.apartment_type_name || '',
            area_land: Number(item.land_area) || 0,
            area_build: Number(item.construction_area) || 0,
            price: priceNum,
            price_text: priceText,
            price_tts: priceTtsNum,
            status: item.state_line_name || (item.state_line === 'available' ? 'Còn hàng' : item.state_line || ''),
            direction: item.base_direction_name || '',
            delivery_standard: item.delivery_standard_name || '',
            bank_support: item.fund_groups_sell_code ? `Quỹ: ${item.fund_groups_sell_code}` : '',
            image_urls: [],
            raw_data: item,
            updated_at: new Date()
          },
          $setOnInsert: {
            created_at: new Date(),
            is_notified: isInitialSync ? true : false
          }
        },
        upsert: true
      }
    };
  });

  const { totalNew, totalMod } = await saveUnitBulkOps(bulkOps);

  return {
    totalScanned: allUnits.length,
    newUnitsCount: totalNew,
    updatedUnitsCount: totalMod
  };
}

/**
 * Fallback: Cào qua API Mặt Bằng (/get_canho_matbang) cho dự án 1277 khi có coordinate_manager_id
 */
async function crawlSaleProMapFallback(client, projectId, isInitialSync, projectMeta = {}) {
  console.log(`[SalePro] [Fallback] Đang gọi API get_canho_matbang cho dự án ${projectId}...`);
  const coordinateManagerId = process.env.SALEPRO_COORDINATE_MANAGER_ID || 645;
  const response = await client.get('/get_canho_matbang/', {
    params: {
      coordinate_manager_id: coordinateManagerId,
      state: 'notSold'
    }
  });

  if (!response.data || response.data.code !== 1 || !Array.isArray(response.data.data)) {
    throw new Error(`[SalePro] API Mặt Bằng không có dữ liệu: ${JSON.stringify(response.data)}`);
  }

  const fundGroups = response.data.data;
  const allUnits = [];

  fundGroups.forEach((group) => {
    const groupCode = group.fund_groups_sell_code || '';
    const groupName = group.fund_groups_sell_name || '';
    const apartments = group.apartment_data || [];

    apartments.forEach((apt) => {
      allUnits.push({
        ...apt,
        _fund_group_name: groupName,
        _fund_group_code: groupCode
      });
    });
  });

  const projectName = projectMeta.project_name || DEFAULT_PROJECT_NAME;
  const subdivisionMap = { 4775: 'VỊNH TIÊN', 4706: 'Vịnh Ngọc' };

  const bulkOps = allUnits.map((item) => {
    const unitCode = item.product_code || item.product_name || `UNKNOWN_${item.product_id}`;
    const subdivision = subdivisionMap[item.subdivision_id] || `Phân khu ${item.subdivision_id}`;
    const priceNum = Number(item.apartment_price) || 0;
    const priceTtsNum = Number(item.apartment_early_price) || 0;
    const priceText = priceNum ? `${(priceNum / 1e9).toFixed(2)} tỷ` : '';

    return {
      updateOne: {
        filter: {
          source: 'salepro',
          project_name: projectName,
          unit_code: unitCode
        },
        update: {
          $set: {
            project_id: item.project_id || Number(projectId),
            project_name: projectName,
            subdivision,
            price: priceNum,
            price_text: priceText,
            price_tts: priceTtsNum,
            status: item.state_line === 'available' ? 'Còn hàng' : item.state_line || 'Còn hàng',
            delivery_standard: item._fund_group_name || '',
            raw_data: item,
            updated_at: new Date()
          },
          $setOnInsert: {
            created_at: new Date(),
            is_notified: isInitialSync ? true : false
          }
        },
        upsert: true
      }
    };
  });

  const { totalNew, totalMod } = await saveUnitBulkOps(bulkOps);

  return {
    totalScanned: allUnits.length,
    newUnitsCount: totalNew,
    updatedUnitsCount: totalMod
  };
}

/**
 * Cào dữ liệu 1 dự án SalePro cụ thể (hỗ trợ tự động đăng nhập lại nếu hết hạn session)
 */
async function crawlSaleProProject(projectId = 1277, isInitialSync = false, projectMeta = {}, sessionHolder = null) {
  const projectLabel =
    projectMeta.project_name || (Number(projectId) === 1277 ? DEFAULT_PROJECT_NAME : `ID ${projectId}`);

  if (projectMeta.project_type === 'high_rise') {
    console.log(
      `[SalePro] ⏭️ Bỏ qua dự án cao tầng [${projectId}] ${projectLabel} (${projectMeta.apartment_count || '?'} căn) — đang chờ cURL API Quỹ căn cao tầng (high_rise).`
    );
    return {
      totalScanned: 0,
      newUnitsCount: 0,
      updatedUnitsCount: 0,
      skippedHighRise: true
    };
  }

  console.log(`\n--------------------------------------------------`);
  console.log(`[SalePro] Đang cào dự án [${projectId}] ${projectLabel}`);
  console.log(`--------------------------------------------------`);

  const holder = sessionHolder || { session: await getSaleProSession() };
  const referer = projectMeta.project_slug
    ? `https://salepro.com/project-detail/${projectMeta.project_slug}#quy-can`
    : 'https://salepro.com/project-page';

  try {
    const result = await withSaleProRetry(holder, referer, (client) =>
      crawlSaleProLowRise(client, projectId, isInitialSync, projectMeta)
    );
    if (result) {
      console.log(
        `[SalePro] ✅ Xong [${projectId}] ${projectLabel}: Quét ${result.totalScanned} căn | Mới +${result.newUnitsCount} | Cập nhật ${result.updatedUnitsCount}`
      );
      return result;
    }

    console.log(`[SalePro] ℹ️ Dự án [${projectId}] ${projectLabel}: API Quỹ căn thấp tầng trả về 0 căn khả dụng.`);
    return { totalScanned: 0, newUnitsCount: 0, updatedUnitsCount: 0 };
  } catch (err) {
    // Chỉ fallback dùng coordinate_manager_id=645 cho dự án 1277 nếu không phải lỗi xác thực không cứu được
    if (Number(projectId) === 1277 && !isAuthError(err)) {
      console.warn(`[SalePro] Lỗi API Quỹ Căn dự án 1277: ${err.message}. Thử fallback API Mặt Bằng...`);
      return await withSaleProRetry(holder, referer, (client) =>
        crawlSaleProMapFallback(client, projectId, isInitialSync, projectMeta)
      );
    }

    throw err;
  }
}

/**
 * Cào toàn bộ các dự án đang mở bán trên SalePro (hoặc theo danh sách ID trong SALEPRO_PROJECT_IDS)
 */
async function crawlAllSaleProProjects(isInitialSync = false) {
  console.log(`\n==================================================`);
  console.log(`[SalePro] Bắt đầu phiên cào SalePro`);
  console.log(`[SalePro] Chế độ: ${isInitialSync ? 'KHỞI TẠO LẦN ĐẦU (Không gửi mail)' : 'CÀO BÌNH THƯỜNG'}`);
  console.log(`==================================================\n`);

  const sessionHolder = { session: await getSaleProSession() };
  const rawConfig = (process.env.SALEPRO_PROJECT_IDS || process.env.SALEPRO_PROJECT_ID || 'ALL').trim();

  let targetProjects = [];
  let highRiseCount = 0;

  if (rawConfig.toUpperCase() === 'ALL') {
    const { allProjects, activeProjects } = await fetchAllSaleProProjects(sessionHolder);
    const lowRiseProjects = activeProjects.filter((p) => p.project_type !== 'high_rise');
    const highRiseProjects = activeProjects.filter((p) => p.project_type === 'high_rise');

    highRiseCount = highRiseProjects.length;
    targetProjects = lowRiseProjects;

    console.log(`\n[SalePro] 📊 Thống kê danh mục dự án SalePro:`);
    console.log(`- Tổng dự án toàn sàn: ${allProjects.length}`);
    console.log(`- Đang mở bán & còn căn (public, out_of_stock=0, >0 căn): ${activeProjects.length}`);
    console.log(`  + Thấp tầng (low_rise - sẵn sàng cào ngay): ${lowRiseProjects.length}`);
    console.log(`  + Cao tầng (high_rise - chờ API Quỹ căn cao tầng): ${highRiseProjects.length}`);

    if (highRiseProjects.length > 0) {
      const sampleNames = highRiseProjects
        .slice(0, 5)
        .map((p) => `[${p.project_id}] ${p.project_name} (${p.apartment_count} căn)`)
        .join(', ');
      console.log(`[SalePro] 💡 Ví dụ dự án cao tầng đang tạm bỏ qua: ${sampleNames}`);
    }
  } else {
    const ids = rawConfig
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);

    const existingDocs = await Project.find({ source: 'salepro', project_id: { $in: ids } }).lean();
    const metaById = new Map(existingDocs.map((d) => [d.project_id, d]));

    targetProjects = ids.map((id) => metaById.get(id) || { project_id: id });
  }

  let totalScanned = 0;
  let newUnitsCount = 0;
  let updatedUnitsCount = 0;
  let successProjects = 0;
  let failedProjects = 0;

  for (const projectMeta of targetProjects) {
    try {
      const stats = await crawlSaleProProject(projectMeta.project_id, isInitialSync, projectMeta, sessionHolder);
      totalScanned += stats.totalScanned;
      newUnitsCount += stats.newUnitsCount;
      updatedUnitsCount += stats.updatedUnitsCount;
      if (!stats.skippedHighRise) {
        successProjects++;
      }
    } catch (err) {
      if (isAuthError(err)) {
        throw err;
      }
      failedProjects++;
      console.error(
        `[SalePro] ❌ Lỗi khi cào dự án [${projectMeta.project_id}] ${projectMeta.project_name || ''}: ${err.message}`
      );
    }

    await sleep(300);
  }

  console.log(`\n==================================================`);
  console.log(`[SalePro] TỔNG KẾT PHIÊN CÀO SALEPRO:`);
  console.log(`- Số dự án thấp tầng đã quét thành công: ${successProjects}/${targetProjects.length} (lỗi: ${failedProjects})`);
  if (highRiseCount > 0) {
    console.log(`- Số dự án cao tầng tạm bỏ qua (chờ API high_rise): ${highRiseCount}`);
  }
  console.log(`- Tổng số căn quét được: ${totalScanned}`);
  console.log(`- Số căn mới phát hiện: ${newUnitsCount}`);
  console.log(`- Số căn được cập nhật: ${updatedUnitsCount}`);
  console.log(`==================================================\n`);

  return {
    totalScanned,
    newUnitsCount,
    updatedUnitsCount,
    successProjects,
    errorProjects: failedProjects,
    skippedProjects: 0
  };
}

module.exports = {
  fetchAllSaleProProjects,
  crawlSaleProProject,
  crawlAllSaleProProjects
};
