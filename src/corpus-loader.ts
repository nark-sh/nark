/**
 * Corpus Loader - loads and validates Nark profile files
 *
 * Version-aware (added 2026-06-09): multiple profiles per npm package can
 * coexist, differentiated by non-overlapping `semver:` ranges. The loader
 * collects every profile into `contractsByPackageName` (most-specific first)
 * and also exposes a flat `contracts` map containing the default profile per
 * package for legacy callers that don't care about installed versions.
 *
 * Inheritance (added 2026-06-09): a profile can declare `extends: <relative-path>`
 * to inherit from a parent profile and only override what changed. Child fields
 * win where present; `functions[]` deep-merges by `function.name`, then by id
 * within `postconditions[]` / `preconditions[]` / `edge_cases[]`. Use for
 * version-specific forks where most postconditions are unchanged (e.g.
 * stripe-v21 extending stripe). Use fresh-copy (no extends) for clean breaks.
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
import type {
  PackageContract,
  CorpusLoadResult,
  FunctionContract,
  Postcondition,
  Precondition,
  EdgeCase,
  DetectionRules,
} from './types.js';

// Handle ESM/CJS interop for Ajv
const Ajv = (AjvModule as any).default || AjvModule;

const MAX_EXTENDS_DEPTH = 5;

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

  // ── Pass 1: read every contract.yaml as raw YAML, key by absolute path ──
  // Don't validate or filter yet — we need all parents loaded before resolving
  // extends chains in pass 2.
  const rawByPath = new Map<string, PackageContract>();
  for (const filePath of contractFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw = YAML.parse(content) as PackageContract;
      rawByPath.set(path.resolve(filePath), raw);
    } catch (err) {
      errors.push(`Failed to read/parse ${filePath}: ${err}`);
    }
  }

  // ── Pass 2: resolve extends chains, validate, classify ──
  for (const filePath of rawByPath.keys()) {
    let merged: PackageContract;
    try {
      merged = resolveExtendsChain(filePath, rawByPath, corpusPath);
    } catch (err) {
      errors.push(`${filePath}: ${(err as Error).message}`);
      continue;
    }

    const status = merged.status || 'production';

    // Status-based skip rules (apply post-merge)
    if (status === 'in-development' && !options.includeInDevelopment) {
      skipped.push({
        package: merged.package || path.basename(path.dirname(filePath)),
        status: 'in-development',
        reason: 'Contract is in development (use --include-drafts to include)',
      });
      continue;
    }
    if (status === 'draft' && !options.includeDrafts) {
      skipped.push({
        package: merged.package || path.basename(path.dirname(filePath)),
        status: 'draft',
        reason: 'Draft contract excluded (use --include-drafts to include)',
      });
      continue;
    }

    // Schema validation runs against the MERGED contract — that's what
    // ultimately gets used at scan time, so that's what must satisfy the schema.
    const valid = validate(merged);
    if (!valid) {
      if (status === 'in-development') {
        skipped.push({
          package: merged.package || path.basename(path.dirname(filePath)),
          status: 'in-development',
          reason: 'Contract validation failed (in-development)',
        });
        continue;
      }
      const validationErrors = validate.errors
        ?.map((err: any) => `  ${err.instancePath} ${err.message}`)
        .join('\n');
      errors.push(`Invalid contract ${filePath}:\n${validationErrors}`);
      continue;
    }

    if (status === 'deprecated' && !options.includeDeprecated) {
      skipped.push({
        package: merged.package,
        status: 'deprecated',
        reason: 'Deprecated contract excluded (use --include-deprecated to include)',
      });
      continue;
    }

    if (!contractsByPackageName.has(merged.package)) {
      contractsByPackageName.set(merged.package, []);
    }
    contractsByPackageName.get(merged.package)!.push(merged);
    profileSourcePaths.set(merged, filePath);

    if (!contractFileMap.has(merged.package)) contractFileMap.set(merged.package, []);
    contractFileMap.get(merged.package)!.push(filePath);
  }

  // Sort profiles within each package: most-specific first, universal last.
  // Warn on overlapping ranges among non-universal profiles (first loaded wins).
  for (const [packageName, profiles] of contractsByPackageName) {
    profiles.sort((a, b) => {
      const aUniversal = isUniversalSemverRange(a.semver);
      const bUniversal = isUniversalSemverRange(b.semver);
      if (aUniversal !== bUniversal) return aUniversal ? 1 : -1;
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

  // Legacy single-profile-per-package view: most-specific profile per package.
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
 * Loads multiple corpora and merges them with precedence.
 *
 * @param corpusPaths Array of corpus paths in PRECEDENCE order, HIGHEST FIRST.
 *   The canonical chain is `[private, pro, public]`:
 *     - `private` (customer-specific nark-corpus-private-<customer>) wins over pro
 *     - `pro` (nark-corpus-pro) wins over public
 *     - `public` (nark-corpus) is the baseline
 *   When the same `package` name has a profile in multiple corpora, the
 *   higher-precedence one wins and a warning is emitted.
 *
 * Paths that don't exist on disk are silently skipped (they're opt-in installs).
 * If no path yields any profiles, returns the same shape as loadCorpus with
 * a single error.
 *
 * @param options Same options as `loadCorpus`. Applied per-corpus.
 * @returns Merged `CorpusLoadResult` with `corpusSources` populated to show
 *   which corpus path supplied each package's winning profile.
 */
export async function loadMultipleCorpora(
  corpusPaths: string[],
  options: LoadCorpusOptions = {}
): Promise<CorpusLoadResult> {
  if (!corpusPaths || corpusPaths.length === 0) {
    return {
      contracts: new Map(),
      contractsByPackageName: new Map(),
      errors: ['No corpus paths provided'],
      warnings: [],
      corpusSources: new Map(),
      searchedPaths: [],
    };
  }

  // Single-corpus fast path: behavior must match loadCorpus exactly.
  if (corpusPaths.length === 1) {
    const result = await loadCorpus(corpusPaths[0], options);
    return {
      ...result,
      corpusSources: undefined,
      searchedPaths: [corpusPaths[0]],
    };
  }

  // Load every path that exists.
  const perCorpus: Array<{ path: string; result: CorpusLoadResult }> = [];
  const aggregatedErrors: string[] = [];
  const aggregatedWarnings: string[] = [];
  const aggregatedSkipped: NonNullable<CorpusLoadResult['skipped']> = [];

  for (const corpusPath of corpusPaths) {
    if (!fs.existsSync(path.join(corpusPath, 'packages'))) {
      // Opt-in install missing: skip silently, but note in warnings for debug.
      aggregatedWarnings.push(
        `Corpus path "${corpusPath}" has no packages/ directory; skipped.`
      );
      continue;
    }
    const result = await loadCorpus(corpusPath, options);
    perCorpus.push({ path: corpusPath, result });
    aggregatedErrors.push(...result.errors);
    if (result.warnings) aggregatedWarnings.push(...result.warnings);
    if (result.skipped) aggregatedSkipped.push(...result.skipped);
  }

  if (perCorpus.length === 0) {
    return {
      contracts: new Map(),
      contractsByPackageName: new Map(),
      errors: aggregatedErrors.length > 0
        ? aggregatedErrors
        : [`No corpus directories found among: ${corpusPaths.join(', ')}`],
      warnings: aggregatedWarnings,
      corpusSources: new Map(),
      searchedPaths: corpusPaths,
    };
  }

  // Merge with precedence: iterate LOW → HIGH so higher-precedence sources
  // overwrite entries written by lower-precedence ones. Track each package's
  // source path; warn on override.
  const mergedByPackageName = new Map<string, PackageContract[]>();
  const mergedContractFiles = new Map<string, string[]>();
  const corpusSources = new Map<string, string>();

  for (let i = perCorpus.length - 1; i >= 0; i--) {
    const { path: srcPath, result } = perCorpus[i];
    const byPkg = result.contractsByPackageName ?? new Map<string, PackageContract[]>();
    for (const [pkgName, profiles] of byPkg) {
      const prevSource = corpusSources.get(pkgName);
      if (prevSource && prevSource !== srcPath) {
        aggregatedWarnings.push(
          `Profile for "${pkgName}" in "${srcPath}" overrides profile from "${prevSource}".`
        );
      }
      mergedByPackageName.set(pkgName, profiles);
      corpusSources.set(pkgName, srcPath);
      const files = result.contractFiles?.get(pkgName);
      if (files) mergedContractFiles.set(pkgName, files);
    }
  }

  // Rebuild the single-profile-per-package view: most-specific profile wins
  // (matches loadCorpus convention).
  const contracts = new Map<string, PackageContract>();
  for (const [pkg, profiles] of mergedByPackageName) {
    if (profiles.length > 0) contracts.set(pkg, profiles[0]);
  }

  return {
    contracts,
    contractsByPackageName: mergedByPackageName,
    errors: aggregatedErrors,
    warnings: aggregatedWarnings,
    skipped: aggregatedSkipped,
    contractFiles: mergedContractFiles,
    corpusSources,
    searchedPaths: corpusPaths,
  };
}

/**
 * Walks the `extends:` chain from the given file path, returning the fully
 * merged contract. Caps depth at MAX_EXTENDS_DEPTH and detects cycles.
 *
 * The chain is resolved root-first (deepest parent), then each child is
 * applied on top via `mergeContracts()`.
 *
 * @throws Error with descriptive message on cycle, depth-cap, missing parent,
 *   path escape, or package-name mismatch.
 */
function resolveExtendsChain(
  startPath: string,
  rawByPath: Map<string, PackageContract>,
  corpusPath: string
): PackageContract {
  // Walk the chain, building [root, ..., leaf] order.
  const chain: { path: string; contract: PackageContract }[] = [];
  const visited = new Set<string>();
  let currentPath = startPath;

  while (true) {
    if (chain.length >= MAX_EXTENDS_DEPTH) {
      throw new Error(
        `extends chain exceeds max depth (${MAX_EXTENDS_DEPTH}). ` +
          `Chain: ${chain.map((c) => c.path).join(' → ')} → ${currentPath}`
      );
    }
    if (visited.has(currentPath)) {
      throw new Error(
        `circular extends detected: ${[...visited, currentPath].join(' → ')}`
      );
    }
    visited.add(currentPath);

    const raw = rawByPath.get(currentPath);
    if (!raw) {
      throw new Error(`extends target not loaded: ${currentPath}`);
    }
    chain.unshift({ path: currentPath, contract: raw });

    if (!raw.extends) break;

    const parentPath = path.resolve(path.dirname(currentPath), raw.extends);
    // Enforce that the parent lives inside corpus/packages/ — no path escape.
    const packagesDir = path.resolve(corpusPath, 'packages');
    if (!parentPath.startsWith(packagesDir + path.sep)) {
      throw new Error(
        `extends target escapes corpus packages dir: ${raw.extends} → ${parentPath}`
      );
    }
    if (!rawByPath.has(parentPath)) {
      throw new Error(`extends target not found: ${raw.extends} → ${parentPath}`);
    }

    currentPath = parentPath;
  }

  // Merge root-first.
  let acc = chain[0].contract;
  for (let i = 1; i < chain.length; i++) {
    const child = chain[i].contract;
    if (child.package && acc.package && child.package !== acc.package) {
      throw new Error(
        `extends package mismatch: parent declares "${acc.package}" but child "${chain[i].path}" declares "${child.package}"`
      );
    }
    acc = mergeContracts(acc, child);
  }
  // Strip the now-resolved `extends` field from the final merged object.
  // (Schema allows it as an optional field anyway, but it's noise post-merge.)
  if ('extends' in acc) {
    const { extends: _, ...rest } = acc as PackageContract & { extends?: string };
    acc = rest as PackageContract;
  }
  return acc;
}

/**
 * Deep-merge a child profile on top of a parent profile.
 *
 * Top-level fields: child wins where present (truthy/non-empty), else parent.
 * `package`: child must match parent if both present (enforced by caller).
 * `detection`: child wins wholesale if present; no deep merge.
 * `functions[]`: deep merge by `function.name`. Within a function,
 *   `postconditions[]` / `preconditions[]` / `edge_cases[]` merge by `id`
 *   (child overrides parent's matching id; new ids append; unmentioned
 *   parent ids are kept). Functions in child with new names are appended.
 *   Child's function-level fields (description, import_path, namespace,
 *   aliases) override parent's where present.
 */
export function mergeContracts(
  parent: PackageContract,
  child: PackageContract
): PackageContract {
  return {
    package: child.package || parent.package,
    semver: child.semver ?? parent.semver,
    contract_version: child.contract_version ?? parent.contract_version,
    maintainer: child.maintainer ?? parent.maintainer,
    last_verified: child.last_verified ?? parent.last_verified,
    status: child.status ?? parent.status,
    deprecated: child.deprecated ?? parent.deprecated,
    deprecated_reason: child.deprecated_reason ?? parent.deprecated_reason,
    deprecated_date: child.deprecated_date ?? parent.deprecated_date,
    detection: mergeDetection(parent.detection, child.detection),
    functions: mergeFunctions(parent.functions || [], child.functions || []),
    // Carry over any extra fields the schema may permit (evidence_quality, etc.)
    // by spreading parent then child after the structured fields above.
    ...passThroughExtras(parent, child),
  } as PackageContract;
}

function passThroughExtras(parent: PackageContract, child: PackageContract): Record<string, unknown> {
  // Fields handled explicitly above — everything else passes through with
  // child-wins semantics.
  const handled = new Set([
    'package',
    'semver',
    'contract_version',
    'maintainer',
    'last_verified',
    'status',
    'deprecated',
    'deprecated_reason',
    'deprecated_date',
    'detection',
    'functions',
    'extends',
  ]);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parent as unknown as Record<string, unknown>)) {
    if (!handled.has(k) && v !== undefined) result[k] = v;
  }
  for (const [k, v] of Object.entries(child as unknown as Record<string, unknown>)) {
    if (!handled.has(k) && v !== undefined) result[k] = v;
  }
  return result;
}

function mergeDetection(
  parent: DetectionRules | undefined,
  child: DetectionRules | undefined
): DetectionRules | undefined {
  // Child wins wholesale. No deep merge — that's a future enhancement if
  // people need it for additive detection rules.
  if (child !== undefined) return child;
  return parent;
}

function mergeFunctions(
  parentFns: FunctionContract[],
  childFns: FunctionContract[]
): FunctionContract[] {
  const result: FunctionContract[] = [];
  const childByName = new Map(childFns.map((f) => [f.name, f]));
  const handledChildNames = new Set<string>();

  for (const parentFn of parentFns) {
    const childFn = childByName.get(parentFn.name);
    if (!childFn) {
      result.push(parentFn);
      continue;
    }
    handledChildNames.add(parentFn.name);
    result.push(mergeFunction(parentFn, childFn));
  }

  // New functions defined only in the child get appended.
  for (const childFn of childFns) {
    if (!handledChildNames.has(childFn.name)) {
      result.push(childFn);
    }
  }

  return result;
}

function mergeFunction(parent: FunctionContract, child: FunctionContract): FunctionContract {
  return {
    name: child.name,
    import_path: child.import_path ?? parent.import_path,
    description: child.description ?? parent.description,
    namespace: child.namespace ?? parent.namespace,
    aliases: child.aliases ?? parent.aliases,
    preconditions: mergeById(parent.preconditions, child.preconditions),
    postconditions: mergeById(parent.postconditions, child.postconditions),
    edge_cases: mergeById(parent.edge_cases, child.edge_cases),
  };
}

/**
 * Merge two arrays of `{ id: string, ... }` items.
 * - Items present in parent and not overridden by child: kept as-is.
 * - Items present in both: child wins.
 * - Items new in child: appended.
 */
function mergeById<T extends { id: string }>(
  parentItems: T[] | undefined,
  childItems: T[] | undefined
): T[] | undefined {
  if (!parentItems && !childItems) return undefined;
  if (!parentItems) return childItems;
  if (!childItems) return parentItems;

  const result: T[] = [];
  const childById = new Map(childItems.map((item) => [item.id, item]));
  const handled = new Set<string>();

  for (const parentItem of parentItems) {
    const childItem = childById.get(parentItem.id);
    if (childItem) {
      result.push(childItem);
      handled.add(parentItem.id);
    } else {
      result.push(parentItem);
    }
  }
  for (const childItem of childItems) {
    if (!handled.has(childItem.id)) {
      result.push(childItem);
    }
  }
  return result;
}

// Re-export merge helpers under names referenced by tests, if needed.
export { mergeById as _mergeById, mergeFunctions as _mergeFunctions };

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

  const coercedVersion = installedVersion ? semver.coerce(installedVersion)?.version : undefined;
  if (!coercedVersion) {
    return profiles[0];
  }

  for (const profile of profiles) {
    if (isUniversalSemverRange(profile.semver)) continue;
    if (semverRangeSatisfies(coercedVersion, profile.semver)) {
      return profile;
    }
  }

  return profiles.find((p) => isUniversalSemverRange(p.semver));
}

function semverRangeSatisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

function findOverlappingProfiles(
  profiles: PackageContract[]
): [PackageContract, PackageContract] | null {
  const specific = profiles.filter((p) => !isUniversalSemverRange(p.semver));
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
    return false;
  }
}

/**
 * Loads a single contract file (for testing).
 * Does NOT resolve extends chains — use loadCorpus() for that.
 */
export function loadContractFile(filePath: string): PackageContract {
  const content = fs.readFileSync(filePath, 'utf-8');
  return YAML.parse(content) as PackageContract;
}

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

export function getAvailablePackages(corpusPath: string): string[] {
  const packagesDir = path.join(corpusPath, 'packages');
  if (!fs.existsSync(packagesDir)) {
    return [];
  }
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

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
      (packageName) => packageName in dependencies
    );
  } catch (err) {
    console.warn(`Could not read ${projectPackageJson}: ${err}`);
    return [];
  }
}

// Re-export internals used by external tooling/tests.
export type { Postcondition, Precondition, EdgeCase };
