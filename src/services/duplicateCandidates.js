const { segment } = require('./unitFields');
const { reportPrices } = require('./reportPrices');

function text(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'D').toUpperCase().trim();
}
function projectKey(value) {
  // Whole tokens only: never merge different phases/numbers or parent/child projects.
  return text(value).replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).sort().join(' ');
}
function codeKey(value) {
  // Preserve separators and number boundaries: ND11-59 is NOT ND1-159.
  return text(value).replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, '');
}
function eligible(unit) {
  const code = codeKey(unit.unit_code), project = projectKey(unit.project_name);
  return project && code && /[0-9]/.test(code) && !/UNKNOWN|UNDEFINED|NULL|DANGCAPNHAT/.test(code) &&
    !/[,+;&/]|\s[-–—]\s/.test(String(unit.unit_code || ''));
}
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const numericFloor = value => /^\d+$/.test(text(value)) ? String(Number(value)) : text(value);

function reviewGroup(members) {
  const conflicts = new Set(), support = new Set();
  let incomplete = false;
  for (let i=0; i<members.length; i++) for (let j=i+1; j<members.length; j++) {
    const a=members[i].unit, b=members[j].unit;
    const pairSupport = new Set();
    for (const [key,label,norm] of [['building','tòa',text],['floor','tầng',numericFloor]]) {
      if (text(a[key]) && text(b[key])) {
        if (norm(a[key]) !== norm(b[key])) conflicts.add(`Khác ${label}`);
        else pairSupport.add(label);
      }
    }
    const sa=segment(a), sb=segment(b);
    if(sa && sb && sa!==sb) conflicts.add('Khác phân khúc cao/thấp tầng');
    for (const [key,label] of [['area_land','DT đất/thông thủy'],['area_build','DT XD/tim tường']]) {
      if(positive(a[key]) && positive(b[key])) {
        const delta=Math.abs(Number(a[key])-Number(b[key]));
        const tolerance=Math.max(0.1,0.002*Math.max(Number(a[key]),Number(b[key])));
        if(delta>tolerance) conflicts.add(`Khác ${label} (cần kiểm tra cách đo)`);
        else pairSupport.add(label);
      }
    }
    // A matching floor alone is not enough supporting evidence.
    if(![...pairSupport].some(v=>v!=='tầng')) incomplete=true;
    for(const value of pairSupport) support.add(value);
    if(text(a.subdivision) && text(b.subdivision) && text(a.subdivision)!==text(b.subdivision))
      conflicts.add('Tên phân khu khác nhau; có thể do cách đặt tên');
  }
  return { review: conflicts.size ? 'Có khác biệt cần xác minh' : incomplete ? 'Thiếu thông số đối chiếu' : 'Khớp thêm thông số',
    reason: 'Cùng nhóm tên dự án (chuẩn hóa dấu/ký tự, thứ tự từ) và cùng mã căn giữ dấu phân cách' +
      (support.size ? `. Khớp thêm: ${[...support].join(', ')}` : ''),
    warnings: [...conflicts].join('; ') || (incomplete ? 'Thiếu tòa/diện tích để đối chiếu đầy đủ' : 'Vẫn cần xác nhận trên nguồn trước khi gộp') };
}
function findDuplicateCandidates(units) {
  const buckets=new Map();let excluded=0;
  units.forEach((unit,index)=>{
    if(!eligible(unit)){excluded++;return;}
    const key=JSON.stringify([projectKey(unit.project_name),codeKey(unit.unit_code)]);
    if(!buckets.has(key))buckets.set(key,[]);
    buckets.get(key).push({unit,detailRow:index+2});
  });
  const groups=[...buckets.entries()].filter(([,members])=>members.length>1)
    .sort(([a],[b])=>a.localeCompare(b)).map(([key,members],index)=>({
      id:`NT${String(index+1).padStart(5,'0')}`,key,members,...reviewGroup(members),
      sources:[...new Set(members.map(m=>m.unit.source))].sort(),
    }));
  return {groups,excluded,records:groups.reduce((n,g)=>n+g.members.length,0)};
}
function addDuplicateSheet(workbook,units,lookupDrive) {
  const result=findDuplicateCandidates(units);
  const ws=workbook.addWorksheet('Can_nghi_trung',{properties:{tabColor:{argb:'FFD97706'}}});
  const columns=[
    ['Nhóm nghi trùng','group',14],['Kết quả đối chiếu','review',30],['Số dòng trong nhóm','size',16],
    ['Nguồn','source',14],['Dự án gốc','project',40],['Mã căn gốc','code',24],['Tòa','building',24],
    ['Tầng','floor',10],['Phân khu','subdivision',30],['DT đất/thông thủy (m²)','land',24],
    ['DT XD/tim tường (m²)','build',24],['Giá niêm yết (VNĐ)','price',24],['Trạng thái nguồn đã lưu','status',24],
    ['Quan sát','observation',28],['Lần cuối thấy (giờ VN)','seen',25],['Lý do đưa vào nhóm','reason',70],
    ['Khác biệt / lưu ý','warnings',85],['Dòng tại Chi_tiet_quy_can','detailRow',25],
    ['Link bảng giá nguồn','url',50],['Thư mục Drive căn','drive',50],['ID bản ghi CSDL','id',30],
  ];
  ws.columns=columns.map(([,key,width])=>({key,width}));
  ws.mergeCells('A1:Q1');ws.getCell('A1').value='CĂN NGHI TRÙNG — CẦN XÁC MINH TRƯỚC KHI GỘP';
  ws.getCell('A1').font={bold:true,size:14,color:{argb:'FF1E3A8A'}};
  const notes=[
    `Phạm vi: ${units.length} bản ghi tích lũy, gồm cả căn chưa thấy lại. ${result.groups.length} nhóm nghi trùng; ${result.records} dòng thuộc các nhóm. Đây chưa phải số căn trùng đã xác nhận.`,
    'Đối chiếu tên dự án theo các từ đầy đủ và mã căn giữ dấu phân cách. Không dùng mã căn riêng lẻ; không tự gộp tên gần giống, phân kỳ khác hoặc mã khác tiền tố.',
    'So thêm tòa, tầng, phân khúc và diện tích. Diện tích lệch tối đa 0,1 m² hoặc 0,2% được ghi nhận là gần khớp; khác biệt cách đo/phân khu phải kiểm tra lại. Giá khác nhau vẫn có thể là cùng căn.',
    `Có thể bỏ sót khi các sàn dùng tên dự án/mã căn khác nhau. ${result.excluded} dòng thiếu định danh phù hợp hoặc có dấu hiệu mã gộp bị loại khỏi đối chiếu. Không tự xóa dữ liệu hoặc trừ tổng số căn.`,
    'Các dòng cùng Nhóm nghi trùng được đặt cạnh nhau. Cột R chỉ vị trí bản ghi trong Chi_tiet_quy_can khi xuất file (vị trí thay đổi nếu sắp xếp lại); cột U giữ ID CSDL để truy vết.',
  ];
  notes.forEach((note,i)=>{const r=i+2;ws.mergeCells(`A${r}:Q${r}`);ws.getCell(r,1).value=note;ws.getCell(r,1).alignment={wrapText:true,vertical:'middle'};ws.getRow(r).height=30;});
  ws.getRow(8).values=columns.map(([header])=>header);
  ws.getRow(8).height=44;ws.getRow(8).font={bold:true,color:{argb:'FFFFFFFF'}};
  ws.getRow(8).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1E3A8A'}};
  ws.getRow(8).alignment={wrapText:true,vertical:'middle',horizontal:'center'};
  for(const group of result.groups) for(const {unit:u,detailRow} of group.members) {
    const row=ws.addRow({group:group.id,review:group.review,size:group.members.length,source:u.source,
      project:u.project_name,code:u.unit_code,building:u.building||'',floor:u.floor||'',subdivision:u.subdivision||'',
      land:positive(u.area_land)?Number(u.area_land):null,build:positive(u.area_build)?Number(u.area_build):null,
      price:reportPrices(u).price,status:u.status||'',
      observation:u.listing_state==='missing'?'Chưa thấy lại':u.last_seen_at?'Có mốc quan sát':'Chưa có mốc quan sát',
      seen:u.last_seen_at?new Date(new Date(u.last_seen_at).getTime()+7*3600000):null,
      reason:group.reason,warnings:group.warnings,detailRow,url:u.price_list_url||'',drive:lookupDrive?.(u)?.folder||'',id:String(u._id||''),
    });
    row.height=60;row.alignment={wrapText:true,vertical:'middle'};
    if(Number(group.id.slice(2))%2===0)for(let c=1;c<=columns.length;c++)
      row.getCell(c).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F4F6'}};
  }
  ws.getColumn('price').numFmt='#,##0';
  for(const key of ['land','build'])ws.getColumn(key).numFmt='#,##0.00';
  ws.getColumn('seen').numFmt='dd/mm/yyyy hh:mm:ss';
  // Introductory merged cells cross column A. Freezing that column clips them,
  // and freezing eight intro rows leaves too little room to inspect records.
  ws.autoFilter=`A8:U${Math.max(8,ws.rowCount)}`;ws.views=[{state:'normal'}];
  return result;
}
module.exports={projectKey,codeKey,findDuplicateCandidates,addDuplicateSheet};
