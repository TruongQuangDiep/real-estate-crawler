require('dotenv').config();
const mongoose=require('mongoose');
const {connectDB}=require('../db');
const Unit=require('../models/Unit');
const {folderUrl}=require('../services/driveLinks');
async function main() {
  await connectDB();
  const units=await Unit.find({drive_folder_id:{$nin:['',null]},$or:[{drive_folder_url:''},{drive_folder_url:null}]}).select('_id drive_folder_id').lean();
  if(units.length) await Unit.bulkWrite(units.map(u=>({updateOne:{filter:{_id:u._id,drive_folder_id:u.drive_folder_id},update:{$set:{drive_folder_url:folderUrl(u)}}}})));
  console.log(`Restored ${units.length} folder URLs from stored folder IDs. No folder created and no files uploaded. IDs are not live-verified by this repair.`);
  await mongoose.disconnect();
}
if(require.main===module) main().catch(async e=>{console.error(e.message);process.exitCode=1;await mongoose.disconnect();});
module.exports={main};
