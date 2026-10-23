'use strict';

const mongoose = require('mongoose');
const os = require('os');

/**
 * MongoDB connection handling. The application layer never talks to the
 * driver directly (AGENT.md §4).
 *
 * `runtimeAdapters` is passed explicitly: the MongoDB driver resolves its os
 * adapter via dynamic import(), which fails inside Jest's CommonJS module
 * sandbox; a failed adapter load is silently swallowed by the driver and the
 * handshake is then rejected by the server ("missing 'driver' metadata").
 * Supplying the adapter directly is the driver's supported customization
 * point for such environments and is identical to the default adapter.
 */
async function connectDb(uri) {
  return mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
    runtimeAdapters: { os },
  });
}

async function disconnectDb() {
  await mongoose.disconnect();
}

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connectDb, disconnectDb, isDbConnected };
