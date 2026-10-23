'use strict';

/**
 * Google Gemini vision adapter (AGENT.md §4, §6, §11).
 *
 * - The image is passed ONLY via the provider's inline_data field; the
 *   Base64 string never appears in prompts, logs, or error messages.
 * - Structured output is requested via the provider's JSON response schema;
 *   callers must still validate the parsed object server-side.
 * - Model identity comes exclusively from configuration (GEMINI_MODEL).
 * - Failures are classified as transient (worth retrying) versus permanent
 *   (bad credentials/model, quota exhaustion, rejected image, safety block).
 * - Timeouts are enforced with an AbortController.
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

class GeminiPermanentError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'GeminiPermanentError';
    this.kind = kind; // 'auth' | 'model' | 'quota' | 'invalid-image' | 'blocked'
  }
}

class GeminiTransientError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'GeminiTransientError';
    this.kind = kind; // 'network' | 'timeout' | 'server' | 'malformed-output' | 'truncated-output' | 'empty-output'
  }
}

const EXAMPLE_PROMPT = [
  'Analyze the photograph of an item that a member of the public found and reported.',
  'Extract ONLY generic characteristics that are visible in the image.',
  'category and itemType: generic object family in lowercase English (for example "backpack", "wallet").',
  'primaryColor and secondaryColors: lowercase color words.',
  'brand: transcribe brand text ONLY if a logo or label is clearly legible; otherwise null.',
  'visibleFeatures: short generic descriptions (max 8 words each) of clearly visible parts.',
  'condition: exactly one of "unknown", "new", "good", "worn", "damaged".',
  'uncertainAttributes: attributes you could only infer with low confidence.',
  'Never invent brand names, model names, serial numbers, contents, ownership,',
  'locations, or times — they are not visible attributes. When not clearly',
  'visible, return null for strings and an empty array for lists.',
].join(' ');

function attributeResponseSchema() {
  const nullableString = { type: 'STRING', nullable: true };
  const stringArray = { type: 'ARRAY', items: { type: 'STRING' } };
  return {
    type: 'OBJECT',
    properties: {
      category: nullableString,
      itemType: nullableString,
      primaryColor: nullableString,
      secondaryColors: stringArray,
      brand: nullableString,
      condition: nullableString,
      visibleFeatures: stringArray,
      uncertainAttributes: stringArray,
    },
    required: [
      'category',
      'itemType',
      'primaryColor',
      'secondaryColors',
      'brand',
      'condition',
      'visibleFeatures',
      'uncertainAttributes',
    ],
    propertyOrdering: [
      'category',
      'itemType',
      'primaryColor',
      'secondaryColors',
      'brand',
      'condition',
      'visibleFeatures',
      'uncertainAttributes',
    ],
  };
}

function buildRequestBody(imageBase64) {
  return {
    contents: [
      {
        parts: [
          { text: EXAMPLE_PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: attributeResponseSchema(),
    },
  };
}

async function readErrorMessage(response) {
  // Bounded server-side provider error detail for classification ONLY.
  const raw = await response.text().catch(() => '');
  return raw.length > 0 ? raw.slice(0, 200) : '';
}

/**
 * Sends one image analysis request and returns the parsed JSON attributes
 * object. Throws GeminiPermanentError or GeminiTransientError on failure.
 */
async function analyzeImage({
  imageBase64,
  apiKey,
  model,
  timeoutMs,
  fetchImpl = fetch,
}) {
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    throw new GeminiPermanentError('invalid-image', 'No image data was provided for analysis');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${GEMINI_API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(buildRequestBody(imageBase64)),
      signal: controller.signal,
    });
  } catch (fetchError) {
    if (controller.signal.aborted || (fetchError && fetchError.name === 'AbortError')) {
      throw new GeminiTransientError('timeout', 'Image analysis timed out');
    }
    throw new GeminiTransientError('network', 'Could not reach the vision provider');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    await readErrorMessage(response); // read for connection hygiene; content is not propagated
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new GeminiPermanentError('auth', 'Vision provider rejected the configured credentials');
    }
    if (status === 404) {
      throw new GeminiPermanentError('model', 'Configured vision model is not available');
    }
    if (status === 429) {
      // Anything gets exhausted eventually; ANALYSIS quota must never be
      // retried indefinitely (AGENT.md §9).
      throw new GeminiPermanentError('quota', 'Vision provider quota is exhausted');
    }
    if (status === 400) {
      // Covers malformed requests AND images the provider cannot decode.
      throw new GeminiPermanentError('invalid-image', 'Vision provider rejected the image');
    }
    throw new GeminiTransientError('server', `Vision provider error (status ${status})`);
  }

  const payload = await response.json().catch(() => null);
  if (!payload) {
    throw new GeminiTransientError('malformed-output', 'Vision provider returned an invalid body');
  }

  const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : undefined;
  const finishReason = candidate && candidate.finishReason;
  // Only genuine answer parts carry the JSON payload; thought-summary parts
  // (flagged `thought`) and any non-text parts must not be concatenated into
  // the parsed output, or JSON.parse sees prose around the JSON document.
  const text =
    candidate &&
    candidate.content &&
    Array.isArray(candidate.content.parts)
      ? candidate.content.parts
          .filter((part) => typeof part.text === 'string' && part.thought !== true)
          .map((part) => part.text)
          .join('')
      : '';

  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION'].includes(finishReason)) {
    throw new GeminiPermanentError('blocked', 'Image analysis was blocked by provider filters');
  }
  if (finishReason === 'MAX_TOKENS') {
    throw new GeminiTransientError('truncated-output', 'Vision analysis output was truncated');
  }
  if (finishReason !== 'STOP' || text === '') {
    throw new GeminiTransientError('empty-output', 'Vision analysis returned no attributes');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiTransientError('malformed-output', 'Vision analysis output is not valid JSON');
  }
  return parsed;
}

module.exports = {
  analyzeImage,
  GeminiPermanentError,
  GeminiTransientError,
  EXAMPLE_PROMPT,
  attributeResponseSchema,
};
