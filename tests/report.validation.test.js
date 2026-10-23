'use strict';

const {
  parseLostReportCreate,
  parseFoundReportCreate,
  formatValidationError,
} = require('../src/modules/reports/report.validation');

const validLostReport = {
  itemName: 'Black backpack',
  description: 'Black backpack with a red front zipper pocket and two shoulder straps',
  colors: ['black', 'red'],
  brand: 'AdventureGear',
  incidentAt: '2026-10-20T18:30:00Z',
  venue: 'City Concert Hall',
  contactEmail: 'loser@example.com',
};

describe('lost report validation', () => {
  it('accepts a fully populated lost report', () => {
    const result = parseLostReportCreate(validLostReport);
    expect(result.success).toBe(true);
    expect(result.data.contactEmail).toBe('loser@example.com');
    expect(result.data.itemName).toBe('Black backpack');
  });

  it('reports every missing required field', () => {
    const result = parseLostReportCreate({});
    expect(result.success).toBe(false);
    const { details } = formatValidationError(result.error);
    const fields = details.map((d) => d.field);
    expect(fields).toContain('itemName');
    expect(fields).toContain('description');
    expect(fields).toContain('contactEmail');
  });

  it('requires a description of at least ten characters', () => {
    const result = parseLostReportCreate({
      ...validLostReport,
      description: 'short',
    });
    expect(result.success).toBe(false);
    const { details } = formatValidationError(result.error);
    expect(details.some((d) => d.field === 'description')).toBe(true);
  });

  it('rejects unknown fields (strict schemas)', () => {
    const result = parseLostReportCreate({
      ...validLostReport,
      category: 'backpack',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a future incidentAt', () => {
    const result = parseLostReportCreate({
      ...validLostReport,
      incidentAt: '9999-01-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed emails and normalizes casing', () => {
    const bad = parseLostReportCreate({
      ...validLostReport,
      contactEmail: 'not-an-email',
    });
    expect(bad.success).toBe(false);

    const good = parseLostReportCreate({
      ...validLostReport,
      contactEmail: '  LOSER@Example.COM ',
    });
    expect(good.success).toBe(true);
    expect(good.data.contactEmail).toBe('loser@example.com');
  });

  it('normalizes whitespace-only optional text to undefined', () => {
    const result = parseLostReportCreate({
      ...validLostReport,
      venue: '   ',
      brand: '',
    });
    expect(result.success).toBe(true);
    expect(result.data.venue).toBeUndefined();
    expect(result.data.brand).toBeUndefined();
  });

  it('bounds colors arrays and trims color strings', () => {
    const tooMany = parseLostReportCreate({
      ...validLostReport,
      colors: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(tooMany.success).toBe(false);

    const trimmed = parseLostReportCreate({
      ...validLostReport,
      colors: ['  black  ', 'red'],
    });
    expect(trimmed.success).toBe(true);
    expect(trimmed.data.colors).toEqual(['black', 'red']);

    const empty = parseLostReportCreate({
      ...validLostReport,
      colors: [],
    });
    expect(empty.success).toBe(true);
    expect(empty.data.colors).toBeUndefined();
  });
});

describe('found report validation', () => {
  it('accepts the minimal flow: only a contact email', () => {
    const result = parseFoundReportCreate({ contactEmail: 'finder@example.com' });
    expect(result.success).toBe(true);
    expect(result.data.analysisStatus).toBeUndefined();
    expect(result.data.description).toBeUndefined();
  });

  it('rejects finder-side attribute fields that Phase 2 found flow does not take', () => {
    const result = parseFoundReportCreate({
      contactEmail: 'finder@example.com',
      itemName: 'Wallet',
      colors: ['brown'],
      brand: 'UnknownBrand',
    });
    expect(result.success).toBe(false);
  });

  it('rejects future incidentAt on found reports', () => {
    const result = parseFoundReportCreate({
      contactEmail: 'finder@example.com',
      incidentAt: '9999-01-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});
