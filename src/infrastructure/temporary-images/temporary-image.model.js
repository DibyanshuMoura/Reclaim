'use strict';

/**
 * Temporary image store for analysis retries (AGENT.md §5).
 *
 * Images live here and ONLY here — never inside the main report document.
 * The TTL index is an asynchronous backstop, not a deletion guarantee; all
 * lifecycle code explicitly deletes payloads on success, retry exhaustion,
 * or replacement.
 */
const mongoose = require('mongoose');

const temporaryImageSchema = new mongoose.Schema(
  {
    reportId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
      ref: 'Report',
    },
    // Images are decanted to a single normalized compressed format.
    mimeType: { type: String, required: true, enum: ['image/jpeg'] },
    data: { type: Buffer, required: true, select: false },
    bytes: { type: Number, required: true },
    width: { type: Number },
    height: { type: Number },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

temporaryImageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.TemporaryImage || mongoose.model('TemporaryImage', temporaryImageSchema);
