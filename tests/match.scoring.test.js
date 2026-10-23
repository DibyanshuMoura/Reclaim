'use strict';

const { scorePair } = require('../src/modules/matching/match.service');

const DEFAULT_WEIGHTS = {
  category: 0.3,
  colors: 0.2,
  brand: 0.1,
  text: 0.2,
  venue: 0.1,
  time: 0.1,
};

const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();

function makeLost(overrides = {}) {
  return {
    _id: 'lost-id',
    itemName: 'black backpack',
    description: 'black backpack with two straps and a laptop inside, used daily for college',
    colors: ['black'],
    brand: null,
    venue: 'Central Library',
    locationDescription: null,
    incidentAt: TWO_DAYS_AGO,
    ...overrides,
  };
}

function makeFound(overrides = {}) {
  return {
    _id: 'found-id',
    venue: 'Central Library',
    locationDescription: null,
    incidentAt: TWO_DAYS_AGO,
    attributes: {
      category: 'backpack',
      itemType: 'backpack',
      primaryColor: 'black',
      secondaryColors: [],
      brand: null,
      condition: 'good',
      visibleFeatures: ['two straps', 'laptop compartment'],
      uncertainAttributes: [],
    },
    ...overrides,
  };
}

describe('scorePair (deterministic matching)', () => {
  it('scores a strong candidate pair high with visible positive factors', () => {
    const { score, factors } = scorePair(makeLost(), makeFound(), DEFAULT_WEIGHTS);

    expect(score).toBeGreaterThanOrEqual(75);
    expect(score).toBeLessThanOrEqual(100);
    expect(factors).toHaveLength(6);
    for (const factor of factors) {
      expect(factor.score).toBeGreaterThanOrEqual(0);
      expect(typeof factor.description).toBe('string');
      expect(factor.description.length).toBeGreaterThan(0);
    }
    const byKey = Object.fromEntries(factors.map((f) => [f.key, f]));
    expect(byKey.category.score).toBe(1);
    expect(byKey.colors.score).toBe(1);
    expect(byKey.venue.score).toBe(1);
  });

  it('returns a bounded zero for an unrelated pair with conflicting known data', () => {
    const unrelated = scorePair(
      makeLost({
        itemName: 'titanium water bottle',
        description: 'insulated steel water bottle with a flip lid',
        colors: ['silver'],
        brand: 'Yeti',
        venue: 'City Station',
        incidentAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      }),
      makeFound({
        venue: 'Airport Terminal',
        incidentAt: new Date().toISOString(),
        attributes: {
          category: 'backpack',
          itemType: 'backpack',
          primaryColor: 'green',
          secondaryColors: ['red'],
          brand: 'Adidas',
          condition: 'good',
          visibleFeatures: ['front zipper pocket'],
          uncertainAttributes: [],
        },
      }),
      DEFAULT_WEIGHTS
    );

    // Negative contributions for colors, brand, venue, time — must clamp at 0.
    expect(unrelated.score).toBe(0);
    const byKey = Object.fromEntries(unrelated.factors.map((f) => [f.key, f]));
    expect(byKey.colors.score).toBeLessThan(0);
    expect(byKey.brand.score).toBeLessThan(0);
    expect(byKey.venue.score).toBeLessThan(0);
    expect(byKey.time.score).toBeLessThan(0);
  });

  it('treats missing data as neutral and never as a positive signal', () => {
    const sparse = scorePair(
      makeLost({
        colors: [],
        brand: null,
        venue: null,
        locationDescription: null,
        incidentAt: null,
        description: 'a generic everyday item listed recently',
      }),
      makeFound(), // name keeps the category overlap so only one positive exists
      DEFAULT_WEIGHTS
    );

    // Only category contributes (0.3): everything else is neutral.
    expect(sparse.score).toBe(30);
    const neutral = sparse.factors.filter((f) => f.score === 0);
    for (const factor of neutral) {
      expect(factor.description).toMatch(/could not be compared|missing|not share|do not match/);
    }
  });

  it('normalizes weights so doubled weights produce the same score', () => {
    const doubled = Object.fromEntries(
      Object.entries(DEFAULT_WEIGHTS).map(([key, value]) => [key, value * 2])
    );
    expect(scorePair(makeLost(), makeFound(), doubled).score).toBe(
      scorePair(makeLost(), makeFound(), DEFAULT_WEIGHTS).score
    );
  });

  it('yields zero when every weight is zero (no division by zero)', () => {
    const zeroed = Object.fromEntries(
      Object.entries(DEFAULT_WEIGHTS).map(([key]) => [key, 0])
    );
    expect(scorePair(makeLost(), makeFound(), zeroed).score).toBe(0);
  });
});
