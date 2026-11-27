// Shared source semantics for manual, daily and weekly exports.
const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim().replace(/\s/g, '').replace(/,/g, '.');
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
function field(raw, keys, shown = false) {
  for (const key of keys) { const n = number(raw[key]); if (n > 0) return n; }
  return shown || keys.some(k => owns(raw, k)) ? '-' : '';
}
function segment(unit) {
  const r = unit.raw_data || {};
  const type = r.project_type || r.productType || r.project?.typeName || '';
  if (/high_rise|cao_tang|cao tầng/i.test(type)) return 'high_rise';
  if (/low_rise|thap_tang|thấp tầng/i.test(type)) return 'low_rise';
  if (/liền kề|song lập|đơn lập|shophouse|tmdv|tứ lập|villa|townhouse|^shop$/i.test(unit.unit_type || '')) return 'low_rise';
  if (/phòng ngủ|pn|studio|duplex|penthouse/i.test(unit.unit_type || '')) return 'high_rise';
  return '';
}
function extractExtendedFields(unit) {
  const source = (unit.source || '').toLowerCase(), raw = unit.raw_data || {};
  const high = segment(unit) === 'high_rise';
  const axisKey = source === 'salepro' ? 'apartment_axis_code' : source === 'vhub' ? 'apartmentAxisCode' : 'axis';
  const code = raw[axisKey];
  const result = {
    axis: code != null && String(code).trim() ? String(code).trim() : (high && owns(raw, axisKey) ? '-' : ''),
    frontWidth: source === 'vhub' && segment(unit) === 'low_rise' ? field(raw, ['frontWidth', 'frontageWidth'], true) : '',
    priceLoan: source === 'hisale' ? field(raw, ['price_loan'], true) : source === 'vhub' ? field(raw, ['loanPrice']) : field(raw, high ? ['loan_price', 'apartment_price'] : ['loan_price']),
    priceTttd: source === 'hisale' ? field(raw, ['price_tttd'], true) : source === 'vhub' ? field(raw, ['progressPaymentPrice', 'priceTttd']) : field(raw, ['progress_payment_price', 'price_tttd'], high),
    unitPrice: source === 'vhub' ? field(raw, ['pricePerMeter', 'pricePerSqm']) : source === 'salepro' ? field(raw, ['price_per_meter']) : '-',
    hisaleQuyCan: '', hisaleQuyHot: '', hisaleQuyCdt: '',
    vhubQuyDocQuyen: '', vhubQuyChung: '', vhubQuyCheo: '',
    saleproQuyDocQuyenAn: '', saleproQuyCheo: '', saleproQuyThuong: '',
  };
  if (source === 'hisale') {
    for (const k of ['priceAveFull', 'priceAve']) {
      const match = String(raw[k] || '').match(/([\d]+(?:[.,]\d+)?)\s*(?:triệu|tr)(?:\b|\/)/i);
      if (match && number(match[1]) > 0) { result.unitPrice = number(match[1]) * 1e6; break; }
    }
    const name = String(raw.fundTypeName || '').toLowerCase();
    const fund = /hot/.test(name) ? 2 : /cđt|cdt/.test(name) ? 3 : /quỹ căn/.test(name) ? 1 : Number(raw.fund_type);
    ['hisaleQuyCan', 'hisaleQuyHot', 'hisaleQuyCdt'].forEach((k, i) => { result[k] = [1, 2, 3].includes(fund) ? (fund === i + 1 ? 'Yes' : 'No') : '-'; });
  }
  if (source === 'vhub') {
    const name = String(raw.fundGroupsSellName || raw.fundGroup || '').toLowerCase();
    const fund = /độc quyền|doc quyen/.test(name) ? 0 : /chung|qck/.test(name) ? 1 : /chéo|cheo/.test(name) ? 2 : -1;
    ['vhubQuyDocQuyen', 'vhubQuyChung', 'vhubQuyCheo'].forEach((k, i) => { result[k] = fund < 0 ? '-' : fund === i ? 'Yes' : 'No'; });
  }
  if (source === 'salepro') {
    // SalePro's useFundGroupMerge: QMH expands to QĐQ/QCK/QA;
    // QC is cross inventory; QTH/QV are reward inventory (Quỹ thưởng).
    const code=String(raw.fund_groups_sell_code_original || raw.fund_groups_sell_code || raw._fund_group_code || '').trim().toUpperCase();
    const group=['QA','QĐQ','QCK','QMH'].includes(code)?0:code==='QC'?1:['QTH','QV'].includes(code)?2:-1;
    ['saleproQuyDocQuyenAn','saleproQuyCheo','saleproQuyThuong'].forEach((key,i)=>{result[key]=group<0?'-':group===i?'Yes':'No';});
  }
  if (typeof result.unitPrice === 'number' && result.unitPrice >= 1) result.unitPrice = Math.round(result.unitPrice);
  return result;
}
module.exports = { extractExtendedFields, segment, field };
