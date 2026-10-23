'use strict';

/**
 * Image intake pipeline (AGENT.md §5).
 *
 * 1. Enforce declared + real limits (size first, then content).
 * 2. Sniff magic bytes — the client-supplied MIME type is never trusted.
 * 3. Bounded decode surface to block decompression bombs.
 * 4. Normalize: apply EXIF orientation, bound dimensions, compress to JPEG.
 *
 * The caller discards the original bytes immediately; only the normalized
 * JPEG copy is ever retained (temporarily). Nothing about the original
 * file (name, exact bytes, Base64) is logged or returned.
 */
const sharp = require('sharp');
const { ApiError } = require('../../utils/errors');

// ~25MP decode bound: stops decompression bombs from photo-sized uploads.
const MAX_INPUT_PIXELS = 25_000_000;

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]; // 'RIFF'
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50]; // 'WEBP' at offset 8

/**
 * Returns the concrete upload format from magic bytes, or null. This is a
 * fast sanity gate; sharp's decode remains the authoritative check.
 */
function sniffUploadFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const startsWith = (prefix, offset = 0) => {
    for (let index = 0; index < prefix.length; index += 1) {
      if (buffer[offset + index] !== prefix[index]) return false;
    }
    return true;
  };
  if (startsWith(JPEG_MAGIC)) return 'jpeg';
  if (startsWith(PNG_MAGIC)) return 'png';
  if (startsWith(RIFF_MAGIC) && startsWith(WEBP_MAGIC, 8)) return 'webp';
  return null;
}

function imageRejectedHttpResponse(message) {
  return ApiError.badRequest(message, [
    { field: 'image', message: 'Only JPEG, PNG, or WEBP images are accepted' },
  ]);
}

/**
 * Validates and decants an uploaded image into the normalized compressed
 * form kept temporarily. Throws ApiError (400/413) for rejected uploads.
 */
async function prepareUploadedImage(buffer, { maxImageBytes, maxImageWidthPx }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw ApiError.badRequest('Found reports require a photo', [
      { field: 'image', message: 'A photo file is required' },
    ]);
  }
  if (buffer.length > maxImageBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Image exceeds the ${maxImageBytes}-byte limit`);
  }
  if (sniffUploadFormat(buffer) === null) {
    throw imageRejectedHttpResponse('Unsupported or malformed image file');
  }

  let metadata;
  try {
    // limitInputPixels rejects oversized decode surfaces with an error.
    metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw imageRejectedHttpResponse('Malformed or undecodable image file');
  }
  if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw imageRejectedHttpResponse('Unsupported image format');
  }

  const prepared = await sharp(buffer)
    .rotate() // applies EXIF orientation; no-op when absent
    .resize({
      width: maxImageWidthPx,
      height: maxImageWidthPx,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  if (prepared.info.size > maxImageBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Image remains above the size limit after compression');
  }

  return {
    buffer: prepared.data,
    mimeType: 'image/jpeg',
    bytes: prepared.info.size,
    width: prepared.info.width,
    height: prepared.info.height,
  };
}

module.exports = { prepareUploadedImage, sniffUploadFormat, MAX_INPUT_PIXELS };
