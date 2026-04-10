/**
 * .nark/ output module — barrel export
 */

export { writeScanResults, findNarkDir } from './scan-writer.js';
export type { ScanRecord, WriteScanOptions, WriteScanResult } from './scan-writer.js';

export { loadConfig, saveConfig, ensureConfig } from './config.js';
export type { NarkConfig } from './config.js';

export { formatViolationMd, formatViolationJson } from './formatters.js';
export type { ViolationFileJson } from './formatters.js';
