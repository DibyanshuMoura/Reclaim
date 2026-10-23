'use strict';

/**
 * Boots an in-memory MongoDB per test file so tests never touch real data.
 * Each file gets a fresh server, database, and module registry.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

async function startTestDb() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('reclaim_test');
  const { connectDb } = require('../../src/infrastructure/database/connect');
  await connectDb(process.env.MONGODB_URI);
  return mongod;
}

async function stopTestDb(mongod) {
  const { disconnectDb } = require('../../src/infrastructure/database/connect');
  try {
    await disconnectDb();
  } finally {
    // beforeAll may fail before the server is created; never crash on stop().
    if (mongod) await mongod.stop();
  }
}

module.exports = { startTestDb, stopTestDb };
