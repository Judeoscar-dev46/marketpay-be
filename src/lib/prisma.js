const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const url = process.env.DATABASE_URL;
console.log('DB init — DATABASE_URL set:', !!url, '| host:', url ? new URL(url).hostname : 'MISSING');

const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
