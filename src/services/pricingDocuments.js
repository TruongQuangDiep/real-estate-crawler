const Unit = require('../models/Unit');
const PricingDocument = require('../models/PricingDocument');
const { getDriveClient, ensureFolder, uploadFile, verifyDriveItemExists } = require('./googleDriveService');
const { downloadBufferWithRetry } = require('./imageStorageService');
const keyOf = url => String(url).match(/(?:\/d\/|[?&]id=)([\w-]+)/)?.[1] || String(url).split('#')[0];
function candidates(unit) {
  const raw = unit.raw_data || {};
  return [...new Set([...(unit.document_urls || []), unit.price_list_url, raw.xSaleLinkFull, raw.xSaleLinkSummary]
    .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)))];
}
function isSpreadsheet(url) { return /docs\.google\.com\/spreadsheets\/d\/|\.xlsx?(?:$|[?#])/i.test(url); }
function codeChunks(codes) {
  const chunks = [''];
  for (const code of codes) {
    const last = chunks.length - 1, suffix = (chunks[last] ? ', ' : '') + code;
    if (chunks[last].length + suffix.length > 32000) chunks.push(String(code));
    else chunks[last] += suffix;
  }
  return chunks;
}
async function syncPricingDocuments({ concurrency = 4, retryFailed = false } = {}) {
  // Fail once for a disconnected account, rather than generating thousands of identical failures.
  const drive = getDriveClient();
  await drive.files.get({fileId:process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,fields:'id',supportsAllDrives:true});
  const units = await Unit.find({}).select('document_urls price_list_url raw_data.xSaleLinkFull raw_data.xSaleLinkSummary').lean();
  const unique = new Map();
  for (const unit of units) for (const url of candidates(unit)) if (isSpreadsheet(url)) unique.set(keyOf(url),url);
  const stored = await PricingDocument.find({}).lean();
  const done = new Map(stored.map(d=>[d.source_key,d]));
  const pending = [...unique].filter(([key])=>!done.has(key) || (retryFailed && done.get(key).status==='FAILED') || Date.now()-new Date(done.get(key).checked_at).getTime()>7*86400000);
  const folder = await ensureFolder('Bang_tinh_gia', process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID);
  let cursor=0, success=0, failed=0;
  async function worker() {
    while(cursor<pending.length) {
      const [key,url]=pending[cursor++];
      try {
        const previous=done.get(key);
        if(previous?.status==='SUCCESS' && await verifyDriveItemExists(previous.drive_file_id)) {
          await PricingDocument.updateOne({source_key:key},{$set:{checked_at:new Date()}});
          success++;continue;
        }
        const file=await downloadBufferWithRetry(url,1,{allowDriveDoc:true,allowDrivePdf:true});
        if(!/spreadsheet|excel/.test(file.mimeType)) throw new Error('Source did not return a spreadsheet file');
        const upload=await uploadFile({name:file.originalName || `Bang_tinh_gia_${key}.xlsx`,buffer:file.buffer,mimeType:file.mimeType,parentFolderId:folder.id});
        await PricingDocument.updateOne({source_key:key},{$set:{source_url:url,name:file.originalName || key,drive_file_id:upload.id,drive_url:upload.webViewLink,status:'SUCCESS',error:'',checked_at:new Date()}},{upsert:true});
        success++;
      } catch(error) {
        await PricingDocument.updateOne({source_key:key},{$set:{source_url:url,status:'FAILED',error:String(error.message).slice(0,600),checked_at:new Date()}},{upsert:true});
        failed++;
      }
      if((success+failed)%25===0) console.log(`[PricingDocuments] ${success+failed}/${pending.length}: ${success} saved, ${failed} failed`);
    }
  }
  await Promise.all(Array.from({length:Math.max(1,Math.min(8,concurrency))},worker));
  console.log(`[PricingDocuments] Complete: ${success} saved/verified, ${failed} failed; ${unique.size} unique source spreadsheets.`);
  return {success,failed,total:unique.size};
}
async function addDocumentSheet(workbook, units) {
  const stored=await PricingDocument.find({}).lean();
  const map=new Map(stored.map(d=>[d.source_key,d]));
  const archived = new Map(units.flatMap(u => u.stored_images || [])
    .filter(i => /spreadsheet|excel/.test(i.mime_type)).map(i => [keyOf(i.original_url), i]));
  const sheet=workbook.addWorksheet('Bang_tinh_gia_Drive');
  sheet.columns=[['Nguồn','source',14],['Dự án','project_name',40],['Mã căn','unit_code',24],['Link nguồn','source_url',65],['File nội bộ','drive_url',65],['Trạng thái','status',30],['Ghi chú','note',75]].map(([header,key,width])=>({header,key,width}));
  const groups = new Map();
  for (const u of units) for (const url of candidates(u).filter(x => isSpreadsheet(x) || map.has(keyOf(x)) || archived.has(keyOf(x)) || /drive\.google\.com\/.*folders\//i.test(x))) {
    const key = JSON.stringify([u.source, u.project_name, keyOf(url)]);
    if (!groups.has(key)) groups.set(key, { unit: u, url, codes: new Set() });
    groups.get(key).codes.add(u.unit_code);
  }
  for (const {unit:u,url,codes} of groups.values()) {
    const d=map.get(keyOf(url));
    const existing=archived.get(keyOf(url));
    for (const codesText of codeChunks(codes)) {
    const row = sheet.addRow({source:u.source,project_name:u.project_name,unit_code:codesText,source_url:{text:'Mở nguồn',hyperlink:url},
      drive_url:d?.status==='SUCCESS'?d.drive_url:existing?.drive_url||'',
      status:d?.status==='SUCCESS'||existing?'Đã sao lưu':d?.status==='FAILED'?'Lỗi truy cập/tải file':isSpreadsheet(url)?'Chờ sao lưu':'Thư mục; chưa xác minh hết file',note:d?.error||''});
    const link = row.getCell('drive_url').value;
    if (link) row.getCell('drive_url').value = {text:'Mở file nội bộ',hyperlink:link};
    row.height = 32;
    row.getCell('status').alignment = {wrapText:true,vertical:'middle'};
    row.getCell('project_name').alignment = {wrapText:true,vertical:'middle'};
    row.getCell('unit_code').alignment = {wrapText:true,vertical:'middle'};
    }
  }
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3A8A'}};
  sheet.getRow(1).height=32;
  sheet.autoFilter=`A1:G${sheet.rowCount}`;sheet.views=[{state:'frozen',ySplit:1}];
}
module.exports={syncPricingDocuments,addDocumentSheet,candidates,keyOf,isSpreadsheet};
