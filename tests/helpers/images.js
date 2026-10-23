'use strict';

const sharp = require('sharp');

/** Creates a small real image buffer for multipart upload tests. */
async function createTestImage({ width = 64, height = 64, r = 0, g = 180, b = 0 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 70 })
    .toBuffer();
}

module.exports = { createTestImage };
