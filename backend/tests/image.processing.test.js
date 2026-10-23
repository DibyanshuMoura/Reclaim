'use strict';

const sharp = require('sharp');
const {
  prepareUploadedImage,
  sniffUploadFormat,
} = require('../src/modules/image-analysis/image.processing');
const { createTestImage } = require('./helpers/images');

const BOUNDS = { maxImageBytes: 5 * 1024 * 1024, maxImageWidthPx: 1280 };

describe('sniffUploadFormat', () => {
  it('detects jpeg, png, and webp magic bytes', async () => {
    const jpeg = await createTestImage();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#333' } })
      .png()
      .toBuffer();

    expect(sniffUploadFormat(jpeg)).toBe('jpeg');
    expect(sniffUploadFormat(png)).toBe('png');
    const webp = Buffer.concat([
      Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 '),
      Buffer.alloc(20),
    ]);
    expect(sniffUploadFormat(webp)).toBe('webp');
  });

  it('rejects non-image bytes and tiny garbage', () => {
    expect(sniffUploadFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffUploadFormat(Buffer.from([0x00, 0x01]))).toBeNull();
    expect(sniffUploadFormat('not a buffer')).toBeNull();
  });
});

describe('prepareUploadedImage', () => {
  it('decants a valid image into bounded jpeg and preserves dimensions', async () => {
    const png = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#226' } })
      .png()
      .toBuffer();

    const prepared = await prepareUploadedImage(png, BOUNDS);

    expect(prepared.mimeType).toBe('image/jpeg');
    expect(prepared.bytes).toBeLessThanOrEqual(BOUNDS.maxImageBytes);
    expect(prepared.width).toBeLessThanOrEqual(BOUNDS.maxImageWidthPx);
    expect(prepared.buffer[0]).toBe(0xff); // jpeg magic
    expect(prepared.buffer[1]).toBe(0xd8);
  });

  it('rejects empty input, oversized input, and undecodable bytes', async () => {
    await expect(prepareUploadedImage(undefined, BOUNDS)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(prepareUploadedImage(Buffer.alloc(0), BOUNDS)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      prepareUploadedImage(Buffer.alloc(BOUNDS.maxImageBytes + 10), BOUNDS)
    ).rejects.toMatchObject({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    await expect(
      prepareUploadedImage(Buffer.from('this is not an image at all'), BOUNDS)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects truncated image payloads that claim a known magic', async () => {
    const good = await createTestImage();
    const truncated = good.subarray(0, 10); // valid jpeg magic, invalid content
    await expect(prepareUploadedImage(truncated, BOUNDS)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
