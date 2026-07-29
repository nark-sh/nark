/**
 * Probe manifest serializer.
 *
 * `nark --emit-probes` writes this document instead of the human report. It is
 * the versioned handoff contract between the AST scanner (`nark`) and the
 * runtime confirmer (`nark-runtime`, a separate package). `nark-runtime confirm
 * --probes <manifest>` reads it, wraps only the packages/methods that appear in
 * `candidates`, injects each documented error, and writes back a
 * `confirm-report.json` keyed by the same `fingerprint`.
 *
 * Schema is defined in `nark-dev/nark-runtime/ROADMAP.md` ("Probe manifest")
 * and `work-packages/positioning-2026-07/0006-nark-runtime-design.md` §A3.
 *
 * This module is PURE SERIALIZATION of data nark already computes — it adds no
 * new runtime dependency to the base scanner and does no extra AST work. Every
 * field is sourced from the already-produced `Violation[]`, the already-loaded
 * corpus `contracts` map, and cheap `node_modules/<pkg>/package.json` reads.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PackageContract, Postcondition, Violation } from '../types.js';

/** A single flagged callsite handed to nark-runtime for confirmation. */
export interface ProbeCandidate {
  /** Stable id already computed by nark (dedup + AST/runtime cross-ref). */
  fingerprint: string;
  package: string;
  /** Installed version resolved from the target's node_modules; null if absent. */
  version: string | null;
  /** Which corpus tier the matched profile came from: "public" | "pro" | "private:<suffix>". */
  corpus_tier: string;
  postcondition_id: string;
  callsite: {
    file: string;
    line: number;
    /** The function/method name the contract matched (e.g. "readContract"). */
    symbol: string;
    /** The call expression text (e.g. "client.readContract"). */
    call_expression: string;
  };
  /** Human/machine-readable description of the documented error to inject. */
  documented_error: string;
  /** true iff the matched postcondition carries a `throws:` clause (A4). */
  injectable: boolean;
  /** What the static pass concluded. Always UNHANDLED — nark only reports unhandled sites. */
  ast_verdict: 'UNHANDLED';
  /** gate | report | off — carried through from the profile. null when the profile omits it. */
  confidence_tier: string | null;
  severity: 'error' | 'warning' | 'info';
}

export interface ProbeManifest {
  $schema_version: '1';
  nark_version: string;
  corpus: { tiers: string[]; hash: string | null };
  target: { root: string; tsconfig: string; node_version: string };
  candidates: ProbeCandidate[];
}

export interface BuildProbeManifestOptions {
  narkVersion: string;
  /** Absolute project root — used to resolve installed versions from node_modules. */
  projectRoot: string;
  tsconfigPath: string;
  /** Corpus paths in precedence order (highest first) — used to derive the tier list. */
  corpusPaths: string[];
  /** Map of packageName -> winning corpus path, from loadMultipleCorpora(). */
  corpusSources?: Map<string, string>;
  /** Pre-resolved installed versions (e.g. from package discovery). Optional. */
  installedVersions?: Map<string, string>;
}

/**
 * Map a corpus directory path to its tier label.
 *   nark-corpus-pro / @nark-sh/corpus-pro / *corpus-pro* -> "pro"
 *   nark-corpus-private-<suffix>                          -> "private:<suffix>"
 *   everything else (public nark-corpus)                  -> "public"
 */
export function corpusPathToTier(corpusPath: string): string {
  const p = corpusPath.replace(/\\/g, '/').toLowerCase();
  const privateMatch = p.match(/nark-corpus-private-([^/]+)/);
  if (privateMatch) return `private:${privateMatch[1]}`;
  if (p.includes('corpus-pro') || p.includes('nark-corpus-pro')) return 'pro';
  return 'public';
}

/**
 * Best-effort read of an installed package version from the target's
 * node_modules. Returns null when the package isn't installed / is unreadable.
 * Handles scoped packages because `name` is used verbatim as a path segment.
 */
function resolveInstalledVersion(projectRoot: string, name: string): string | null {
  try {
    const pkgJsonPath = path.join(projectRoot, 'node_modules', name, 'package.json');
    const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up the corpus postcondition backing a violation, mirroring the lookup
 * the v2 adapter already performs for `maturity`. Returns undefined when the
 * profile/function/postcondition can't be located (e.g. version skew).
 */
function findPostcondition(
  contracts: Map<string, PackageContract>,
  v: Violation
): Postcondition | undefined {
  const contract = contracts.get(v.package);
  if (!contract) return undefined;
  const fn = (contract.functions ?? []).find((f) => f.name === v.function);
  if (!fn) return undefined;
  return (fn.postconditions ?? []).find((p) => p.id === v.contract_clause);
}

/**
 * Compose the documented-error string an injector reconstructs. Prefers the
 * postcondition's `throws:` clause (the error class + shape), appending the
 * triggering `condition` so nark-runtime and humans see when it fires — e.g.
 * "ContractFunctionExecutionError" + " when the call reverts".
 */
function documentedError(pc: Postcondition | undefined, fallback: string): string {
  if (!pc) return fallback;
  const throwsClause = pc.throws?.trim();
  const condition = pc.condition?.trim();
  if (throwsClause) {
    return condition ? `${throwsClause} when ${condition}` : throwsClause;
  }
  // Non-injectable (returns/security/logic) — describe what we can.
  return condition || pc.required_handling?.trim() || fallback;
}

/**
 * Build the probe manifest from the final violation set. Pure serialization:
 * every value is derived from `violations`, `contracts`, and cheap file reads.
 */
export function buildProbeManifest(
  violations: Violation[],
  contracts: Map<string, PackageContract>,
  opts: BuildProbeManifestOptions
): ProbeManifest {
  const versionCache = new Map<string, string | null>();
  const versionFor = (pkg: string): string | null => {
    const pre = opts.installedVersions?.get(pkg);
    if (pre) return pre;
    if (versionCache.has(pkg)) return versionCache.get(pkg) ?? null;
    const resolved = resolveInstalledVersion(opts.projectRoot, pkg);
    versionCache.set(pkg, resolved);
    return resolved;
  };

  const candidates: ProbeCandidate[] = violations.map((v) => {
    const pc = findPostcondition(contracts, v);
    const injectable = !!pc?.throws && pc.throws.trim().length > 0;
    const callExpression =
      (v as unknown as { callExpression?: string }).callExpression || v.function;
    const fingerprint =
      (v as unknown as { fingerprint?: string }).fingerprint || '';
    const corpusPath = opts.corpusSources?.get(v.package);
    const corpusTier = corpusPath ? corpusPathToTier(corpusPath) : 'public';

    return {
      fingerprint,
      package: v.package,
      version: versionFor(v.package),
      corpus_tier: corpusTier,
      postcondition_id: v.contract_clause,
      callsite: {
        file: v.file,
        line: v.line,
        symbol: v.function,
        call_expression: callExpression,
      },
      documented_error: documentedError(pc, v.description),
      injectable,
      ast_verdict: 'UNHANDLED',
      confidence_tier:
        (pc as unknown as { confidence_tier?: string } | undefined)
          ?.confidence_tier ?? null,
      severity: v.severity,
    };
  });

  // Derive the tier list from the corpus paths, in precedence order, deduped.
  const tiers: string[] = [];
  for (const p of opts.corpusPaths) {
    const tier = corpusPathToTier(p);
    if (!tiers.includes(tier)) tiers.push(tier);
  }

  return {
    $schema_version: '1',
    nark_version: opts.narkVersion,
    corpus: { tiers, hash: null },
    target: {
      root: opts.projectRoot,
      tsconfig: opts.tsconfigPath,
      node_version: process.version,
    },
    candidates,
  };
}

/**
 * Serialize the manifest. Preserves literal Unicode (json-serialization rule);
 * default JSON.stringify does not escape non-ASCII.
 */
export function serializeProbeManifest(manifest: ProbeManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}
