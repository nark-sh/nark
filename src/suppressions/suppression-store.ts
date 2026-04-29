/**
 * Suppression Store
 *
 * Manages .nark-suppressions.json — a project-level file that stores suppressions
 * keyed by fingerprint, completely outside of production source code.
 *
 * Why fingerprints instead of line numbers?
 * - Fingerprints are stable identifiers shared with the SaaS database
 * - If code moves (line numbers shift), the fingerprint changes → suppression
 *   becomes stale and is detected automatically
 * - Suppressions can be cross-referenced with SaaS violation records
 *
 * File location: <projectRoot>/.nark-suppressions.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { BcScanSuppression, BcScanStore } from './types.js';

const STORE_FILENAME = '.nark-suppressions.json';
const LEGACY_STORE_FILENAME = '.bc-suppressions.json';
const STORE_VERSION = '1.0';

/**
 * Get path to the suppression store file
 */
export function getStorePath(projectRoot: string): string {
  return path.join(projectRoot, STORE_FILENAME);
}

/**
 * Load the suppression store from disk.
 * Returns an empty store if the file doesn't exist.
 */
export function loadStore(projectRoot: string): BcScanStore {
  const storePath = getStorePath(projectRoot);

  // Auto-migrate legacy .bc-suppressions.json → .nark-suppressions.json
  if (!fs.existsSync(storePath)) {
    const legacyPath = path.join(projectRoot, LEGACY_STORE_FILENAME);
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, storePath);
    } else {
      return { version: STORE_VERSION, suppressions: [] };
    }
  }

  try {
    const content = fs.readFileSync(storePath, 'utf-8');
    const store: BcScanStore = JSON.parse(content);
    return store;
  } catch (error) {
    throw new Error(
      `Failed to load .nark-suppressions.json: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Save the suppression store to disk.
 */
export function saveStore(projectRoot: string, store: BcScanStore): void {
  const storePath = getStorePath(projectRoot);
  store.version = STORE_VERSION;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Look up a suppression by fingerprint.
 * Returns undefined if no matching suppression exists.
 */
export function findByFingerprint(
  store: BcScanStore,
  fingerprint: string
): BcScanSuppression | undefined {
  return store.suppressions.find(s => s.fingerprint === fingerprint);
}

/**
 * Add or update a suppression in the store.
 * If a suppression with the same fingerprint already exists, it is replaced.
 */
export function upsertByFingerprint(
  store: BcScanStore,
  suppression: BcScanSuppression
): void {
  const idx = store.suppressions.findIndex(s => s.fingerprint === suppression.fingerprint);
  if (idx >= 0) {
    store.suppressions[idx] = suppression;
  } else {
    store.suppressions.push(suppression);
  }
}

/**
 * Remove a suppression by fingerprint.
 * Returns true if a suppression was removed, false if not found.
 */
export function removeByFingerprint(store: BcScanStore, fingerprint: string): boolean {
  const before = store.suppressions.length;
  store.suppressions = store.suppressions.filter(s => s.fingerprint !== fingerprint);
  return store.suppressions.length < before;
}

/**
 * Identify stale suppressions — entries whose fingerprint was not seen
 * in the most recent scan results.
 *
 * A suppression is stale when:
 * - The underlying violation was fixed (code corrected)
 * - The violation moved to a different line (fingerprint changed)
 * - The file was deleted
 *
 * @param store - Current suppression store
 * @param seenFingerprints - Set of fingerprints from the latest scan
 * @returns Array of suppressions that are no longer matched
 */
export function findStaleSuppressions(
  store: BcScanStore,
  seenFingerprints: Set<string>
): BcScanSuppression[] {
  return store.suppressions.filter(s => !seenFingerprints.has(s.fingerprint));
}

/**
 * Remove all stale suppressions from the store.
 * Returns the removed suppressions for reporting.
 */
export function removeStaleSuppressions(
  store: BcScanStore,
  seenFingerprints: Set<string>
): BcScanSuppression[] {
  const stale = findStaleSuppressions(store, seenFingerprints);
  const staleFingerprints = new Set(stale.map(s => s.fingerprint));
  store.suppressions = store.suppressions.filter(s => !staleFingerprints.has(s.fingerprint));
  return stale;
}

/**
 * Create a new suppression entry.
 */
export function createBcScanSuppression(params: {
  fingerprint: string;
  packageName: string;
  postconditionId: string;
  filePath: string;
  lineNumber: number;
  reason: string;
}): BcScanSuppression {
  return {
    fingerprint: params.fingerprint,
    package: params.packageName,
    postconditionId: params.postconditionId,
    filePath: params.filePath,
    lineNumber: params.lineNumber,
    reason: params.reason,
    suppressedAt: new Date().toISOString(),
  };
}
