const { neon } = require('@neondatabase/serverless');
const { PrismaClient } = require('@prisma/client');
const { PrismaNeon } = require('@prisma/adapter-neon');

const url = process.env.DATABASE_URL;
console.log('DB init — DATABASE_URL set:', !!url, '| host:', url ? new URL(url).hostname : 'MISSING');

const sql = neon(url);
const adapter = new PrismaNeon(sql);
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
