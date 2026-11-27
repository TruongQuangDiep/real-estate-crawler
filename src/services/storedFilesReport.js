function addStoredFilesSheet(workbook, units, lookupDrive) {
  const sheet=workbook.addWorksheet('Tep_noi_bo');
  sheet.columns=[['Nguồn','source',14],['Dự án','project_name',40],['Mã căn','unit_code',24],['Định dạng','mime',55],['Link nguồn','original',32],['File nội bộ','internal',32]].map(([header,key,width])=>({header,key,width}));
  for(const unit of units) {
    const seen=new Set();
    for(const file of unit.stored_images||[]) {
      const url=file.drive_url || (file.drive_file_id ? `https://drive.google.com/file/d/${file.drive_file_id}/view` : '');
      if(!url||seen.has(url))continue;seen.add(url);
      sheet.addRow({source:unit.source,project_name:unit.project_name,unit_code:unit.unit_code,mime:file.mime_type||'Chưa rõ',original:file.original_url||'',internal:{text:'Mở file nội bộ',hyperlink:url}});
    }
    for(const url of lookupDrive(unit).files) {
      if(seen.has(url))continue;seen.add(url);
      sheet.addRow({source:unit.source,project_name:unit.project_name,unit_code:unit.unit_code,mime:'Bản sao tài liệu/bảng tính đã lưu',internal:{text:'Mở file nội bộ',hyperlink:url}});
    }
  }
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).height=32;
  sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3A8A'}};
  sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter=`A1:F${sheet.rowCount}`;
  return sheet;
}
module.exports={addStoredFilesSheet};
