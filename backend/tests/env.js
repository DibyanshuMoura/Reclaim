'use strict';

// Jest setup, executed before each test file's module registry is created.
// Integration tests override MONGODB_URI with their own in-memory server.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/placeholder';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key-placeholder';
process.env.GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-test-model';
process.env.RATE_LIMIT_WINDOW_MS = '1000';
process.env.RATE_LIMIT_MAX = '500';
process.env.REPORT_RATE_LIMIT_MAX = '50';
