require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const Unit = require('../models/Unit');
const Project = require('../models/Project');
const { syncSaleProProjectMedia, syncPendingImages } = require('../services/imageStorageService');
const { withLock } = require('../services/lockService');

async function main() {
  await connectDB();
  const args = process.argv.slice(2);
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; console.log('Stopping after the current batch. Progress is saved.'); });
  const failedUnits = new Set();
  let projectFailures = 0, processed = 0;
  try {
    // Explicit retry is reset only once, not on every batch.
    if (args.includes('--retry-failed')) await Unit.updateMany(
      {image_sync_status:{$in:['FAILED','PARTIAL']}, image_sync_retries:{$gte:3}},
      {$set:{image_sync_retries:0}});
    const lock = await withLock('PROJECT_MEDIA_SYNC', async (_lease, lockStatus) => {
      const filter = {source:'salepro'};
      if (!args.includes('--refresh-projects')) filter.$or = [
        {media_schema_version:{$lt:3}},{media_schema_version:{$exists:false}},
        {media_synced_at:{$lt:new Date(Date.now()-7*86400000)}},
        {image_sync_status:{$in:['PENDING','PARTIAL','FAILED']}}
      ];
      const projects = await Project.find(filter).sort({apartment_count:-1});
      for (const project of projects) {
        if (stopping || lockStatus.isLost) throw new Error('Project synchronization interrupted or lock lost');
        const result = await syncSaleProProjectMedia(project);
        if (!['SUCCESS','NO_IMAGE'].includes(result?.status)) projectFailures++;
      }
    }, {ttlMs:30*60000});
    if (!lock.executed) throw new Error('Another project media sync is running.');
    if (args.includes('--refresh-files')) await Unit.updateMany(
      {listing_state:{$ne:'missing'}, image_sync_status:{$ne:'PROCESSING'}, $or:[{'image_urls.0':{$exists:true}},{'document_urls.0':{$exists:true}}]},
      {$set:{image_sync_status:'PENDING',image_sync_retries:0,media_force_refresh:true}});
    // All three sources, including documents-only units and individual SalePro units.
    while (!stopping) {
      const result = await syncPendingImages({source:'all'});
      if (result?.error) throw new Error(result.error);
      if (result?.enabled === false || result?.running) throw new Error(result.reason || 'Drive disabled or synchronization already running');
      for (const row of result.results || []) {
        const key = `${row.source}|${row.project_name}|${row.unit_code}`;
        if (['SUCCESS','NO_IMAGE'].includes(row.status)) failedUnits.delete(key);
        else failedUnits.add(key);
      }
      if (!result?.total) break;
      processed += result.total;
      console.log(`[Drive] ${processed} attempts; ${failedUnits.size} unresolved units in this run.`);
    }
    console.log(`[Drive] Finished: ${projectFailures} project failures, ${failedUnits.size} unresolved units. Export Excel to inspect remaining link/file statuses.`);
    if (stopping) process.exitCode = 130;
    else if (projectFailures || failedUnits.size) process.exitCode = 2;
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(async error => {console.error(error.message);process.exitCode=1;await mongoose.disconnect();});
module.exports={main};
