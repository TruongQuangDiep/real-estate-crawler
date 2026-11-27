const assert=require('assert/strict');
const mongoose=require('mongoose');
const {buildDriveIndex,resolveDriveLinks}=require('../src/services/driveLinks');
const {isDocumentUrl}=require('../src/services/fileFormats');
// External APIs are mocked. No requests, uploads or company data changes occur.
const drive=require('../src/services/googleDriveService');
const axios=require('axios');
let uploads=[],csv='a,b\n1,2\n';
drive.isDriveConfigured=()=>({enabled:true});
drive.verifyDriveItemExists=async()=>true;
drive.ensureFolderPath=async()=>({id:'test-folder',webViewLink:'https://drive.google.com/drive/folders/test-folder'});
drive.uploadFile=async file=>{uploads.push(file);return {id:`saved-${uploads.length}`,webViewLink:`https://drive.google.com/file/d/saved-${uploads.length}/view`,size:file.buffer.length};};
drive.getDriveClient=()=>({files:{
  list:async p=>{if(p.q.includes('blocked-folder'))throw new Error('403 test access denied');return {data:{files:[]}};},
  get:async p=>p.alt==='media'?{data:Buffer.from('504b030400000000','hex')}:{data:{id:p.fileId,name:'Plan.pptx',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'}},
  export:async()=>({data:Buffer.from('504b030400000000','hex')}),
}});
axios.get=async url=>({data:url.endsWith('.csv')?Buffer.from(csv):url.endsWith('.zip')?Buffer.from('504b030400000000','hex'):Buffer.from('89504e470d0a1a0a','hex'),headers:{'content-type':url.endsWith('.csv')?'text/csv':url.endsWith('.zip')?'application/zip':'image/png'}});
const {detectBufferFormat,syncPendingImages}=require('../src/services/imageStorageService');
const Unit=require('../src/models/Unit');
async function main(){
  assert.equal(isDocumentUrl('https://example.com/a.PPTX?download=1'),true);
  const zip=Buffer.from('504b030400000000','hex');
  assert.equal(detectBufferFormat(zip,'application/zip','a.zip',{allowDocuments:true}).ext,'zip');
  assert.equal(detectBufferFormat(zip,'application/vnd.openxmlformats-officedocument.presentationml.presentation','a.pptx',{allowDocuments:true}).ext,'pptx');
  assert.equal(detectBufferFormat(Buffer.from('d0cf11e0a1b11ae','hex'),'application/vnd.ms-excel','a.xls',{allowDocuments:true}).ext,'xls');
  assert.equal(detectBufferFormat(Buffer.from('x'),'text/plain','a.txt',{allowDocuments:true}).ext,'txt');
  assert.equal(detectBufferFormat(Buffer.from('{"a":1}'),'application/json','a.json',{allowDocuments:true}).ext,'json');
  assert.throws(()=>detectBufferFormat(Buffer.from('<html>login</html>'),'text/html','a.xlsx',{allowDocuments:true}),/HTML/);
  const lookup=buildDriveIndex([{source:'hisale',project_id:1,drive_folder_id:'project-folder'}],[{source_key:'sheet-id',status:'SUCCESS',drive_url:'https://drive.google.com/file/d/internal/view'}]);
  const shared=lookup({source:'hisale',project_id:1,document_urls:['https://docs.google.com/spreadsheets/d/sheet-id/edit']});
  assert.equal(shared.folder,'');assert.equal(shared.projectFolder,'https://drive.google.com/drive/folders/project-folder');assert.equal(shared.files.length,1);
  assert.equal(resolveDriveLinks({drive_folder_id:'known'}).folder,'https://drive.google.com/drive/folders/known');
  assert.equal(resolveDriveLinks({image_sync_status:'PROCESSING',image_sync_locked_until:new Date(0)}).status,'Chưa hoàn tất: phiên đồng bộ hết hạn');
  const retained=buildDriveIndex([],[{source_key:'sheet-id',status:'FAILED',drive_url:'https://drive.google.com/file/d/old-copy/view',error:'403'}])({document_urls:['https://docs.google.com/spreadsheets/d/sheet-id/edit']});
  assert.equal(retained.files.length,1);assert.equal(retained.error,'403');
  const dbName=`crawler_media_test_${process.pid}`;
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`,{serverSelectionTimeoutMS:5000});
  assert.equal(mongoose.connection.name,dbName);
  try{
    const make=(code,extra)=>Unit.create({source:'hisale',project_name:'MEDIA_TEST',unit_code:code,image_sync_status:'NO_IMAGE',...extra});
    const a=await make('CSV',{document_urls:['https://static.hisale.vn/test/data.csv']});
    const b=await make('PNG',{image_urls:['https://static.hisale.vn/test/photo.png']});
    const c=await make('FOLDER',{document_urls:['https://drive.google.com/drive/folders/empty-folder']});
    const d=await make('PPT',{image_urls:['https://drive.google.com/file/d/ppt-source/view']});
    const e=await make('ZIP',{document_urls:['https://static.hisale.vn/test/archive.zip']});
    const result=await syncPendingImages({limit:10});assert.equal(result.total,5);
    const saved=await Unit.findById(a._id).lean();assert.equal(saved.stored_images[0].mime_type,'text/csv');assert.ok(saved.drive_folder_url);
    assert.equal((await Unit.findById(b._id)).image_sync_status,'SUCCESS');
    assert.equal((await Unit.findById(c._id)).image_sync_status,'NO_IMAGE');
    const ppt=await Unit.findById(d._id).lean();assert.equal(ppt.image_urls.length,0);assert.ok(ppt.stored_images[0].mime_type.includes('presentationml'));assert.equal(ppt.image_sync_status,'SUCCESS');
    assert.equal((await Unit.findById(e._id)).stored_images[0].mime_type,'application/zip');
    const ExcelJS=require('exceljs');
    const {addStoredFilesSheet}=require('../src/services/storedFilesReport');
    const filesBook=new ExcelJS.Workbook();
    const filesSheet=addStoredFilesSheet(filesBook,await Unit.find({}).lean(),buildDriveIndex());
    assert.ok(filesSheet.rowCount>=5);assert.equal(filesSheet.autoFilter,`A1:F${filesSheet.rowCount}`);
    const {limitHyperlinks}=require('../src/services/excelLinks');
    const cappedBook=new ExcelJS.Workbook();const capped=cappedBook.addWorksheet('Test');
    capped.addRow([{text:'One',hyperlink:'https://example.com/1'},{text:'Two',hyperlink:'https://example.com/2'}]);
    assert.equal(limitHyperlinks(cappedBook,1).length,1);assert.equal(capped.getCell('B1').value,'https://example.com/2');
    assert.equal((await syncPendingImages({limit:10})).total,0,'Completed and empty-folder sources must not loop forever');
    csv='a,b\n3,4\n';const before=uploads.length;
    await Unit.updateOne({_id:a._id},{$set:{media_force_refresh:true,image_sync_status:'PENDING'}});
    await syncPendingImages({limit:10});assert.equal(uploads.length,before+1,'Force refresh must capture changed bytes at the same URL');
    await make('BLOCKED',{document_urls:['https://drive.google.com/drive/folders/blocked-folder']});
    for(let i=0;i<3;i++)await syncPendingImages({limit:10});
    assert.equal((await syncPendingImages({limit:10})).total,0,'Access failures must stop after the retry budget');
    console.log('Media workflow passed: diverse formats, original extensions, Drive link fallbacks, documents-only queue, no infinite retries, and changed-file refresh.');
  }finally{assert.equal(mongoose.connection.name,dbName);await mongoose.connection.dropDatabase();await mongoose.disconnect();}
}
main().catch(e=>{console.error(e);process.exit(1);});
