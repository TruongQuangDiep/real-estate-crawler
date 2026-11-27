// Excel accepts at most 65,530 hyperlink objects per worksheet.
// Keep excess URLs as visible text, never drop the URL or emit an invalid file.
function limitHyperlinks(workbook, max = 60000) {
  const converted=[];
  for(const sheet of workbook.worksheets) {
    let count=0,plain=0;
    sheet.eachRow(row=>row.eachCell(cell=>{
      const v=cell.value;
      if(v && typeof v==='object' && v.hyperlink && ++count>max) {cell.value=v.hyperlink;plain++;}
    }));
    if(plain)converted.push(`${sheet.name}: ${plain} URL ở dạng văn bản`);
  }
  if(converted.length) {
    console.log(`[Excel] Giới hạn hyperlink: ${converted.join('; ')}. URL vẫn được giữ đầy đủ để sao chép.`);
    const notes=workbook.getWorksheet('Huong_dan_du_lieu');
    if(notes){const row=notes.addRow(['Giới hạn hyperlink Excel',`${converted.join('; ')}. Sao chép URL để mở nếu ô không còn hyperlink.`]);row.alignment={wrapText:true};row.height=45;}
  }
  return converted;
}
function urlsAsText(workbook) {
  let converted=0;
  for(const sheet of workbook.worksheets) sheet.eachRow(row=>row.eachCell(cell=>{
    const v=cell.value;
    if(v && typeof v==='object' && v.hyperlink) {cell.value=String(v.hyperlink);converted++;}
  }));
  return converted;
}
module.exports={limitHyperlinks,urlsAsText};
