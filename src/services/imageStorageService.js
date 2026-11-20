const crypto = require('crypto');
const axios = require('axios');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const {
  isDriveConfigured,
  ensureFolderPath,
  uploadFile,
} = require('./googleDriveService');

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_SIZE_MB = 20;
const DEFAULT_MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 20000;

let isSyncRunning = false;

/**
 * Tính mã băm SHA-256 từ buffer dữ liệu file
 */
function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Suy đoán MIME type và phần mở rộng file từ Content-Type hoặc URL
 */
function detectMimeAndExt(contentType = '', url = '') {
  const cleanType = String(contentType).toLowerCase().split(';')[0].trim();
  const lowerUrl = String(url).toLowerCase();

  if (cleanType.includes('png') || lowerUrl.endsWith('.png')) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (cleanType.includes('webp') || lowerUrl.endsWith('.webp')) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  if (cleanType.includes('gif') || lowerUrl.endsWith('.gif')) {
    return { mimeType: 'image/gif', ext: 'gif' };
  }
  if (cleanType.includes('pdf') || lowerUrl.endsWith('.pdf')) {
    return { mimeType: 'application/pdf', ext: 'pdf' };
  }
  return { mimeType: 'image/jpeg', ext: 'jpg' };
}

/**
 * Tải file an toàn từ URL kèm cơ chế retry và giới hạn kích thước tối đa
 */
async function downloadBufferWithRetry(url, maxRetries = DEFAULT_MAX_RETRIES) {
  const maxBytes = (Number(process.env.IMAGE_MAX_SIZE_MB) || DEFAULT_MAX_SIZE_MB) * 1024 * 1024;
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxContentLength: maxBytes,
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

      const { mimeType, ext } = detectMimeAndExt(response.headers['content-type'], url);
      return { buffer, mimeType, ext };
    } catch (err) {
      lastErr = err;
      if (err.response && (err.response.status === 404 || err.response.status === 410)) {
        // Link ảnh gốc đã bị xóa vĩnh viễn trên sàn, không cần retry
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
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
 * Cấp độ 1 & 2 SalePro: Đồng bộ hình ảnh đại diện dự án và tài liệu layout
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

      const alreadySynced = (projectDoc.stored_images || []).some(
        (img) => img.original_url === projectAvatarUrl && img.drive_url
      );

      if (!alreadySynced) {
        const folder = await ensureFolderPath(['SalePro', segment, projectDoc.project_name, '_Project']);
        projectDoc.drive_folder_id = folder.id;
        projectDoc.drive_folder_url = folder.webViewLink;

        const { buffer, mimeType, ext } = await downloadBufferWithRetry(projectAvatarUrl);
        const sha256 = computeSha256(buffer);

        const uploaded = await uploadFile({
          name: `project_avatar.${ext}`,
          buffer,
          mimeType,
          parentFolderId: folder.id,
          description: `Ảnh đại diện dự án ${projectDoc.project_name}`,
        });

        projectDoc.drive_project_image_urls = [uploaded.webViewLink];
        projectDoc.stored_images = projectDoc.stored_images || [];
        projectDoc.stored_images.push({
          original_url: projectAvatarUrl,
          drive_file_id: uploaded.id,
          drive_url: uploaded.webViewLink,
          sha256,
          mime_type: mimeType,
          file_size: uploaded.size,
          image_type: '_PROJECT',
          uploaded_at: new Date(),
        });
        projectDoc.image_sync_status = 'SUCCESS';
        projectDoc.image_synced_at = new Date();
      }
    }

    // 2. Đồng bộ layout nếu có link ảnh trực tiếp vào SalePro/<Segment>/<PROJECT_NAME>/_Layouts
    if (layoutImageUrls.length > 0) {
      projectDoc.layout_image_urls = layoutImageUrls;
      const layoutFolder = await ensureFolderPath(['SalePro', segment, projectDoc.project_name, '_Layouts']);

      for (let i = 0; i < layoutImageUrls.length; i++) {
        const lUrl = layoutImageUrls[i];
        const already = (projectDoc.stored_images || []).some((img) => img.original_url === lUrl && img.drive_url);
        if (already) continue;

        try {
          const { buffer, mimeType, ext } = await downloadBufferWithRetry(lUrl);
          const sha256 = computeSha256(buffer);
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
          projectDoc.stored_images.push({
            original_url: lUrl,
            drive_file_id: uploaded.id,
            drive_url: uploaded.webViewLink,
            sha256,
            mime_type: mimeType,
            file_size: uploaded.size,
            image_type: '_LAYOUT',
            uploaded_at: new Date(),
          });
        } catch (layoutErr) {
          console.warn(`[ImageSync] Không thể tải layout ${lUrl}:`, layoutErr.message);
        }
      }
    }

    await projectDoc.save();

    // Lan tỏa thông tin ảnh dự án dùng chung cho tất cả các căn thuộc dự án này
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
 * Xử lý đồng bộ hình ảnh cho một bản ghi Unit cụ thể
 */
async function syncSingleUnit(unit) {
  const driveCheck = isDriveConfigured();
  if (!driveCheck.enabled) {
    return { status: 'SKIPPED_DRIVE_DISABLED', unit_code: unit.unit_code };
  }

  // Khóa bản ghi ở trạng thái PROCESSING
  unit.image_sync_status = 'PROCESSING';
  await unit.save();

  const sourceName = (unit.source || 'hisale').toLowerCase() === 'hisale' ? 'HiSale' : 'SalePro';
  const urlsToSync = Array.isArray(unit.image_urls) ? unit.image_urls.filter(Boolean) : [];

  // Nếu là SalePro và căn không có ảnh riêng:
  if (sourceName === 'SalePro' && urlsToSync.length === 0) {
    unit.image_sync_status = 'NO_IMAGE';
    unit.image_synced_at = new Date();
    await unit.save();
    return { status: 'NO_IMAGE', unit_code: unit.unit_code };
  }

  if (urlsToSync.length === 0) {
    unit.image_sync_status = 'NO_IMAGE';
    unit.image_synced_at = new Date();
    await unit.save();
    return { status: 'NO_IMAGE', unit_code: unit.unit_code };
  }

  try {
    const segment = determineSegment(unit);
    // Đảm bảo thư mục riêng của căn: <Source>/<Segment>/<PROJECT_NAME>/<UNIT_CODE>/
    const folder = await ensureFolderPath([sourceName, segment, unit.project_name, unit.unit_code]);
    unit.drive_folder_id = folder.id;
    unit.drive_folder_url = folder.webViewLink;

    unit.stored_images = unit.stored_images || [];
    unit.drive_image_urls = unit.drive_image_urls || [];

    let successCount = 0;
    let failCount = 0;

    for (let index = 0; index < urlsToSync.length; index++) {
      const originalUrl = urlsToSync[index];

      // Kiểm tra xem URL này đã được upload thành công trước đó chưa
      const existingStored = unit.stored_images.find(
        (img) => img.original_url === originalUrl && img.drive_url
      );
      if (existingStored) {
        if (!unit.drive_image_urls.includes(existingStored.drive_url)) {
          unit.drive_image_urls.push(existingStored.drive_url);
        }
        successCount++;
        continue;
      }

      try {
        const { buffer, mimeType, ext } = await downloadBufferWithRetry(originalUrl);
        const sha256 = computeSha256(buffer);

        // Kiểm tra xem có ảnh trùng sha256 đã tải lên trong căn này chưa
        const duplicateHash = unit.stored_images.find((img) => img.sha256 === sha256 && img.drive_url);
        if (duplicateHash) {
          if (!unit.drive_image_urls.includes(duplicateHash.drive_url)) {
            unit.drive_image_urls.push(duplicateHash.drive_url);
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
          description: `Ảnh căn ${unit.unit_code} - Dự án ${unit.project_name}`,
        });

        unit.drive_image_urls.push(uploaded.webViewLink);
        unit.stored_images.push({
          original_url: originalUrl,
          drive_file_id: uploaded.id,
          drive_url: uploaded.webViewLink,
          sha256,
          mime_type: mimeType,
          file_size: uploaded.size,
          image_type: 'UNIT',
          uploaded_at: new Date(),
        });
        successCount++;
      } catch (uploadErr) {
        failCount++;
        console.warn(`[ImageSync] ⚠️ Lỗi tải ảnh [${originalUrl}] của căn ${unit.unit_code}:`, uploadErr.message);
      }
    }

    if (successCount === urlsToSync.length) {
      unit.image_sync_status = 'SUCCESS';
    } else if (successCount > 0) {
      unit.image_sync_status = 'PARTIAL';
    } else {
      unit.image_sync_status = 'FAILED';
    }

    unit.image_synced_at = new Date();
    await unit.save();

    return {
      status: unit.image_sync_status,
      unit_code: unit.unit_code,
      successCount,
      failCount,
    };
  } catch (err) {
    unit.image_sync_status = 'FAILED';
    unit.image_synced_at = new Date();
    await unit.save();
    return { status: 'FAILED', unit_code: unit.unit_code, error: err.message };
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
 * @param {number|null} limitOverride - Số lượng căn tối đa cần xử lý trong phiên này
 */
async function syncPendingImages(limitOverride = null) {
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
  const batchSize = Number(limitOverride || process.env.IMAGE_SYNC_BATCH_SIZE || DEFAULT_BATCH_SIZE);
  const concurrency = Number(process.env.IMAGE_UPLOAD_CONCURRENCY || DEFAULT_CONCURRENCY);

  console.log(`\n====================================================================`);
  console.log(`📸 [IMAGE SYNC] BẮT ĐẦU ĐỒNG BỘ HÌNH ẢNH GOOGLE DRIVE - ${startedAt.toLocaleTimeString('vi-VN')}`);
  console.log(`  - Kích thước batch: ${batchSize} căn | Số luồng upload đồng thời: ${concurrency}`);
  console.log(`====================================================================`);

  try {
    // 1. Đồng bộ trước media các dự án SalePro (Cấp độ 1 & 2)
    const saleproProjects = await Project.find({
      source: 'salepro',
      $or: [
        { drive_project_image_urls: { $exists: false } },
        { drive_project_image_urls: { $size: 0 } },
      ],
    }).limit(10);

    for (const proj of saleproProjects) {
      await syncSaleProProjectMedia(proj);
    }

    // 2. Tìm danh sách căn cần đồng bộ ảnh:
    // Bao gồm cả những căn cũ chưa có drive_image_urls hoặc căn mới phát hiện
    const pendingUnits = await Unit.find({
      $or: [
        { image_sync_status: { $in: ['PENDING', 'PROCESSING', 'PARTIAL'] } },
        {
          image_urls: { $exists: true, $not: { $size: 0 } },
          $or: [{ drive_image_urls: { $exists: false } }, { drive_image_urls: { $size: 0 } }],
        },
      ],
    })
      .sort({ created_at: -1 })
      .limit(batchSize);

    if (pendingUnits.length === 0) {
      console.log('[ImageSync] ✨ Không còn căn nào đang chờ đồng bộ hình ảnh.');
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
  parseSaleProShareContent,
};
