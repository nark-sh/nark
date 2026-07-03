/**
 * Shared types for the offline gold-benchmark labeling toolchain.
 *
 * The toolchain runs end-to-end on Caleb's Mac. See ./README.md for the flow.
 * No token is required until the final `nark benchmark upload --source=gold`
 * step; every stage in this directory writes to `~/.nark/benchmark-label/`
 * and can be resumed after a crash.
 *
 * See also:
 *   - work-packages/accuracy-roadmap/0003-gold-benchmark-candidates.md (60 repos)
 *   - work-packages/accuracy-roadmap/0006-accuracy-dashboard-spec.md (verification)
 *   - behavioral-contracts-saas/apps/web/app/admin/(protected)/accuracy-roadmap/page.tsx
 */

// ---------------------------------------------------------------------------
// Repo shortlist (rank-candidates.ts)
// ---------------------------------------------------------------------------

export type Framework =
  | 'nextjs'
  | 'nest'
  | 'express'
  | 'monorepo'
  | 'library'
  | 'node-script'
  | 'vue'
  | 'tauri'
  | 'other';

export type SizeBucket = 'S' | 'M' | 'L';

export interface RepoCandidate {
  /** Bare directory name under `test-repos/` (e.g. "cal.com"). */
  name: string;
  /** Absolute path to the repo on disk. */
  path: string;
  /** Best-guess framework from package.json signals. */
  framework: Framework;
  /** S = <200 TS+TSX, M = 200-1500, L = 1500+. */
  size_bucket: SizeBucket;
  /** npm package names from top-level `dependencies` that a corpus profile exists for. */
  packages_exercised: string[];
  /** True if the repo appears in bc-fp-harvester state.json / triage output. */
  prior_harvester_touch: boolean;
  /**
   * Estimated violation count. From state.json where available, otherwise
   * a rough proxy of packages_exercised.length * 5. Used only for size mix,
   * not for the actual scan (that happens in scan-repos.ts).
   */
  estimated_violation_count: number;
  /** One-line justification pulled from 0003-gold-benchmark-candidates.md. */
  rationale: string;
  /** Composite score (0-100). Set by the ranker; higher = better shortlist pick. */
  score: number;
  /** Reserve status: false = selected in top-50, true = kept as backup. */
  reserve?: boolean;
}

export interface CoverageReport {
  /** Contracted packages that hit 0 repos in the shortlist. */
  packages_zero_coverage: string[];
  /** Contracted packages that hit exactly 1 repo. */
  packages_thin_coverage: string[];
  /** Contracted packages that hit 2+ repos. */
  packages_ok_coverage: string[];
  /** Per-framework counts in the top-50. */
  framework_mix: Record<Framework, number>;
  /** Per-size-bucket counts in the top-50. */
  size_mix: Record<SizeBucket, number>;
}

export interface Shortlist {
  /** Ranker output: 50 selected + 10 reserve, all with .score populated. */
  repos: RepoCandidate[];
  /** Human-readable criterion labels for reproducibility. */
  criteria_used: string[];
  /** Weight table applied by the ranker. */
  weights: Record<string, number>;
  /** Coverage arithmetic to flag gaps to Caleb. */
  coverage_report: CoverageReport;
  /** ISO 8601 timestamp. */
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Violations (scan-repos.ts output; labeler.ts + adjudicate.ts input)
// ---------------------------------------------------------------------------

export interface Violation {
  /** Repo bare name (matches Shortlist.repos[i].name). */
  repo: string;
  /** Path relative to the repo root. */
  file: string;
  /** 1-based line number of the callsite. */
  line: number;
  /** npm package name the violation attributes to (e.g. "axios"). */
  package: string;
  /** Corpus rule identifier (e.g. "axios/get-throws-on-network"). */
  rule_id: string;
  /** Postcondition ID within the rule (from contract.yaml). */
  postcondition_id: string;
  /** Human-readable postcondition description from contract.yaml. */
  postcondition_description: string;
  /** 40-line context centered on `line` (20 above + line + 19 below). */
  code_snippet: string;
  /** Optional stable id we assign so labels and adjudication can cross-reference. */
  id: string;
}

// ---------------------------------------------------------------------------
// Labeler verdicts (labeler.ts)
// ---------------------------------------------------------------------------

export type LabelerId = 'A' | 'B' | 'C';
export type Verdict = 'TP' | 'FP' | 'undecidable';

export interface LabelerVerdict {
  labeler_id: LabelerId;
  verdict: Verdict;
  /** 1-3 sentence justification, extracted from the JSON response. */
  reasoning: string;
  /** Model self-reported confidence 0-1. Not calibrated; useful for triage only. */
  confidence: number;
  /** e.g. "claude-sonnet-4-6" or "claude-opus-4-7". */
  model_used: string;
  /** Wall time of the API call in ms. */
  latency_ms: number;
  /** Prompt version so we can bisect if the template changes. */
  prompt_version: string;
  /** Token usage (input / output / cache-read / cache-created). */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export type Agreement = 'agreed_TP' | 'agreed_FP' | 'disagree' | 'escalate';

export interface LabeledViolation {
  violation: Violation;
  /** Always [A, B]. If --opus-verify triggered, a third C verdict may also be present. */
  labelers: LabelerVerdict[];
  agreement: Agreement;
  /**
   * Set by adjudicate.ts once a human resolves a disagreement or escalation.
   * `skip` = human deferred (e.g. not enough context, revisit later).
   */
  user_decision?: 'TP' | 'FP' | 'skip';
  /** Optional note from the adjudicator. */
  user_note?: string;
}

// ---------------------------------------------------------------------------
// Aggregate stats (used by labeler progress + adjudicate summary)
// ---------------------------------------------------------------------------

export interface RunStats {
  total_violations: number;
  labeled: number;
  agreed_TP: number;
  agreed_FP: number;
  disagreed: number;
  escalated: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_created_tokens: number;
  estimated_usd: number;
}
