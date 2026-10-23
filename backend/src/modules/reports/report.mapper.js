'use strict';

/**
 * Field projection for API responses.
 *
 * `toPublicView` never includes contact details or the token hash, regardless
 * of what the caller loaded. Only `toPrivateView` exposes contactEmail, and it
 * is reserved for the reporter accessing their own report via token.
 */
function toPublicView(doc) {
  const view = {
    id: doc._id.toString(),
    reportType: doc.reportType,
    status: doc.status,
    analysisStatus: doc.analysisStatus,
    createdAt: doc.createdAt ? doc.createdAt.toISOString() : undefined,
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : undefined,
  };
  if (doc.itemName !== undefined && doc.itemName !== null) view.itemName = doc.itemName;
  if (doc.description !== undefined && doc.description !== null) view.description = doc.description;
  if (Array.isArray(doc.colors) && doc.colors.length > 0) view.colors = doc.colors;
  if (doc.brand) view.brand = doc.brand;
  if (doc.attributes !== undefined && doc.attributes !== null
      && Object.keys(doc.attributes).length > 0) {
    view.attributes = doc.attributes;
  }
  if (doc.venue) view.venue = doc.venue;
  if (doc.locationDescription) view.locationDescription = doc.locationDescription;
  if (doc.incidentAt !== undefined && doc.incidentAt !== null) {
    view.incidentAt = doc.incidentAt.toISOString();
  }
  return view;
}

function toPrivateView(doc) {
  return {
    ...toPublicView(doc),
    // Contact details are only ever added here, and only for private views.
    contactEmail: doc.contactEmail,
  };
}

module.exports = { toPublicView, toPrivateView };
