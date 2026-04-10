/**
 * Suppression Manifest Management
 *
 * Handles loading, saving, and updating .nark/suppressions.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Suppression, SuppressionManifest } from './types.js';

const MANIFEST_DIR = '.nark';
const MANIFEST_FILENAME = 'suppressions.json';
const MANIFEST_VERSION = '1.0.0';

/**
 * Load suppression manifest from project root
 *
 * @param projectRoot - Absolute path to project root
 * @returns Manifest object (creates new if doesn't exist)
 */
export async function loadManifest(
  projectRoot: string
): Promise<SuppressionManifest> {
  const manifestPath = getManifestPath(projectRoot);

  if (!fs.existsSync(manifestPath)) {
    return createManifest(projectRoot);
  }

  try {
    const content = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest: SuppressionManifest = JSON.parse(content);

    // Validate manifest structure
    validateManifest(manifest);

    // Migrate if needed
    if (manifest.version !== MANIFEST_VERSION) {
      return migrateManifest(manifest, projectRoot);
    }

    return manifest;
  } catch (error) {
    throw new Error(
      `Failed to load suppression manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load manifest synchronously
 *
 * @param projectRoot - Absolute path to project root
 * @returns Manifest object
 */
export function loadManifestSync(projectRoot: string): SuppressionManifest {
  const manifestPath = getManifestPath(projectRoot);

  if (!fs.existsSync(manifestPath)) {
    return createManifest(projectRoot);
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest: SuppressionManifest = JSON.parse(content);

    // Validate manifest structure
    validateManifest(manifest);

    // Migrate if needed
    if (manifest.version !== MANIFEST_VERSION) {
      return migrateManifest(manifest, projectRoot);
    }

    return manifest;
  } catch (error) {
    throw new Error(
      `Failed to load suppression manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Save suppression manifest to disk
 *
 * @param manifest - Manifest to save
 */
export async function saveManifest(manifest: SuppressionManifest): Promise<void> {
  const manifestPath = getManifestPath(manifest.projectRoot);

  // Ensure directory exists
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });

  // Update timestamp
  manifest.lastUpdated = new Date().toISOString();

  // Pretty print JSON
  const content = JSON.stringify(manifest, null, 2);

  await fs.promises.writeFile(manifestPath, content, 'utf-8');
}

/**
 * Save manifest synchronously
 *
 * @param manifest - Manifest to save
 */
export function saveManifestSync(manifest: SuppressionManifest): void {
  const manifestPath = getManifestPath(manifest.projectRoot);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });

  // Update timestamp
  manifest.lastUpdated = new Date().toISOString();

  // Pretty print JSON
  const content = JSON.stringify(manifest, null, 2);

  fs.writeFileSync(manifestPath, content, 'utf-8');
}

/**
 * Create a new empty manifest
 *
 * @param projectRoot - Absolute path to project root
 * @returns New manifest
 */
export function createManifest(projectRoot: string): SuppressionManifest {
  return {
    version: MANIFEST_VERSION,
    projectRoot: path.resolve(projectRoot),
    lastUpdated: new Date().toISOString(),
    suppressions: []
  };
}

/**
 * Add or update a suppression in the manifest
 *
 * @param manifest - Manifest to update
 * @param suppression - Suppression to add or update
 * @returns Updated manifest
 */
export function upsertSuppression(
  manifest: SuppressionManifest,
  suppression: Suppression
): SuppressionManifest {
  const existingIndex = manifest.suppressions.findIndex(s => s.id === suppression.id);

  if (existingIndex >= 0) {
    // Update existing suppression
    manifest.suppressions[existingIndex] = suppression;
  } else {
    // Add new suppression
    manifest.suppressions.push(suppression);
  }

  return manifest;
}

/**
 * Remove a suppression from the manifest
 *
 * @param manifest - Manifest to update
 * @param suppressionId - ID of suppression to remove
 * @returns Updated manifest
 */
export function removeSuppression(
  manifest: SuppressionManifest,
  suppressionId: string
): SuppressionManifest {
  manifest.suppressions = manifest.suppressions.filter(s => s.id !== suppressionId);
  return manifest;
}

/**
 * Find a suppression by location
 *
 * @param manifest - Manifest to search
 * @param file - File path (relative to project root)
 * @param line - Line number
 * @param packageName - Package name
 * @param postconditionId - Postcondition ID
 * @returns Suppression if found, undefined otherwise
 */
export function findSuppression(
  manifest: SuppressionManifest,
  file: string,
  line: number,
  packageName: string,
  postconditionId: string
): Suppression | undefined {
  return manifest.suppressions.find(
    s =>
      s.file === file &&
      s.line === line &&
      s.package === packageName &&
      s.postconditionId === postconditionId
  );
}

/**
 * Generate a unique suppression ID
 *
 * @param file - File path
 * @param line - Line number
 * @param packageName - Package name
 * @param postconditionId - Postcondition ID
 * @returns Unique ID string
 */
export function generateSuppressionId(
  file: string,
  line: number,
  packageName: string,
  postconditionId: string
): string {
  const data = `${file}:${line}:${packageName}:${postconditionId}`;
  const hash = crypto
    .createHash('sha256')
    .update(data)
    .digest('hex')
    .substring(0, 8);

  return `suppress-${file.replace(/[^a-z0-9]/gi, '-')}-${line}-${hash}`;
}

/**
 * Create a suppression object
 *
 * @param options - Suppression options
 * @returns Suppression object
 */
export function createSuppression(options: {
  file: string;
  line: number;
  column?: number;
  packageName: string;
  postconditionId: string;
  reason: string;
  suppressedBy: Suppression['suppressedBy'];
  analyzerVersion: string;
}): Suppression {
  const id = generateSuppressionId(
    options.file,
    options.line,
    options.packageName,
    options.postconditionId
  );

  const now = new Date().toISOString();

  return {
    id,
    file: options.file,
    line: options.line,
    column: options.column,
    package: options.packageName,
    postconditionId: options.postconditionId,
    reason: options.reason,
    suppressedAt: now,
    suppressedBy: options.suppressedBy,
    lastChecked: now,
    stillViolates: true,
    analyzerVersion: options.analyzerVersion
  };
}

/**
 * Get path to manifest file
 *
 * @param projectRoot - Project root directory
 * @returns Absolute path to manifest file
 */
function getManifestPath(projectRoot: string): string {
  return path.join(projectRoot, MANIFEST_DIR, MANIFEST_FILENAME);
}

/**
 * Validate manifest structure
 *
 * @param manifest - Manifest to validate
 * @throws Error if manifest is invalid
 */
function validateManifest(manifest: SuppressionManifest): void {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('Manifest must be an object');
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error('Manifest must have a version');
  }

  if (!manifest.projectRoot || typeof manifest.projectRoot !== 'string') {
    throw new Error('Manifest must have a projectRoot');
  }

  if (!manifest.lastUpdated || typeof manifest.lastUpdated !== 'string') {
    throw new Error('Manifest must have a lastUpdated timestamp');
  }

  if (!Array.isArray(manifest.suppressions)) {
    throw new Error('Manifest suppressions must be an array');
  }

  manifest.suppressions.forEach((s, index) => {
    if (!s.id || typeof s.id !== 'string') {
      throw new Error(`Suppression ${index}: Missing or invalid id`);
    }
    if (!s.file || typeof s.file !== 'string') {
      throw new Error(`Suppression ${index}: Missing or invalid file`);
    }
    if (typeof s.line !== 'number') {
      throw new Error(`Suppression ${index}: Missing or invalid line`);
    }
  });
}

/**
 * Migrate manifest to current version
 *
 * @param oldManifest - Old manifest
 * @param projectRoot - Project root
 * @returns Migrated manifest
 */
function migrateManifest(
  oldManifest: SuppressionManifest,
  projectRoot: string
): SuppressionManifest {
  // Currently only one version, but prepare for future migrations
  const newManifest = createManifest(projectRoot);

  // Copy suppressions
  newManifest.suppressions = oldManifest.suppressions || [];

  return newManifest;
}

/**
 * Get all dead suppressions (stillViolates: false)
 *
 * @param manifest - Manifest to search
 * @returns Array of dead suppressions
 */
export function getDeadSuppressions(manifest: SuppressionManifest): Suppression[] {
  return manifest.suppressions.filter(s => !s.stillViolates);
}

/**
 * Get all active suppressions (stillViolates: true)
 *
 * @param manifest - Manifest to search
 * @returns Array of active suppressions
 */
export function getActiveSuppressions(manifest: SuppressionManifest): Suppression[] {
  return manifest.suppressions.filter(s => s.stillViolates);
}

/**
 * Remove all dead suppressions from manifest
 *
 * @param manifest - Manifest to clean
 * @returns Updated manifest
 */
export function removeDeadSuppressions(manifest: SuppressionManifest): SuppressionManifest {
  manifest.suppressions = manifest.suppressions.filter(s => s.stillViolates);
  return manifest;
}
