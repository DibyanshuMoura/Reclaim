'use strict';

/**
 * Server-side validation and normalization of vision-model output
 * (AGENT.md §6).
 *
 * Model output is untrusted input: every string is bounded and trimmed,
 * arrays are bounded, unknown fields are dropped, missing keys normalize to
 * null/[], empty-equivalent values ("unknown", "n/a", "") become null, and
 * colors are lowercased for deterministic matching.
 */
const { z } = require('zod');

const ANALYSIS_VERSION = '1';

const LIMITS = Object.freeze({
  category: 60,
  itemType: 60,
  color: 30,
  colors: 5,
  brand: 60,
  condition: 20,
  features: 12,
  featureText: 100,
  uncertain: 12,
});

function toTextLike(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function nullableBoundedString(max, { lowerCase = false } = {}) {
  return z.preprocess(
    (value) => (value === undefined ? null : value),
    z
      .union([z.string(), z.null(), z.number(), z.boolean()])
      .transform((value) => {
        let text = toTextLike(value);
        if (!text || text.toLowerCase() === 'unknown' || text.toLowerCase() === 'n/a') {
          return null;
        }
        if (lowerCase) text = text.toLowerCase();
        return text.slice(0, max);
      })
  );
}

function boundedStringArray({ maxCount, maxChars, lowerCase = false }) {
  return z.preprocess(
    (value) => (value === undefined || value === null ? [] : value),
    z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .max(50, 'too many items')
      .transform((values) => {
        const items = values
          .map((value) => toTextLike(value))
          .filter((text) => text && text.toLowerCase() !== 'unknown' && text.toLowerCase() !== 'n/a')
          .map((text) => {
            const folded = lowerCase ? text.toLowerCase() : text;
            return folded.slice(0, maxChars);
          });
        return Array.from(new Set(items)).slice(0, maxCount);
      })
  );
}

const analysisOutputSchema = z
  .object({
    category: nullableBoundedString(LIMITS.category),
    itemType: nullableBoundedString(LIMITS.itemType),
    primaryColor: nullableBoundedString(LIMITS.color, { lowerCase: true }),
    secondaryColors: boundedStringArray({ maxCount: LIMITS.colors, maxChars: LIMITS.color, lowerCase: true }),
    brand: nullableBoundedString(LIMITS.brand),
    condition: nullableBoundedString(LIMITS.condition),
    visibleFeatures: boundedStringArray({ maxCount: LIMITS.features, maxChars: LIMITS.featureText }),
    uncertainAttributes: boundedStringArray({ maxCount: LIMITS.uncertain, maxChars: LIMITS.featureText }),
  })
  .strip(); // drop any fields the model adds beyond the contract

function formatIssues(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
    .slice(0, 5);
}

/**
 * Validates then normalizes the raw parsed model output and returns either
 * the attributes document to persist, or issues when the payload is unusable
 * even after normalization.
 */
function parseAnalysisOutput(raw) {
  const result = analysisOutputSchema.safeParse(raw ?? {});
  if (!result.success) {
    return { ok: false, issues: formatIssues(result.error) };
  }
  return {
    ok: true,
    attributes: {
      category: result.data.category,
      itemType: result.data.itemType,
      primaryColor: result.data.primaryColor,
      secondaryColors: result.data.secondaryColors,
      brand: result.data.brand,
      condition: result.data.condition,
      visibleFeatures: result.data.visibleFeatures,
      uncertainAttributes: result.data.uncertainAttributes,
      analysisVersion: ANALYSIS_VERSION,
    },
  };
}

module.exports = { parseAnalysisOutput, ANALYSIS_VERSION, LIMITS };
