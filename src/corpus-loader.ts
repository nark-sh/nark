/**
 * Corpus Loader - loads and validates Nark profile files
 *
 * Version-aware (added 2026-06-09): multiple profiles per npm package can
 * coexist, differentiated by non-overlapping `semver:` ranges. The loader
 * collects every profile into `contractsByPackageName` (most-specific first)
 * and also exposes a flat `contracts` map containing the default profile per
 * package for legacy callers that don't care about installed versions.
 *
 * Use `selectContractForVersion()` to resolve which profile applies to a
 * specific installed version.
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import * as YAML from 'yaml';
import AjvModule from 'ajv';
import semver from 'semver';
import type { PackageContract, CorpusLoadResult } from './types.js';

// Handle ESM/CJS interop for Ajv
const Ajv = (AjvModule as any).default || AjvModule;

export interface LoadCorpusOptions {
  includeDrafts?: boolean;
  includeDeprecated?: boolean;
  includeInDevelopment?: boolean;
}

/**
 * A `semver:` value that should match every installed version.
 * Treated as the catch-all (lowest priority) when ordering profiles.
 */
function isUniversalSemverRange(range: string | undefined): boolean {
  if (!range) return true;
  const trimmed = range.trim();
  return trimmed === '' || trimmed === '*' || trimmed.toLowerCase() === 'any';
}

/**
 * Loads all Nark profiles from the corpus directory
 */
export async function loadCorpus(
  corpusPath: string,
  options: LoadCorpusOptions = {}
): Promise<CorpusLoadResult> {
  const contractsByPackageName = new Map<string, PackageContract[]>();
  const errors: string[] = [];
  const warnings: string[] = [];
  const skipped: { package: string; status: string; reason: string }[] = [];
  const contractFileMap = new Map<string, string[]>();
  // Tracks the file path each loaded profile came from, for warning context.
  const profileSourcePaths = new Map<PackageContract, string>();

  // Find all contract.yaml files
  const contractFiles = await glob('**/contract.yaml', {
    cwd: path.join(corpusPath, 'packages'),
    absolute: true,
  });

  if (contractFiles.length === 0) {
    errors.push(`No contract files found in ${corpusPath}/packages`);
    return { contracts: new Map(), contractsByPackageName, errors, warnings };
  }

  // Load JSON Schema for validation
  const schemaPath = path.join(corpusPath, 'schema', 'contract.schema.json');
  let schema: any;

  try {
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
    schema = JSON.parse(schemaContent);
  } catch (err) {
    errors.push(`Failed to load schema from ${schemaPath}: ${err}`);
    return { contracts: new Map(), contractsByPackageName, errors, warnings };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  // Load and validate each contract
  for (const filePath of contractFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const contract = YAML.parse(content) as PackageContract;

      // Get contract status (default to 'production' if not specified)
      const status = contract.status || 'production';

      // Skip in-development contracts silently (to avoid errors during development)
      if (status === 'in-development' && !options.includeInDevelopment) {
        skipped.push({
          package: contract.package || path.basename(path.dirname(filePath)),
          status: 'in-development',
          reason: 'Contract is in development (use --include-drafts to include)'
        });
        continue;
      }

      // Skip draft contracts before validation when not including drafts
      // (avoids failing on draft contracts with schema issues)
      if (status === 'draft' && !options.includeDrafts) {
        skipped.push({
          package: contract.package || path.basename(path.dirname(filePath)),
          status: 'draft',
          reason: 'Draft contract excluded (use --include-drafts to include)'
        });
        continue;
      }

      // Validate against JSON Schema
      const valid = validate(contract);

      if (!valid) {
        // If it's in-development and validation fails, skip silently
        if (status === 'in-development') {
          skipped.push({
            package: contract.package || path.basename(path.dirname(filePath)),
            status: 'in-development',
            reason: 'Contract validation failed (in-development)'
          });
          continue;
        }

        const validationErrors = validate.errors
          ?.map((err: any) => `  ${err.instancePath} ${err.message}`)
          .join('\n');
        errors.push(`Invalid contract ${filePath}:\n${validationErrors}`);
        continue;
      }

      // Filter by status
      if (status === 'draft' && !options.includeDrafts) {
        skipped.push({
          package: contract.package,
          status: 'draft',
          reason: 'Draft contract excluded (use --include-drafts to include)'
        });
        continue;
      }

      if (status === 'deprecated' && !options.includeDeprecated) {
        skipped.push({
          package: contract.package,
          status: 'deprecated',
          reason: 'Deprecated contract excluded (use --include-deprecated to include)'
        });
        continue;
      }

      // Collect — allow multiple profiles per package, differentiated by semver range.
      if (!contractsByPackageName.has(contract.package)) {
        contractsByPackageName.set(contract.package, []);
      }
      contractsByPackageName.get(contract.package)!.push(contract);
      profileSourcePaths.set(contract, filePath);

      if (!contractFileMap.has(contract.package)) contractFileMap.set(contract.package, []);
      contractFileMap.get(contract.package)!.push(filePath);
    } catch (err) {
      errors.push(`Failed to load contract ${filePath}: ${err}`);
    }
  }

  // Sort profiles within each package: most-specific (narrowest range) first,
  // then universal catch-all last. Detect overlapping ranges and warn — first
  // profile loaded wins when ranges overlap.
  for (const [packageName, profiles] of contractsByPackageName) {
    profiles.sort((a, b) => {
      const aUniversal = isUniversalSemverRange(a.semver);
      const bUniversal = isUniversalSemverRange(b.semver);
      if (aUniversal !== bUniversal) return aUniversal ? 1 : -1;
      // Both specific or both universal: stable by range string for determinism.
      return (a.semver || '').localeCompare(b.semver || '');
    });

    if (profiles.length > 1) {
      const overlap = findOverlappingProfiles(profiles);
      if (overlap) {
        const [first, second] = overlap;
        const firstPath = profileSourcePaths.get(first) ?? '<unknown>';
        const secondPath = profileSourcePaths.get(second) ?? '<unknown>';
        warnings.push(
          `Overlapping semver ranges for "${packageName}": ` +
            `"${first.semver}" (${firstPath}) and "${second.semver}" (${secondPath}). ` +
            `First profile loaded wins when resolving installed versions.`
        );
      }
    }
  }

  // Build the legacy single-profile-per-package view. Pick the most-specific
  // profile per package — i.e. the first one after the sort above.
  const contracts = new Map<string, PackageContract>();
  for (const [packageName, profiles] of contractsByPackageName) {
    if (profiles.length > 0) contracts.set(packageName, profiles[0]);
  }

  return {
    contracts,
    contractsByPackageName,
    errors,
    warnings,
    skipped,
    contractFiles: contractFileMap,
  };
}

/**
 * Selects the profile whose `semver:` range satisfies the installed version.
 *
 * Priority: specific ranges win over the universal catch-all. If multiple
 * specific ranges satisfy the installed version (overlap — should not happen
 * with a well-maintained corpus), the most-specific one (first in the sorted
 * array, per loader ordering) is returned.
 *
 * If `installedVersion` is undefined or unparseable, falls back to the first
 * profile (most-specific by load order) so callers still get a profile rather
 * than missing one for a known package.
 *
 * Returns `undefined` if no profile matches the installed version.
 */
export function selectContractForVersion(
  packageName: string,
  installedVersion: string | undefined,
  contractsByPackageName: Map<string, PackageContract[]>
): PackageContract | undefined {
  const profiles = contractsByPackageName.get(packageName);
  if (!profiles || profiles.length === 0) return undefined;

  // No usable installed version → return the most-specific profile we have.
  // (Backward compat: when scanning without node_modules, behavior matches
  // the pre-version-aware loader.)
  const coercedVersion = installedVersion ? semver.coerce(installedVersion)?.version : undefined;
  if (!coercedVersion) {
    return profiles[0];
  }

  // First pass: specific ranges (skip universal). profiles are sorted
  // most-specific first, so the first satisfying entry wins.
  for (const profile of profiles) {
    if (isUniversalSemverRange(profile.semver)) continue;
    if (semverRangeSatisfies(coercedVersion, profile.semver)) {
      return profile;
    }
  }

  // Fall back to the universal catch-all if present.
  const universal = profiles.find(p => isUniversalSemverRange(p.semver));
  return universal;
}

/**
 * Safe wrapper around semver.satisfies — never throws on malformed ranges.
 */
function semverRangeSatisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

/**
 * Returns the first pair of profiles whose semver ranges overlap, or null
 * if all ranges are mutually exclusive. Universal profiles are ignored —
 * they're documented to be catch-alls and always "overlap" with the rest.
 */
function findOverlappingProfiles(
  profiles: PackageContract[]
): [PackageContract, PackageContract] | null {
  const specific = profiles.filter(p => !isUniversalSemverRange(p.semver));
  for (let i = 0; i < specific.length; i++) {
    for (let j = i + 1; j < specific.length; j++) {
      if (semverRangesIntersect(specific[i].semver, specific[j].semver)) {
        return [specific[i], specific[j]];
      }
    }
  }
  return null;
}

function semverRangesIntersect(a: string, b: string): boolean {
  try {
    return semver.intersects(a, b, { includePrerelease: true });
  } catch {
    // Malformed range — treat as non-overlapping; the malformed profile will
    // simply never match anything via satisfies() either.
    return false;
  }
}

/**
 * Loads a single contract file (for testing)
 */
export function loadContractFile(filePath: string): PackageContract {
  const content = fs.readFileSync(filePath, 'utf-8');
  return YAML.parse(content) as PackageContract;
}

/**
 * Validates a contract object against the schema
 */
export function validateContract(
  contract: PackageContract,
  schemaPath: string
): { valid: boolean; errors: string[] } {
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  const schema = JSON.parse(schemaContent);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(contract);

  const errors = valid
    ? []
    : (validate.errors?.map((err: any) => `${err.instancePath} ${err.message}`) || []);

  return { valid, errors };
}

/**
 * Gets the list of packages that have contracts in the corpus
 */
export function getAvailablePackages(corpusPath: string): string[] {
  const packagesDir = path.join(corpusPath, 'packages');

  if (!fs.existsSync(packagesDir)) {
    return [];
  }

  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

/**
 * Finds which packages from the corpus are actually used in a TypeScript project
 */
export function findUsedPackages(
  projectPackageJson: string,
  availableContracts: Map<string, PackageContract | PackageContract[]>
): string[] {
  try {
    const packageJson = JSON.parse(fs.readFileSync(projectPackageJson, 'utf-8'));
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    return Array.from(availableContracts.keys()).filter(
      packageName => packageName in dependencies
    );
  } catch (err) {
    console.warn(`Could not read ${projectPackageJson}: ${err}`);
    return [];
  }
}
