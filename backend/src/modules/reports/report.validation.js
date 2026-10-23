'use strict';

/**
 * Report request validation (AGENT.md §10).
 *
 * Zod parses and bounds every field server-side; strict mode rejects unknown
 * keys. Whitespace-only strings for optional text fields normalize to
 * undefined so clients may send "" or omit the field — both are "not given".
 * Email is normalized (trimmed, lowercased) before validation.
 */
const { z } = require('zod');

const LIMITS = Object.freeze({
  itemName: 100,
  description: 2000,
  descriptionMin: 10,
  color: 30,
  colors: 5,
  brand: 50,
  venue: 120,
  locationDescription: 300,
  contactEmail: 254,
});

function requiredText(field, max, min = 1) {
  return z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z
      .string({
        required_error: `${field} is required`,
        invalid_type_error: `${field} must be a string`,
      })
      .min(min, `${field} must be at least ${min} characters`)
      .max(max, `${field} must be at most ${max} characters`)
  );
}

function optionalText(max) {
  return z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z
      .string({
        invalid_type_error: 'value must be a string',
      })
      .max(max, `must be at most ${max} characters`)
      .optional()
  );
}

function optionalColors() {
  return z
    .array(
      z
        .string()
        .trim()
        .min(1, 'color must not be empty')
        .max(LIMITS.color, `color must be at most ${LIMITS.color} characters`)
    )
    .max(LIMITS.colors, `at most ${LIMITS.colors} colors are allowed`)
    .optional()
    .transform((colors) =>
      colors && colors.length > 0 ? colors.map((c) => c.trim()) : undefined
    );
}

const requiredEmail = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().toLowerCase();
    return trimmed === '' ? undefined : trimmed;
  },
  z
    .string({
      required_error: 'contactEmail is required',
      invalid_type_error: 'contactEmail must be a string',
    })
    .max(LIMITS.contactEmail, `contactEmail must be at most ${LIMITS.contactEmail} characters`)
    .email('contactEmail must be a valid email address')
);

const incidentAt = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  },
  z
    .string({
      invalid_type_error: 'incidentAt must be an ISO 8601 date-time string',
    })
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: 'incidentAt must be a valid ISO 8601 date-time',
    })
    .refine((value) => Date.parse(value) <= Date.now() + 5 * 60 * 1000, {
      message: 'incidentAt cannot be in the future',
    })
    .optional()
);

const sharedLostAndFoundShape = {
  incidentAt,
  venue: optionalText(LIMITS.venue),
  locationDescription: optionalText(LIMITS.locationDescription),
  contactEmail: requiredEmail,
};

const lostReportCreateSchema = z
  .object({
    itemName: requiredText('itemName', LIMITS.itemName),
    description: requiredText('description', LIMITS.description, LIMITS.descriptionMin),
    colors: optionalColors(),
    brand: optionalText(LIMITS.brand),
    ...sharedLostAndFoundShape,
  })
  .strict();

// Phase 2: the found-item flow intentionally does NOT ask for item
// category/color/brand/description — a photo will supply those once image
// analysis (Phase 3) is wired in. Only the fields a photograph cannot
// establish (time, place, contact) are collected here.
const foundReportCreateSchema = z
  .object({
    description: optionalText(LIMITS.description),
    ...sharedLostAndFoundShape,
  })
  .strict();

function parseLostReportCreate(payload) {
  return lostReportCreateSchema.safeParse(payload ?? {});
}

function parseFoundReportCreate(payload) {
  return foundReportCreateSchema.safeParse(payload ?? {});
}

/**
 * Converts a ZodError into the API error envelope:
 * { message, details: [{ field, message }] }
 */
function formatValidationError(zodError) {
  return {
    message: 'Invalid report data',
    details: zodError.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

module.exports = {
  LIMITS,
  parseLostReportCreate,
  parseFoundReportCreate,
  formatValidationError,
  lostReportCreateSchema,
  foundReportCreateSchema,
  requiredEmail,
};
