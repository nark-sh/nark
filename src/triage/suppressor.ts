/**
 * Suppress false-positive violations during scan.
 */

import { readTriageData } from './reader.js';

/**
 * Returns set of fingerprints where verdict is "false-positive".
 * These should be skipped when writing violation files.
 */
export function getSuppressedFingerprints(narkDir: string): Set<string> {
  const triageData = readTriageData(narkDir);
  const suppressed = new Set<string>();

  for (const [fingerprint, triage] of triageData.entries()) {
    if (triage.verdict === 'false-positive') {
      suppressed.add(fingerprint);
    }
  }

  return suppressed;
}
