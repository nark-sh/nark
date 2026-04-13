# Changelog

## [Unreleased] — 2026-04-13 Sprint (quick-17 through quick-33)

This sprint added 17 features across nark and behavioral-contracts-saas, covering CLI standards, new subcommands, config file support, telemetry, auth, CI integration, and SaaS data models.

### CLI Standards

- **Exit codes** — scan exits `0` (clean), `1` (violations at or above threshold), `2` (internal error). Previously always exited `0`.
- **`--report-only`** — always exit `0` regardless of violations; for pipelines that want scan output without blocking CI.
- **`--fail-threshold <level>`** — set the severity threshold that triggers exit `1`. Values: `error` (default) | `warning` | `info`.
- **`--verbose`** — emit 4 progress checkpoints to stderr during a scan (resolving tsconfig, loading corpus, walking AST, writing output).
- **`--sarif`** — write SARIF 2.1.0 output to `.nark/results.sarif` (alongside normal output).
- **`--sarif-output <file>`** — write SARIF output to a custom path.
- **D3 SRI hash** — the inline D3.js in the HTML visualizer now includes a `crossorigin="anonymous" integrity="..."` attribute to satisfy strict CSPs.

### New Subcommands

- **`nark show version`** — print nark version, Node version, corpus path, and contract count.
- **`nark show supported-packages`** — list all contracted packages. Add `--json` for machine-readable output.
- **`nark show deployment`** — print the current auth/API endpoint configuration.
- **`nark telemetry status`** — show whether telemetry is enabled and the config path.
- **`nark telemetry on`** — opt in to telemetry.
- **`nark telemetry off`** — opt out of telemetry.
- **`nark login`** — authenticate with the nark SaaS API. Stores token in `~/.nark/auth.json`.
- **`nark logout`** — remove stored credentials.
- **`nark ci`** — diff-aware scan: only analyzes files changed since `HEAD~1` (or `--baseline-commit <hash>`). Accepts `--sarif` flag. Designed for PR checks.

### Config & Telemetry

- **`.narkrc.yaml` config file** — place `.narkrc.yaml` in your project root to set any CLI option persistently. CLI flags override file values. See `.narkrc.yaml.example` for all fields.
- **`src/config/narkrc.ts`** — loader that merges `.narkrc.yaml` values under CLI flags at startup.
- **Telemetry POST** — when authenticated, successful scans POST a `ScanTelemetryEvent` to `/api/telemetry/scan` including repo fingerprint, violation counts, and contract versions hit.
- **`repoFingerprint`** — stable identifier derived from the git remote URL, sent with telemetry events.
- **Lifecycle events** — `nark ci` fires `ViolationLifecycleEvent` records to `/api/telemetry/lifecycle` on scan completion, enabling violation-level trend tracking.

### SaaS (behavioral-contracts-saas)

- **`POST /api/telemetry/scan`** — receives `ScanTelemetryEvent` payloads from authenticated CLI scans.
- **`POST /api/telemetry/lifecycle`** — receives `ViolationLifecycleEvent` payloads; powers violation trend analytics.
- **`ScanTelemetryEvent` Prisma model** — stores per-scan metadata (repo fingerprint, violation counts, contract hits).
- **`ViolationLifecycleEvent` Prisma model** — stores per-violation lifecycle state changes.
- **`getViolationStats()`** — query helper for aggregating lifecycle events per repo.
- **`/dashboard/analytics`** — org-level analytics page: scan volume, violation trends, top contracts hit.
- **Scan history section** — repository detail page now shows the last N scans for that repo.
- **`lib/github/check-run.ts`** — creates/updates a GitHub Check Run with SARIF annotations on PR branches.
- **`lib/github/pr-comment.ts`** — upserts a PR summary comment showing violation counts and links.
- **`/dashboard/setup-ci`** — step-by-step CI setup guide page (GitHub Actions snippet, secrets instructions).
- **Anthropic SDK safety** — `apps/web/lib/ai/violation-reviewer.ts` now wraps all Anthropic SDK calls in try-catch with `APIError` handling (quick-17).

### Test Coverage

- 1897 tests total; 1790 passing. 107 failing tests are pre-existing false-negative ground-truth cases in the V2 analyzer (not regressions from this sprint).
