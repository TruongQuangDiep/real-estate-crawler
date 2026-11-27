require('dotenv').config();
const mongoose=require('mongoose');
const {connectDB}=require('../db');
const {withLock}=require('../services/lockService');
const {syncPricingDocuments}=require('../services/pricingDocuments');
(async()=>{await connectDB();await withLock('PRICING_DOCUMENT_SYNC', () => syncPricingDocuments({retryFailed:process.argv.includes('--retry-failed'),refresh:process.argv.includes('--refresh')}));await mongoose.disconnect();})().catch(error=>{console.error(error.message);process.exit(1);});
