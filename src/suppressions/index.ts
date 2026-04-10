/**
 * Suppression System
 *
 * Public API for suppressing false positive violations and detecting dead suppressions.
 */

// Types
export * from './types.js';

// Inline comment parsing
export {
  parseInlineSuppressions,
  getSuppressionForLine,
  suppressionMatches,
  validateSuppressionComment,
  generateSuppressionComment,
  getNodeComments
} from './parser.js';

// Config file loading
export {
  loadConfig,
  loadConfigSync,
  ruleMatches,
  findMatchingRules,
  createDefaultConfig
} from './config-loader.js';

// Manifest management
export {
  loadManifest,
  loadManifestSync,
  saveManifest,
  saveManifestSync,
  createManifest,
  upsertSuppression,
  removeSuppression,
  findSuppression,
  generateSuppressionId,
  createSuppression,
  getDeadSuppressions,
  getActiveSuppressions,
  removeDeadSuppressions
} from './manifest.js';

// Suppression checking
export {
  checkSuppression,
  batchCheckSuppressions,
  getSuppressionStats
} from './matcher.js';

// Dead suppression detection
export {
  detectDeadSuppressions,
  removeDeadSuppressionsFromManifest,
  getDeadSuppressionSummary,
  formatDeadSuppression
} from './dead-suppression-detector.js';

// Fingerprint computation (mirrors SaaS)
export { computeViolationFingerprint } from './fingerprint.js';
export type { FingerprintParams } from './fingerprint.js';

// BC-scan suppression store (.bc-suppressions.json)
export {
  getStorePath,
  loadStore,
  saveStore,
  findByFingerprint,
  upsertByFingerprint,
  removeByFingerprint,
  findStaleSuppressions,
  removeStaleSuppressions,
  createBcScanSuppression
} from './bc-scan-store.js';
