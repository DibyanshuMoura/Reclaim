'use strict';

// The stricter report-create limiter must be tiny for this file; it is read
// when the app is created below, so this override must run first.
process.env.REPORT_RATE_LIMIT_MAX = '3';
process.env.RATE_LIMIT_MAX = '500';

const request = require('supertest');
const { startTestDb, stopTestDb } = require('./helpers/db');
const { createTestImage } = require('./helpers/images');

let mongod;
let app;

beforeAll(async () => {
  mongod = await startTestDb();
  app = require('../src/app').createApp();
}, 120000);

afterAll(async () => {
  await stopTestDb(mongod);
});

describe('public endpoint rate limiting', () => {
  it('enforces the configurable per-IP limit on report creation', async () => {
    const image = await createTestImage();
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(app)
        .post('/api/v1/reports/found')
        .field('contactEmail', `finder${i}@example.com`)
        .attach('image', image, { filename: `photo${i}.png`, contentType: 'image/png' });
      expect(ok.status).toBe(201);
    }

    const limited = await request(app)
      .post('/api/v1/reports/found')
      .field('contactEmail', 'fourth@example.com')
      .attach('image', image, { filename: 'photo4.png', contentType: 'image/png' });

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});
