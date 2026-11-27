const {extractExtendedFields}=require('./unitFields');
// A report must distinguish an anomalous unverified API value from a confirmed price.
// Preserve raw values in MongoDB and the audit sheet; never infer a scale factor.
function reportPrices(unit) {
  const ext=extractExtendedFields(unit);
  const suspicious=typeof unit.price==='number' && unit.price>0 && unit.price<1000000;
  const total=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):'-';
  const checked=value=>suspicious&&typeof value==='number'&&value>0&&value<1000000?'-':value;
  return {
    ...ext,
    price:checked(total(unit.price)),
    priceTts:checked(total(unit.price_tts || unit.raw_data?.price_tts)),
    priceLoan:checked(ext.priceLoan),priceTttd:checked(ext.priceTttd),
    unitPrice:suspicious?'-':ext.unitPrice,
    qualityNote:suspicious?'Giá nguồn bất thường, chưa xác minh; xem Can_xac_minh_gia':'',
  };
}
module.exports={reportPrices};
