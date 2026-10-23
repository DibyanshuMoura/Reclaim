'use strict';

const mongoose = require('mongoose');
const { ReportStatus, AnalysisStatus } = require('./report.statuses');

/**
 * Report document. Contact email is stored in the document but marked
 * `select: false`, so any query that forgets to opt into it cannot leak it.
 * The access token is stored only as a SHA-256 hash (AGENT.md §7, §10).
 */
const reportSchema = new mongoose.Schema(
  {
    reportType: {
      type: String,
      required: true,
      enum: Object.values({ LOST: 'lost', FOUND: 'found' }),
    },
    // Lost reports only (the finder never types the item name).
    itemName: { type: String, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 2000 },
    colors: { type: [String], match: /^.{1,30}$/ },
    brand: { type: String, trim: true, maxlength: 50 },
    // Validated structured attributes from image analysis (Phase 3).
    attributes: { type: mongoose.Schema.Types.Mixed },
    venue: { type: String, trim: true, maxlength: 120 },
    locationDescription: { type: String, trim: true, maxlength: 300 },
    incidentAt: { type: Date },
    contactEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      select: false,
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(ReportStatus),
      default: ReportStatus.OPEN,
    },
    analysisStatus: {
      type: String,
      required: true,
      enum: Object.values(AnalysisStatus),
      default: AnalysisStatus.NOT_REQUIRED,
    },
    accessTokenHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    // --- Analysis bookkeeping (internal; excluded from all projections) ---
    analysisAttempts: { type: Number, default: 0, select: false },
    analysisLockedAt: { type: Date, select: false },
    analysisRetryAt: { type: Date, select: false },
    analysisError: { type: String, maxlength: 300, select: false },
  },
  {
    timestamps: true,
  }
);

// Useful for Phase 4 candidate filtering (lost ↔ found, only eligible states).
reportSchema.index({ reportType: 1, status: 1 });

module.exports = mongoose.models.Report || mongoose.model('Report', reportSchema);
