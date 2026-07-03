const { Pool, neonConfig } = require('@neondatabase/serverless');
const { PrismaClient } = require('@prisma/client');
const { PrismaNeon } = require('@prisma/adapter-neon');

const url = process.env.DATABASE_URL;
console.log('DB init — DATABASE_URL set:', !!url, '| host:', url ? new URL(url).hostname : 'MISSING');

// In Node.js < 21, globalThis.WebSocket is not available — use the ws package
if (!globalThis.WebSocket) {
  neonConfig.webSocketConstructor = require('ws');
}

const pool = new Pool({ connectionString: url });
const adapter = new PrismaNeon(pool);
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
