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
 * Kiểm tra tính an toàn của URL và ngăn chặn tấn công SSRF (Server-Side Request Forgery)
 * @param {string} rawUrl - URL cần kiểm tra
 * @returns {string} URL đã được chuẩn hóa
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
 * Kiểm tra chữ ký nhị phân (Magic Bytes) và Content-Type của file:
 * - Ngăn chặn upload trang HTML báo lỗi, JSON, XML dưới dạng file ảnh
 * - Không mặc định dữ liệu không rõ định dạng thành JPEG
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

  // 2. Nhận diện định dạng qua Magic Bytes nhị phân chuẩn xác
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

  // GIF: GIF87a hoặc GIF89a (47 49 46 38)
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return { mimeType: 'image/gif', ext: 'gif' };
  }

  // WEBP: RIFF....WEBP (52 49 46 46 .... 57 45 42 50)
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

  // PDF: %PDF- (25 50 44 46)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return { mimeType: 'application/pdf', ext: 'pdf' };
  }

  // BMP: BM (42 4D)
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mimeType: 'image/bmp', ext: 'bmp' };
  }

  // 3. Nếu Magic Bytes không khớp nhưng URL hoặc Content-Type là ảnh hợp lệ:
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
        // Link ảnh gốc đã bị xóa vĩnh viễn trên sàn, không cần retry
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
 * Phân loại chính xác phân khúc Cao tầng hay Thấp tầng dựa trên dữ liệu căn hộ hoặc dự án
 * @param {Object} item - Bản ghi Unit hoặc Project
 * @returns {'Cao_tang' | 'Thap_tang'}
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

  // Nếu có số tầng (floor khác rỗng và khác 0) -> Cao tầng
  const floor = String(item.floor || item.number_of_floor || '').trim();
  if (floor && floor !== '0') return 'Cao_tang';

  // Nếu có tên tòa (building) -> Cao tầng
  const building = String(item.building || item.building_name || '').trim();
  if (building) return 'Cao_tang';

  // Kiểm tra tên loại căn
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
 * Phân tách các URL trong share_content của SalePro thành link ảnh trực tiếp vs link web/tài liệu
 */
function parseSaleProShareContent(shareContent = '') {
  if (!shareContent || typeof shareContent !== 'string') {
    return { layoutImageUrls: [], documentUrls: [] };
  }

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = shareContent.match(urlRegex) || [];
  const layoutImageUrls = [];
  const documentUrls = [];

  for (const rawUrl of matches) {
    const cleanUrl = rawUrl.replace(/[.,;!]+$/, '').trim();
    const lower = cleanUrl.toLowerCase();

    // Link ảnh trực tiếp
    if (lower.match(/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i)) {
      if (!layoutImageUrls.includes(cleanUrl)) layoutImageUrls.push(cleanUrl);
    } else {
      // Link tài liệu PDF hoặc trang chia sẻ tài liệu
      if (!documentUrls.includes(cleanUrl)) documentUrls.push(cleanUrl);
    }
  }

  return { layoutImageUrls, documentUrls };
}

/**
 * Cấp độ 1 & 2 SalePro: Đồng bộ hình ảnh đại diện dự án (_Project) và layout mặt bằng (_Layouts)
 */
async function syncSaleProProjectMedia(projectDoc) {
  if (!projectDoc || projectDoc.source !== 'salepro') return;

  const rawData = projectDoc.raw_data || {};
  const projectAvatarUrl = rawData.avatar?.image_url || '';
  const { layoutImageUrls, documentUrls } = parseSaleProShareContent(rawData.share_content || '');

  // Cập nhật document_urls cho dự án
  if (documentUrls.length > 0 && (!projectDoc.document_urls || projectDoc.document_urls.length === 0)) {
    projectDoc.document_urls = documentUrls;
  }

  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    if (projectAvatarUrl && (!projectDoc.project_image_urls || projectDoc.project_image_urls.length === 0)) {
      projectDoc.project_image_urls = [projectAvatarUrl];
    }
    await projectDoc.save();
    return;
  }

  try {
    const segment = determineSegment(projectDoc);

    // 1. Đồng bộ ảnh avatar dự án vào SalePro/<Segment>/<PROJECT_NAME>/_Project
    if (projectAvatarUrl) {
      projectDoc.project_image_urls = [projectAvatarUrl];

      // Kiểm tra thư mục dự án cũ trên Drive xem còn tồn tại không
      let folderValid = false;
      if (projectDoc.drive_folder_id) {
        folderValid = await verifyDriveItemExists(projectDoc.drive_folder_id);
      }

      const folder = folderValid
        ? { id: projectDoc.drive_folder_id, webViewLink: projectDoc.drive_folder_url }
        : await ensureFolderPath(['SalePro', segment, projectDoc.project_name, '_Project']);

      projectDoc.drive_folder_id = folder.id;
      projectDoc.drive_folder_url = folder.webViewLink;

      const { buffer, mimeType, ext, etag, lastModified } = await downloadBufferWithRetry(projectAvatarUrl);
      const sha256 = computeSha256(buffer);

      const existingStored = (projectDoc.stored_images || []).find(
        (img) => img.original_url === projectAvatarUrl && img.image_type === '_PROJECT'
      );

      // Nếu nội dung thay đổi (SHA-256 khác) hoặc chưa upload:
      if (!existingStored || existingStored.sha256 !== sha256) {
        const uploaded = await uploadFile({
          name: `project_avatar.${ext}`,
          buffer,
          mimeType,
          parentFolderId: folder.id,
          description: `Ảnh đại diện dự án ${projectDoc.project_name}`,
        });

        projectDoc.drive_project_image_urls = [uploaded.webViewLink];
        projectDoc.stored_images = (projectDoc.stored_images || []).filter(
          (img) => !(img.original_url === projectAvatarUrl && img.image_type === '_PROJECT')
        );
        projectDoc.stored_images.push({
          original_url: projectAvatarUrl,
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
        projectDoc.image_sync_status = 'SUCCESS';
        projectDoc.image_synced_at = new Date();
        await projectDoc.save();
      }
    }

    // 2. Đồng bộ layout nếu có link ảnh trực tiếp vào SalePro/<Segment>/<PROJECT_NAME>/_Layouts
    if (layoutImageUrls.length > 0) {
      projectDoc.layout_image_urls = layoutImageUrls;
      const layoutFolder = await ensureFolderPath(['SalePro', segment, projectDoc.project_name, '_Layouts']);

      for (let i = 0; i < layoutImageUrls.length; i++) {
        const lUrl = layoutImageUrls[i];
        try {
          const { buffer, mimeType, ext, etag, lastModified } = await downloadBufferWithRetry(lUrl);
          const sha256 = computeSha256(buffer);

          const existingStored = (projectDoc.stored_images || []).find(
            (img) => img.original_url === lUrl && img.image_type === '_LAYOUT'
          );

          if (!existingStored || existingStored.sha256 !== sha256) {
            const uploaded = await uploadFile({
              name: `layout_${i + 1}.${ext}`,
              buffer,
              mimeType,
              parentFolderId: layoutFolder.id,
              description: `Layout dự án ${projectDoc.project_name}`,
            });

            projectDoc.drive_layout_image_urls = projectDoc.drive_layout_image_urls || [];
            if (!projectDoc.drive_layout_image_urls.includes(uploaded.webViewLink)) {
              projectDoc.drive_layout_image_urls.push(uploaded.webViewLink);
            }

            projectDoc.stored_images = (projectDoc.stored_images || []).filter(
              (img) => !(img.original_url === lUrl && img.image_type === '_LAYOUT')
            );
            projectDoc.stored_images.push({
              original_url: lUrl,
              drive_file_id: uploaded.id,
              drive_url: uploaded.webViewLink,
              sha256,
              mime_type: mimeType,
              file_size: uploaded.size,
              etag,
              last_modified: lastModified,
              image_type: '_LAYOUT',
              uploaded_at: new Date(),
            });
            await projectDoc.save();
          }
        } catch (layoutErr) {
          console.warn(`[ImageSync] Không thể tải layout [${lUrl}]:`, layoutErr.message);
        }
      }
    }

    await projectDoc.save();

    // Lan tỏa thông tin ảnh dự án dùng chung cho các căn thuộc dự án này
    if (projectDoc.drive_project_image_urls && projectDoc.drive_project_image_urls.length > 0) {
      await Unit.updateMany(
        {
          source: 'salepro',
          project_name: projectDoc.project_name,
          $or: [
            { drive_project_image_urls: { $exists: false } },
            { drive_project_image_urls: { $size: 0 } },
          ],
        },
        {
          $set: {
            project_image_urls: projectDoc.project_image_urls,
            drive_project_image_urls: projectDoc.drive_project_image_urls,
            document_urls: projectDoc.document_urls || [],
          },
        }
      );
    }
  } catch (err) {
    console.error(`[ImageSync] ❌ Lỗi đồng bộ media dự án ${projectDoc.project_name}:`, err.message);
  }
}

/**
 * Xử lý đồng bộ hình ảnh cho một bản ghi Unit cụ thể:
 * - Khóa xử lý có thời hạn
 * - Kiểm tra tính toàn vẹn thư mục Drive cũ (nếu bị xóa thì tạo lại)
 * - Kiểm tra SHA-256 thay đổi
 * - Lưu tiến độ ngay sau MỖI ảnh upload thành công
 */
async function syncSingleUnit(unitDoc) {
  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    return { status: 'SKIPPED_DRIVE_DISABLED', unit_code: unitDoc.unit_code };
  }

  // Khóa bản ghi (Distributed lock)
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

    // Kiểm tra xem thư mục căn cũ trên Drive có còn tồn tại không
    let folder = null;
    if (unitDoc.drive_folder_id) {
      const exists = await verifyDriveItemExists(unitDoc.drive_folder_id);
      if (exists) {
        folder = { id: unitDoc.drive_folder_id, webViewLink: unitDoc.drive_folder_url };
      }
    }

    if (!folder) {
      // Đảm bảo cấu trúc: <Source>/<Segment>/<PROJECT_NAME>/<UNIT_CODE>/
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

        // Kiểm tra xem ảnh này đã từng được lưu chưa
        const existingStored = unitDoc.stored_images.find((img) => img.original_url === originalUrl);

        if (existingStored && existingStored.sha256 === sha256 && existingStored.drive_url) {
          // Ảnh không thay đổi nội dung -> Giữ nguyên, không upload lại
          if (!unitDoc.drive_image_urls.includes(existingStored.drive_url)) {
            unitDoc.drive_image_urls.push(existingStored.drive_url);
          }
          successCount++;
          continue;
        }

        // Kiểm tra trùng SHA-256 với một ảnh khác trong cùng căn
        const duplicateHash = unitDoc.stored_images.find((img) => img.sha256 === sha256 && img.drive_url);
        if (duplicateHash) {
          if (!unitDoc.drive_image_urls.includes(duplicateHash.drive_url)) {
            unitDoc.drive_image_urls.push(duplicateHash.drive_url);
          }
          successCount++;
          continue;
        }

        // Tải ảnh mới hoặc ảnh đã bị sửa nội dung lên Google Drive
        const fileName = `image_${String(index + 1).padStart(2, '0')}.${ext}`;
        const uploaded = await uploadFile({
          name: fileName,
          buffer,
          mimeType,
          parentFolderId: folder.id,
          description: `Ảnh căn ${unitDoc.unit_code} - Dự án ${unitDoc.project_name}`,
        });

        // Cập nhật mảng stored_images
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

        // LƯU TIẾN ĐỘ NGAY LẬP TỨC SAU MỖI FILE UPLOAD THÀNH CÔNG!
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
 * Đồng bộ một batch hình ảnh đang chờ xử lý.
 * @param {Object} options
 * @param {string} [options.source] - 'hisale' | 'salepro' | 'all'
 * @param {number|null} [options.limit] - Số lượng căn tối đa cần xử lý
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
    // 1. Đồng bộ trước media các dự án SalePro nếu cần
    if (source === 'all' || source === 'salepro') {
      const saleproProjects = await Project.find({
        source: 'salepro',
        $or: [
          { drive_project_image_urls: { $exists: false } },
          { drive_project_image_urls: { $size: 0 } },
        ],
      }).limit(5);

      for (const proj of saleproProjects) {
        await syncSaleProProjectMedia(proj);
      }
    }

    // 2. Xây dựng điều kiện truy vấn các căn cần đồng bộ ảnh
    const filterConditions = [];

    // Căn chưa từng xử lý
    filterConditions.push({
      $or: [
        { image_sync_status: { $in: ['PENDING', 'PARTIAL'] } },
        { image_sync_status: { $exists: false } },
      ],
    });

    // Căn bị crash hoặc timeout khi đang processing
    filterConditions.push({
      image_sync_status: 'PROCESSING',
      image_sync_locked_until: { $lt: new Date() },
    });

    // Căn bị lỗi nhưng chưa thử lại quá 3 lần
    filterConditions.push({
      image_sync_status: 'FAILED',
      image_sync_retries: { $lt: 3 },
    });

    // Căn đã SUCCESS nhưng phát sinh thêm ảnh mới
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

module.exports = {
  syncPendingImages,
  syncSingleUnit,
  syncSaleProProjectMedia,
  determineSegment,
  computeSha256,
  downloadBufferWithRetry,
  detectBufferFormat,
  validateSafeUrl,
  parseSaleProShareContent,
};
