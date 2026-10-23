'use strict';

const request = require('supertest');
const { startTestDb, stopTestDb } = require('./helpers/db');

let mongod;
let app;

beforeAll(async () => {
  mongod = await startTestDb();
  app = require('../src/app').createApp();
}, 120000);

afterAll(async () => {
  await stopTestDb(mongod);
});

const TOKEN = 'A'.repeat(43);

describe('web frontend routes', () => {
  it('serves the landing page with navbar CTAs and product content', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // The two CTAs travel on every page via the primary nav.
    expect(res.text).toContain('data-nav="lost"');
    expect(res.text).toContain('data-nav="found"');
    expect(res.text).toContain('href="/lost"');
    expect(res.text).toContain('href="/found"');
    // The landing is the product story; report flows are separate pages.
    expect(res.text).toContain('hero-hit');
    expect(res.text).toContain('Three steps, all private by default');
    expect(res.text).not.toContain('I lost an item');
  });

  it('serves the lost and found form pages', async () => {
    const lost = await request(app).get('/lost').expect(200);
    expect(lost.text).toContain('Lost an item');
    expect(lost.text).toContain('contactEmail');
    const found = await request(app).get('/found').expect(200);
    expect(found.text).toContain('type="file"');
  });

  it('serves token page shells WITHOUT embedding the token in markup', async () => {
    for (const path of [`/report/${TOKEN}`, `/match/${TOKEN}`]) {
      const res = await request(app).get(path).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).not.toContain(TOKEN);
      // The shell must read the token client-side from the location bar.
      expect(res.text).toContain('js');
    }
  });

  it('sends security headers and no-store on HTML responses', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('serves shared frontend assets', async () => {
    const css = await request(app).get('/css/styles.css').expect(200);
    expect(css.text).toContain('--');
    const js = await request(app).get('/js/common.js').expect(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
  });

  it('still returns JSON 404s for unknown paths', async () => {
    const res = await request(app).get('/definitely-not-a-page').expect(404);
    expect(res.body).toHaveProperty('error');
  });

  it('keeps API endpoints unaffected by the web router', async () => {
    await request(app).get('/api/v1/health').expect(async (res) => {
      expect([200, 503]).toContain(res.status);
    });
  });
});
