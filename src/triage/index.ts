/**
 * Triage module — read, write, and suppress violation triage verdicts.
 */

export { readTriageData, readAllViolationFiles } from './reader.js';
export type { TriageVerdict } from './reader.js';
export { getSuppressedFingerprints } from './suppressor.js';
export { markVerdict } from './writer.js';
