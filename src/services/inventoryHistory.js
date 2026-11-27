const { extractExtendedFields } = require('./unitFields');

const identity = u => JSON.stringify([u.source, u.project_name, u.unit_code]);
function snapshot(u) {
  const e = extractExtendedFields(u);
  return { price: u.price ?? 0, price_tts: u.price_tts ?? 0, price_loan: e.priceLoan,
    price_tttd: e.priceTttd, unit_price: e.unitPrice, status: u.status || '', listing_state: u.listing_state || 'active' };
}
function changes(before, after) {
  return Object.fromEntries(Object.keys(after).filter(k => before[k] !== after[k])
    .map(k => [k, { before: before[k], after: after[k] }]));
}
// Append the event in the same atomic update as the current price/status.
// Raw payloads and media are deliberately excluded from the event log.
async function trackedBulkWrite(Unit, ops, options = {}) {
  const updates = ops.filter(o => o.updateOne?.update?.$set?.raw_data);
  if (!updates.length) return Unit.bulkWrite(ops, options);
  const existing = await Unit.find({ $or: updates.map(o => o.updateOne.filter) })
    .select('source project_name unit_code price price_tts status raw_data tracking_started_at listing_state').lean();
  const old = new Map(existing.map(u => [identity(u), u]));
  const now = new Date();
  for (const op of updates) {
    const { filter, update } = op.updateOne;
    const previous = old.get(identity(filter));
    update.$set.listing_state = 'active';
    const next = { ...previous, ...filter, ...update.$set };
    const events = [];
    if (previous) {
      const delta = changes(snapshot(previous), snapshot(next));
      if (Object.keys(delta).length) events.push({ at: now, kind: 'CHANGED', changes: delta });
    } else {
      const initial = update.$setOnInsert?.is_notified === true;
      events.push({ at: now, kind: initial ? 'BASELINE' : 'NEW', changes: {}, current: snapshot(next) });
    }
    update.$set.last_seen_at = now;
    if (!previous?.tracking_started_at) update.$set.tracking_started_at = now;
    if (events.length) update.$push = { ...update.$push, change_history: { $each: events } };
    old.set(identity(filter), next);
  }
  return Unit.bulkWrite(ops, options);
}
// Call only after a complete successful scan of this exact source/project scope.
// Never label an absent listing as sold.
async function markMissing(Unit, scope, startedAt) {
  const query = { ...scope, listing_state: { $ne: 'missing' },
    $or: [{ last_seen_at: { $lt: startedAt } }, { last_seen_at: null }] };
  const missing = await Unit.find(query).select('_id').lean();
  if (!missing.length) return;
  const now = new Date();
  await Unit.bulkWrite(missing.map(u => ({ updateOne: { filter: { ...query, _id: u._id }, update: {
    $set: { listing_state: 'missing' }, $push: { change_history: { at: now, kind: 'CHANGED',
      changes: { listing_state: { before: 'active', after: 'missing' } } } },
  } } })), { ordered: false });
}
module.exports = { trackedBulkWrite, snapshot, changes, markMissing };
