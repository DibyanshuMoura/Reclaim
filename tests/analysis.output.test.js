'use strict';

const { parseAnalysisOutput } = require('../src/modules/image-analysis/analysis.output');

describe('analysis output parsing', () => {
  it('accepts the full contract shape and strips extra model fields', () => {
    const { ok, attributes } = parseAnalysisOutput({
      category: 'backpack',
      itemType: 'backpack',
      primaryColor: 'black',
      secondaryColors: ['red'],
      brand: null,
      visibleFeatures: ['front zipper pocket', 'two shoulder straps'],
      condition: 'unknown',
      uncertainAttributes: [],
      inventedBrand: 'FakeBrand',
      serialNumber: 'SN-1',
    });

    expect(ok).toBe(true);
    expect(attributes.category).toBe('backpack');
    expect(attributes.brand).toBeNull();
    expect(attributes.condition).toBeNull(); // 'unknown' normalizes to null
    expect(attributes.analysisVersion).toBe('1');
    expect(attributes).not.toHaveProperty('inventedBrand');
    expect(attributes).not.toHaveProperty('serialNumber');
  });

  it('normalizes empty/unknown values to null and lowercases colors', () => {
    const { ok, attributes } = parseAnalysisOutput({
      category: '  UNKNOWN  ',
      primaryColor: 'Green',
      secondaryColors: ['Red', 'red', 'BLUE', '', 'n/a'],
      brand: '',
      visibleFeatures: ['Zip pocket', ''],
    });

    expect(ok).toBe(true);
    expect(attributes.category).toBeNull();
    expect(attributes.primaryColor).toBe('green');
    expect(attributes.secondaryColors).toEqual(['red', 'blue']);
    expect(attributes.brand).toBeNull();
    expect(attributes.visibleFeatures).toEqual(['Zip pocket']);
  });

  it('treats an empty payload as all-unknown contract compliance', () => {
    const { ok, attributes } = parseAnalysisOutput({});
    expect(ok).toBe(true);
    expect(attributes.category).toBeNull();
    expect(attributes.secondaryColors).toEqual([]);
    expect(attributes.visibleFeatures).toEqual([]);
    expect(attributes.analysisVersion).toBe('1');
  });

  it('bounds strings and arrays defensively', () => {
    const { ok, attributes } = parseAnalysisOutput({
      category: 'x'.repeat(500),
      secondaryColors: Array.from({ length: 40 }, (_, i) => `color${i}`),
      visibleFeatures: Array.from({ length: 40 }, (_, i) => `feat${i} ${'y'.repeat(200)}`),
    });

    expect(ok).toBe(true);
    expect(attributes.category.length).toBe(60);
    expect(attributes.secondaryColors.length).toBe(5);
    expect(attributes.visibleFeatures.length).toBe(12);
    for (const feature of attributes.visibleFeatures) {
      expect(feature.length).toBeLessThanOrEqual(100);
    }
  });

  it('rejects non-object payloads entirely', () => {
    const scalar = parseAnalysisOutput('just text');
    expect(scalar.ok).toBe(false);
    expect(scalar.issues.length).toBeGreaterThan(0);

    const listy = parseAnalysisOutput(['array']);
    expect(listy.ok).toBe(false);
  });
});
