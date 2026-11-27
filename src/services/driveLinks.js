function folderUrl(item) {
  if (item.drive_folder_url) return item.drive_folder_url;
  return item.drive_folder_id ? `https://drive.google.com/drive/folders/${item.drive_folder_id}` : '';
}
function resolveDriveLinks(unit, project) {
  const own = folderUrl(unit), shared = project ? folderUrl(project) : '';
  const files = [...new Set((unit.stored_images || []).map(f => f.drive_url || (f.drive_file_id ? `https://drive.google.com/file/d/${f.drive_file_id}/view` : '')).filter(Boolean))];
  const hasSources = (unit.image_urls || []).length || (unit.document_urls || []).length || /drive\.google\.com|docs\.google\.com/i.test(unit.price_list_url || '');
  const error = unit.image_sync_error || '';
  const status = own ? (error ? 'Có thư mục; còn lỗi tải file' : `Có thư mục; ${unit.image_sync_status || 'chưa rõ trạng thái file'}`)
    : files.length ? 'Có file nội bộ; chưa có link thư mục căn'
    : shared ? 'Chỉ có thư mục dự án dùng chung'
    : error ? 'Lỗi đồng bộ; xem ghi chú'
    : hasSources ? 'Chưa đồng bộ hoặc chưa lấy được file nguồn' : 'Nguồn chưa có ảnh/file để lưu';
  return {folder:own,projectFolder:shared,files,status,error};
}
function buildDriveIndex(projects = [], documents = []) {
  const byId=new Map(projects.map(p=>[`${p.source}|${p.project_id}`,p]));
  const byName=new Map(projects.map(p=>[`${p.source}|${p.project_name}`,p]));
  const key=url=>String(url).match(/(?:\/d\/|[?&]id=)([\w-]+)/)?.[1] || String(url).split('#')[0];
  const saved=new Map(documents.filter(d=>d.drive_url).map(d=>[d.source_key,d]));
  return unit => {
    const links=resolveDriveLinks(unit,byId.get(`${unit.source}|${unit.project_id}`)||byName.get(`${unit.source}|${unit.project_name}`));
    const raw=unit.raw_data||{};
    for(const url of [...(unit.document_urls||[]),unit.price_list_url,raw.xSaleLinkFull,raw.xSaleLinkSummary].filter(Boolean)) {
      const document=saved.get(key(url));
      const internal=document?.drive_url;
      if(internal&&!links.files.includes(internal))links.files.push(internal);
      if(document?.status==='FAILED') links.error=[links.error,document.error || 'Lần tải mới của file bị lỗi; đang giữ bản sao trước'].filter(Boolean).join('; ');
    }
    if(!links.folder&&links.files.length)links.status=links.error?'Có bản lưu nội bộ; lần đồng bộ mới có lỗi':'Có file nội bộ; chưa có thư mục riêng của căn';
    return links;
  };
}
module.exports={folderUrl,resolveDriveLinks,buildDriveIndex};
