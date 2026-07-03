const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const url = process.env.DATABASE_URL;
console.log('DB init — DATABASE_URL set:', !!url, '| host:', url ? new URL(url).hostname : 'MISSING');

const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
