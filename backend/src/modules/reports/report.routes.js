'use strict';

/**
 * Report routes. Handlers are thin — validation, business rules, and
 * persistence all live in the service layer (AGENT.md §4, §14).
 *
 * Exported as a factory so the composition root (app.js) wires the
 * report-create rate limiter and upload bounds explicitly.
 */
const { Router } = require('express');
const multer = require('multer');
const reportService = require('./report.service');
const analysisService = require('../image-analysis/analysis.service');
const { toPublicView } = require('./report.mapper');
const { ApiError } = require('../../utils/errors');

const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function createReportRouter({ reportCreateLimiter, config }) {
  const router = Router();

  function requireValidToken(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      throw ApiError.notFound('Report not found');
    }
    return rawToken;
  }

  function rejectInvalidImageType(file, done) {
    if (!file || !ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
      done(
        ApiError.badRequest('Unsupported image type', [
          { field: 'image', message: 'Only JPEG, PNG, or WEBP images are accepted' },
        ])
      );
      return;
    }
    done(null, true);
  }

  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxImageBytes,
      files: 1,
      fields: 20,
      fieldSize: 64 * 1024,
    },
    fileFilter: (_req, file, done) => rejectInvalidImageType(file, done),
  });

  router.get('/private/reports/:token', async (req, res) => {
    const report = await reportService.getReportByAccessToken(requireValidToken(req.params.token));
    if (!report) throw ApiError.notFound('Report not found');
    res.status(200).json({ report });
  });

  router.post('/private/reports/:token/image', imageUpload.single('image'), async (req, res) => {
    const report = await reportService.getRawReportByAccessToken(requireValidToken(req.params.token));
    if (!report) throw ApiError.notFound('Report not found');
    const updated = await analysisService.replaceReportImage(report, {
      buffer: req.file ? req.file.buffer : undefined,
      mimeType: req.file ? req.file.mimetype : undefined,
    }, {
      maxImageBytes: config.maxImageBytes,
      maxImageWidthPx: config.imageMaxWidthPx,
      imageRetentionMs: config.imageRetentionMs,
    });
    res.status(200).json({ report: toPublicView(updated) });
  });

  router.post('/private/reports/:token/close', async (req, res) => {
    const result = await reportService.closeReportByAccessToken(requireValidToken(req.params.token));
    if (!result) throw ApiError.notFound('Report not found');
    res.status(200).json({ report: toPublicView(result.report) });
  });

  router.post('/reports/lost', reportCreateLimiter, async (req, res) => {
    const result = await reportService.createLostReport(req.body);
    res.status(201).json(result);
  });

  router.post('/reports/found', reportCreateLimiter, imageUpload.single('image'), async (req, res) => {
    const result = await reportService.createFoundReport(req.body, {
      buffer: req.file ? req.file.buffer : undefined,
      mimeType: req.file ? req.file.mimetype : undefined,
    });
    res.status(201).json(result);
  });

  return router;
}

module.exports = { createReportRouter };
