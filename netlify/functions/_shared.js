/**
 * _shared.js — Shared utilities for Netlify functions
 *
 * Files prefixed with _ are NOT deployed as Netlify function endpoints;
 * they are helper modules only. Place this file alongside your functions
 * inside your functions directory (netlify/functions/_shared.js).
 */

// ── CORS headers ──────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  process.env.SITE_URL || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// Shorthand for successful JSON responses
function ok(body)       { return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) }; }
function err(code, msg) { return { statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) }; }
function preflight()    { return { statusCode: 204, headers: CORS_HEADERS, body: '' }; }

// ── From-address (warehouse / return address) ─────────────────────
function getFromAddress() {
  return {
    name:    process.env.SHIPPO_FROM_NAME    || 'Zuwera',
    street1: process.env.SHIPPO_FROM_STREET1 || '123 Brand St',
    city:    process.env.SHIPPO_FROM_CITY    || 'Los Angeles',
    state:   process.env.SHIPPO_FROM_STATE   || 'CA',
    zip:     process.env.SHIPPO_FROM_ZIP     || '90001',
    country: process.env.SHIPPO_FROM_COUNTRY || 'US',
    email:   process.env.SHIPPO_FROM_EMAIL   || 'orders@zuwera.store',
    phone:   process.env.SHIPPO_FROM_PHONE   || '',
  };
}

// ── Default parcel size (jacket in mailer box) ────────────────────
const DEFAULT_PARCEL = {
  length: '14', width: '10', height: '4',
  distance_unit: 'in',
  weight: '2', mass_unit: 'lb',
};

// ── Shippo service-level token map ────────────────────────────────
const SERVICE_TOKEN_MAP = {
  'Priority Mail':         'usps_priority',
  'Ground Advantage':      'usps_ground_advantage',
  'Priority Mail Express': 'usps_priority_express',
  'UPS Ground':            'ups_ground',
  'UPS 2nd Day Air':       'ups_second_day_air',
  'FedEx Ground':          'fedex_ground',
  'FedEx 2Day':            'fedex_2_day',
};
function getServicelevelToken(serviceName) {
  return SERVICE_TOKEN_MAP[serviceName] || 'usps_priority';
}

module.exports = { CORS_HEADERS, ok, err, preflight, getFromAddress, DEFAULT_PARCEL, getServicelevelToken };
