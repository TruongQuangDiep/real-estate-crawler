const assert=require('assert/strict');
const ExcelJS=require('exceljs');
const {findDuplicateCandidates:find,addDuplicateSheet,codeKey}=require('../src/services/duplicateCandidates');
const base={source:'hisale',project_name:'Dự án 1',unit_code:'NĐ11-59',area_land:60,area_build:185.8};
const other={...base,source:'vhub'};
async function main(){
  assert.notEqual(codeKey('NĐ11-59'),codeKey('NĐ1-159'));
  assert.equal(find([base,{...other,unit_code:'NĐ1-159'}]).groups.length,0);
  assert.equal(find([base,{...other,project_name:'Dự án 2'}]).groups.length,0);
  assert.equal(find([base,{...other,project_name:'Dự án 1 giai đoạn 2'}]).groups.length,0);
  assert.equal(find([base,{...other,unit_code:'ND11–59'}]).groups.length,1);
  assert.equal(find([base,other]).groups[0].review,'Khớp thêm thông số');
  assert.match(find([base,{...other,area_land:80}]).groups[0].warnings,/Khác DT/);
  assert.match(find([{...base,building:'A'},{...other,building:'B'}]).groups[0].warnings,/Khác tòa/);
  assert.match(find([{...base,floor:'5'},{...other,floor:'6'}]).groups[0].warnings,/Khác tầng/);
  assert.doesNotMatch(find([{...base,floor:'05'},{...other,floor:'5'}]).groups[0].warnings,/Khác tầng/);
  assert.equal(find([{...base,area_land:0,area_build:0},{...other,area_land:0,area_build:0}]).groups[0].review,'Thiếu thông số đối chiếu');
  for(const code of ['A1/A2','A1 - A3','','UNKNOWN_123'])assert.equal(find([{...base,unit_code:code},{...other,unit_code:code}]).groups.length,0);
  assert.equal(find([{...base,project_name:''},{...other,project_name:''}]).groups.length,0);
  assert.equal(find([{...base,project_name:'THE PARKLAND - IMPERIA OCEAN CITY'},
    {...other,project_name:'IMPERIA OCEAN CITY - THE PARKLAND'}]).groups.length,1);
  const units=[{...base,_id:'a',price:1000000000,last_seen_at:new Date('2026-11-27T00:00:00Z')},
    {...other,_id:'b',listing_state:'missing',price:1}];
  const before=JSON.stringify(units),wb=new ExcelJS.Workbook();
  const result=addDuplicateSheet(wb,units,()=>({folder:'https://drive.google.com/drive/folders/test'}));
  assert.equal(JSON.stringify(units),before);assert.equal(result.records,2);
  const buffer=await wb.xlsx.writeBuffer(),loaded=new ExcelJS.Workbook();await loaded.xlsx.load(buffer);
  const ws=loaded.getWorksheet('Can_nghi_trung');
  assert.equal(ws.rowCount,10);assert.equal(ws.autoFilter,'A8:U10');
  assert.equal(ws.getCell('R9').value,2);assert.equal(ws.getCell('R10').value,3);
  assert.equal(ws.getCell('L10').value,'-');assert.equal(ws.getCell('N10').value,'Chưa thấy lại');
  assert.equal(ws.getCell('U9').value,'a');assert.equal(ws.getCell('U10').value,'b');
  assert.equal(ws.getCell('T9').value,'https://drive.google.com/drive/folders/test');
  console.log('Duplicate candidates: boundaries, project separation, conflicts, missing evidence and workbook roundtrip passed.');
}
main().catch(e=>{console.error(e);process.exit(1)});
