'use strict';

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

const validLostReport = {
  itemName: 'Black backpack',
  description: 'Black backpack with a red front zipper pocket and two shoulder straps',
  colors: ['black', 'red'],
  brand: 'AdventureGear',
  venue: 'City Concert Hall',
  contactEmail: 'loser@example.com',
};

describe('POST /api/v1/reports/lost', () => {
  it('creates a lost report and returns a one-time access token', async () => {
    const res = await request(app).post('/api/v1/reports/lost').send(validLostReport);

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.privateReportPath).toBe(
      `/api/v1/private/reports/${res.body.accessToken}`
    );
    expect(res.body.report.status).toBe('open');
    expect(res.body.report.analysisStatus).toBe('not_required');
    expect(res.body.report.itemName).toBe('Black backpack');
    expect(res.body.report).not.toHaveProperty('contactEmail');
    // The response never includes the stored token hash.
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');
    expect(JSON.stringify(res.body)).not.toContain('loser@example.com');
  });

  it('rejects invalid lost reports without persisting them', async () => {
    const Report = require('../src/modules/reports/report.model');
    const before = await Report.countDocuments();

    const res = await request(app)
      .post('/api/v1/reports/lost')
      .send({ itemName: 'Backpack', description: 'tiny', contactEmail: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toContain('description');
    expect(fields).toContain('contactEmail');

    const after = await Report.countDocuments();
    expect(after).toBe(before);
  });

  it('rejects unknown fields strictly', async () => {
    const res = await request(app)
      .post('/api/v1/reports/lost')
      .send({ ...validLostReport, category: 'backpack' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects future incident times', async () => {
    const res = await request(app)
      .post('/api/v1/reports/lost')
      .send({ ...validLostReport, incidentAt: '9999-01-01T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'incidentAt')).toBe(true);
  });
});

describe('POST /api/v1/reports/found', () => {
  it('creates a found report awaiting analysis with a photo', async () => {
    const res = await request(app)
      .post('/api/v1/reports/found')
      .field('venue', 'Downtown Mall')
      .field('contactEmail', 'finder@example.com')
      .attach('image', await createTestImage(), { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.report.status).toBe('open');
    // Awaiting the analysis worker.
    expect(res.body.report.analysisStatus).toBe('pending');
  });

  it('rejects found reports without a photo', async () => {
    const res = await request(app)
      .post('/api/v1/reports/found')
      .send({ venue: 'Downtown Mall', contactEmail: 'finder@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d) => d.field === 'image')).toBe(true);
  });

  it('rejects future incident times', async () => {
    const res = await request(app)
      .post('/api/v1/reports/found')
      .field('contactEmail', 'finder@example.com')
      .field('incidentAt', '9999-01-01T00:00:00Z')
      .attach('image', await createTestImage(), { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/private/reports/:token', () => {
  it('returns the private report including contact details for the token owner', async () => {
    const created = await request(app).post('/api/v1/reports/lost').send(validLostReport);
    const token = created.body.accessToken;

    const res = await request(app).get(`/api/v1/private/reports/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.report.contactEmail).toBe('loser@example.com');
    expect(res.body.report.itemName).toBe('Black backpack');
  });

  it('responds 404 for unknown but well-formed tokens', async () => {
    const res = await request(app).get(`/api/v1/private/reports/${'b'.repeat(43)}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Report not found');
  });

  it('responds 404 without leaking existence for malformed tokens', async () => {
    const res = await request(app).get('/api/v1/private/reports/too-short');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Report not found');
  });
});

describe('report id exposure policy', () => {
  // AGENT.md §10: do not expose contact info through enumerable report IDs.
  // There is intentionally no public GET /reports/:id endpoint.
  it('has no enumerable public report lookup', async () => {
    const res = await request(app).get('/api/v1/reports/anything');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/v1/health', () => {
  it('reports connected state and applies security headers', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'connected' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('request body handling', () => {
  it('rejects malformed JSON without echoing the payload', async () => {
    const res = await request(app)
      .post('/api/v1/reports/lost')
      .set('Content-Type', 'application/json')
      .send('{"itemName":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(app)
      .post('/api/v1/reports/lost')
      .set('Content-Type', 'application/json')
      .send(`{"pad":"${'x'.repeat(40 * 1024)}"}`);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
