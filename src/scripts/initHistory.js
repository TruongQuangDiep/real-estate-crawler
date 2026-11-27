require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const Unit = require('../models/Unit');
(async () => {
  await connectDB();
  const result = await Unit.updateMany({ $or: [{ tracking_started_at: null }, { tracking_started_at: { $exists: false } }] },
    { $set: { tracking_started_at: new Date() } });
  console.log(`History baseline initialized for ${result.modifiedCount} existing units. No past events inferred.`);
  await mongoose.disconnect();
})().catch(error => { console.error(error.message); process.exit(1); });
