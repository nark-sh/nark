# Nark CLI Analytics Architecture Spec

**Status:** Draft
**Author:** Caleb Gates + Claude
**Date:** 2026-04-16
**Version:** 0.1.0

---

## 1. Purpose

Nark is a CLI tool that scans TypeScript projects for behavioral contract violations. Analytics exist to answer three questions:

1. **Which contracts need improvement?** High false-positive rates on a contract mean it needs refinement.
2. **How is nark used?** Scan frequency, triage adoption, compact usage — informs roadmap.
3. **What does the ecosystem look like?** Which packages are scanned most, what Node/OS versions to support.

Analytics are not for marketing, user profiling, or monetization. They exist solely to improve scanner accuracy and contract quality.

---

## 2. Privacy Principles

These are hard constraints, not guidelines.

| Principle | Implementation |
|-----------|---------------|
| No PII | No usernames, emails, hostnames, or IP addresses stored |
| No source code | No file contents, variable names, or code snippets |
| No file paths | No absolute or relative paths from the user's machine |
| No repo identity | No repo names, git remotes, org names, or directory names |
| Opt-out available | `NARK_TELEMETRY=off` or `nark config telemetry off` |
| Fire-and-forget | Analytics never block, slow down, or fail the CLI |
| Transparent | First-run notice, `nark config telemetry status` to inspect |
| Server-side IP stripping | Ingest endpoint drops `X-Forwarded-For` and client IP before storage |
| Retention cap | Raw events deleted after 90 days; only aggregates retained long-term |

---

## 3. Opt-Out Mechanism

### 3.1 Environment Variable

```bash
# Disable telemetry for this invocation
NARK_TELEMETRY=off nark scan

# Disable telemetry permanently via shell profile
export NARK_TELEMETRY=off
```

Accepted values: `off`, `0`, `false`, `no` (case-insensitive). Any other value or absence means telemetry is on.

### 3.2 Config Command

```bash
# Disable
nark config telemetry off

# Enable
nark config telemetry on

# Check current status
nark config telemetry status
```

This writes to `.nark/config.yaml` in the project root (already exists — see `output/config.ts`) or to `~/.config/nark/config.yaml` for global preference. Project-level overrides global.

### 3.3 Precedence

Highest to lowest:

1. `NARK_TELEMETRY` environment variable
2. Project-level `.nark/config.yaml` `telemetry: off`
3. Global `~/.config/nark/config.yaml` `telemetry: off`
4. Default: `on`

### 3.4 CI Detection

If any of these environment variables are set, telemetry defaults to off unless explicitly enabled:

- `CI=true`
- `GITHUB_ACTIONS=true`
- `GITLAB_CI=true`
- `JENKINS_URL` is set
- `BUILDKITE=true`

Rationale: CI runs inflate usage metrics and are typically not interactive. Users who want CI telemetry can set `NARK_TELEMETRY=on` explicitly.

---

## 4. First-Run Notice

On the first invocation of `nark scan` (detected by absence of `~/.config/nark/telemetry-notice-shown`), print to stderr:

```
  Nark collects anonymous usage data to improve contract quality.
  No source code, file paths, or repo names are collected.

  Disable: nark config telemetry off
  Details: https://nark.dev/telemetry

```

After printing, create the sentinel file `~/.config/nark/telemetry-notice-shown` (empty file, timestamp is the file mtime). The notice is never shown again.

Requirements:
- Print to stderr so it does not pollute piped/redirected stdout.
- Do not print if telemetry is already disabled.
- Do not print in non-TTY contexts (piped output, CI).

---

## 5. Installation ID

To correlate events from the same installation without identifying the user:

1. On first run, generate a random UUIDv4.
2. Store it at `~/.config/nark/anonymous-id`.
3. Include it in every event as `installation_id`.
4. If the file is deleted, a new ID is generated — the old one is effectively abandoned.

This ID cannot be traced to a user, machine, or repo. It exists only to deduplicate and compute DAU/WAU metrics.

---

## 6. Event Data Model

### 6.1 Common Fields (All Events)

```typescript
interface BaseEvent {
  /** Event type discriminator */
  event: "scan" | "triage" | "compact";

  /** ISO 8601 timestamp, UTC */
  timestamp: string;

  /** Random UUIDv4 from ~/.config/nark/anonymous-id */
  installation_id: string;

  /** nark package version, e.g. "0.1.0" */
  nark_version: string;

  /** Node.js version, e.g. "20.11.0" */
  node_version: string;

  /** OS platform: "darwin" | "linux" | "win32" */
  os_platform: string;

  /** OS arch: "x64" | "arm64" */
  os_arch: string;
}
```

### 6.2 Scan Event

Emitted at the end of every `nark scan` invocation (success or failure).

```typescript
interface ScanEvent extends BaseEvent {
  event: "scan";

  /** Wall-clock scan duration in milliseconds */
  duration_ms: number;

  /** Number of contract YAML files loaded from nark-corpus */
  contracts_loaded: number;

  /** Number of packages detected in user's project (via package.json + import analysis) */
  packages_detected: number;

  /** Number of packages that matched a contract */
  packages_matched: number;

  /** List of matched package names (from contract, NOT from user code)
   *  e.g. ["axios", "@prisma/client", "stripe"]
   *  These are public npm package names, not user-authored code. */
  matched_package_names: string[];

  /** Violation counts by severity */
  violations: {
    error: number;
    warning: number;
    info: number;
    total: number;
  };

  /** Number of violations suppressed by triage verdicts or inline suppressions */
  suppressed_count: number;

  /** Number of TypeScript files analyzed */
  files_analyzed: number;

  /** Whether the scan completed successfully */
  success: boolean;

  /** If success=false, the error category (NOT the message, which may contain paths) */
  error_category?: "tsconfig_not_found" | "tsconfig_parse_error"
    | "corpus_load_error" | "typescript_error" | "out_of_memory" | "unknown";

  /** nark-corpus version, e.g. "0.1.0" */
  corpus_version: string;
}
```

**What is NOT included:**
- File paths (tsconfig path, source file paths)
- Violation details (messages, code snippets, line numbers)
- Repo name or directory name
- Git remote URL

### 6.3 Triage Event

Emitted when a user runs `nark triage mark`.

```typescript
interface TriageEvent extends BaseEvent {
  event: "triage";

  /** The verdict applied */
  verdict: "true-positive" | "false-positive" | "wont-fix";

  /** Package name from the contract (public npm name, not user code) */
  package_name: string;

  /** Contract rule ID, e.g. "axios-no-unhandled-rejection" */
  rule_id: string;

  /** Severity of the triaged violation */
  severity: "error" | "warning" | "info";
}
```

**Aggregated alternative:** If per-verdict events feel too granular, batch them. When a `nark triage mark` session ends (or on `nark triage summary`), emit one event:

```typescript
interface TriageBatchEvent extends BaseEvent {
  event: "triage";

  /** Count of each verdict type in this session */
  verdicts: {
    "true-positive": number;
    "false-positive": number;
    "wont-fix": number;
  };

  /** Per-package verdict breakdown. Key = public npm package name. */
  by_package: Record<string, {
    "true-positive": number;
    "false-positive": number;
    "wont-fix": number;
  }>;

  /** Per-rule false-positive counts (the most actionable data for contract improvement) */
  false_positives_by_rule: Record<string, number>;
}
```

**Recommendation:** Use the batch form. It is more useful (shows FP rates per rule) and emits fewer events.

### 6.4 Compact Event

Emitted when a user runs `nark compact`.

```typescript
interface CompactEvent extends BaseEvent {
  event: "compact";

  /** Number of scan records before compaction */
  scans_before: number;

  /** Number of scan records after compaction */
  scans_after: number;

  /** Number of violation files before compaction */
  violations_before: number;

  /** Number of violation files after compaction */
  violations_after: number;

  /** Whether --dry-run was used */
  dry_run: boolean;
}
```

---

## 7. JSON Schema

### 7.1 Scan Event Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://nark.dev/schemas/events/scan.json",
  "title": "Nark Scan Event",
  "type": "object",
  "required": [
    "event", "timestamp", "installation_id", "nark_version",
    "node_version", "os_platform", "os_arch", "duration_ms",
    "contracts_loaded", "packages_detected", "packages_matched",
    "matched_package_names", "violations", "suppressed_count",
    "files_analyzed", "success", "corpus_version"
  ],
  "properties": {
    "event": { "const": "scan" },
    "timestamp": { "type": "string", "format": "date-time" },
    "installation_id": { "type": "string", "format": "uuid" },
    "nark_version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+" },
    "node_version": { "type": "string" },
    "os_platform": { "type": "string", "enum": ["darwin", "linux", "win32"] },
    "os_arch": { "type": "string", "enum": ["x64", "arm64", "ia32"] },
    "duration_ms": { "type": "integer", "minimum": 0 },
    "contracts_loaded": { "type": "integer", "minimum": 0 },
    "packages_detected": { "type": "integer", "minimum": 0 },
    "packages_matched": { "type": "integer", "minimum": 0 },
    "matched_package_names": {
      "type": "array",
      "items": { "type": "string" }
    },
    "violations": {
      "type": "object",
      "required": ["error", "warning", "info", "total"],
      "properties": {
        "error": { "type": "integer", "minimum": 0 },
        "warning": { "type": "integer", "minimum": 0 },
        "info": { "type": "integer", "minimum": 0 },
        "total": { "type": "integer", "minimum": 0 }
      }
    },
    "suppressed_count": { "type": "integer", "minimum": 0 },
    "files_analyzed": { "type": "integer", "minimum": 0 },
    "success": { "type": "boolean" },
    "error_category": {
      "type": "string",
      "enum": [
        "tsconfig_not_found", "tsconfig_parse_error",
        "corpus_load_error", "typescript_error",
        "out_of_memory", "unknown"
      ]
    },
    "corpus_version": { "type": "string" }
  },
  "additionalProperties": false
}
```

### 7.2 Triage Batch Event Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://nark.dev/schemas/events/triage.json",
  "title": "Nark Triage Batch Event",
  "type": "object",
  "required": [
    "event", "timestamp", "installation_id", "nark_version",
    "node_version", "os_platform", "os_arch",
    "verdicts", "by_package", "false_positives_by_rule"
  ],
  "properties": {
    "event": { "const": "triage" },
    "timestamp": { "type": "string", "format": "date-time" },
    "installation_id": { "type": "string", "format": "uuid" },
    "nark_version": { "type": "string" },
    "node_version": { "type": "string" },
    "os_platform": { "type": "string" },
    "os_arch": { "type": "string" },
    "verdicts": {
      "type": "object",
      "required": ["true-positive", "false-positive", "wont-fix"],
      "properties": {
        "true-positive": { "type": "integer", "minimum": 0 },
        "false-positive": { "type": "integer", "minimum": 0 },
        "wont-fix": { "type": "integer", "minimum": 0 }
      }
    },
    "by_package": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "true-positive": { "type": "integer", "minimum": 0 },
          "false-positive": { "type": "integer", "minimum": 0 },
          "wont-fix": { "type": "integer", "minimum": 0 }
        }
      }
    },
    "false_positives_by_rule": {
      "type": "object",
      "additionalProperties": { "type": "integer", "minimum": 0 }
    }
  },
  "additionalProperties": false
}
```

### 7.3 Compact Event Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://nark.dev/schemas/events/compact.json",
  "title": "Nark Compact Event",
  "type": "object",
  "required": [
    "event", "timestamp", "installation_id", "nark_version",
    "node_version", "os_platform", "os_arch",
    "scans_before", "scans_after", "violations_before",
    "violations_after", "dry_run"
  ],
  "properties": {
    "event": { "const": "compact" },
    "timestamp": { "type": "string", "format": "date-time" },
    "installation_id": { "type": "string", "format": "uuid" },
    "nark_version": { "type": "string" },
    "node_version": { "type": "string" },
    "os_platform": { "type": "string" },
    "os_arch": { "type": "string" },
    "scans_before": { "type": "integer", "minimum": 0 },
    "scans_after": { "type": "integer", "minimum": 0 },
    "violations_before": { "type": "integer", "minimum": 0 },
    "violations_after": { "type": "integer", "minimum": 0 },
    "dry_run": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

---

## 8. Transport Layer

### 8.1 Client-Side Behavior

```
nark scan completes
  |
  v
Construct event payload
  |
  v
Check telemetry enabled? (env var > project config > global config)
  |-- No --> discard, return
  |-- Yes --v
  |
  v
Append to in-memory batch buffer
  |
  v
Flush buffer via HTTPS POST (non-blocking)
  |-- Success --> done
  |-- Failure --> write to ~/.config/nark/event-queue.jsonl (retry next run)
```

Key requirements:

- **Non-blocking:** The HTTPS POST runs in a detached child process or `setTimeout(..., 0)` with `unref()`. The CLI process exits immediately; the POST completes (or fails silently) in the background.
- **Timeout:** 3-second hard timeout on the POST. If the server is slow, drop the event.
- **Retry:** On failure, append the event as a JSON line to `~/.config/nark/event-queue.jsonl`. On the next successful run, flush the queue (max 50 events per flush, oldest first). If the queue exceeds 500 events, truncate to the newest 100.
- **No dependencies:** Use Node.js built-in `https.request` or `fetch` (Node 18+). No axios, no node-fetch.
- **Batch:** If multiple events occur in one CLI invocation (rare — typically one scan event), send them as a JSON array in a single POST.

### 8.2 Wire Format

```
POST https://telemetry.nark.dev/v1/events
Content-Type: application/json

[
  { "event": "scan", ... },
  { "event": "triage", ... }
]
```

Response: `202 Accepted` with empty body. Client ignores response body.

### 8.3 Detached Process Pattern

To ensure the CLI exits instantly, spawn a detached child process for the POST:

```typescript
// Pseudocode — not implementation
import { spawn } from "child_process";

function sendEvents(events: BaseEvent[]): void {
  const payload = JSON.stringify(events);
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "telemetry-sender.js"), payload],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
}
```

The `telemetry-sender.js` script performs the HTTPS POST and exits. If the POST fails, it writes to the queue file.

---

## 9. Backend Architecture

### 9.1 Options Evaluated

| Option | Pros | Cons |
|--------|------|------|
| **PostHog (self-hosted)** | Rich analytics UI, event schemas, funnels, retention | Heavy infra (Docker Compose, Postgres, Redis, ClickHouse), overkill for CLI telemetry, costly to self-host at scale |
| **InfluxDB Cloud** | Time-series native, fast aggregation, free tier | Designed for metrics not events, query language learning curve, limited ad-hoc analysis |
| **Custom API + SQLite** | Simple, zero vendor lock-in, cheap | Must build dashboards, no out-of-box analytics |
| **Custom API + ClickHouse** | Column-oriented, fast aggregation, handles billions of rows, open source | More operational overhead than SQLite, but well worth it at scale |
| **Tinybird** | ClickHouse-as-a-service, REST ingest, SQL analytics, generous free tier (1M rows/day) | Vendor dependency, limited self-host option |

### 9.2 Recommendation: Custom API + ClickHouse (via Tinybird)

**Phase 1 (0-1k DAU):** Custom API (single Node.js or Go service on Fly.io/Railway) + SQLite. Total cost: ~$5/month.

**Phase 2 (1k-10k DAU):** Migrate storage to Tinybird (managed ClickHouse). Keep the same ingest API. Tinybird free tier covers up to ~1M events/day. Add a Grafana dashboard pointing at Tinybird's SQL API.

**Phase 3 (10k+ DAU):** Self-hosted ClickHouse if cost matters, or stay on Tinybird's paid tier.

Rationale:
- PostHog is excellent for web apps but heavy for CLI telemetry. Its self-hosted stack (Postgres + Redis + ClickHouse + Kafka) is more infrastructure than this project warrants.
- InfluxDB is optimized for continuous metrics (CPU, memory, request latency), not discrete events with string fields. Querying "false-positive rate per rule" is awkward in Flux/InfluxQL.
- SQLite is the right starting point: zero ops, single file, trivial backup. It handles 10k DAU easily (that is ~10k-30k events/day, well within SQLite's write throughput).
- ClickHouse (via Tinybird or self-hosted) is the correct long-term store for event analytics at scale. Column-oriented storage makes aggregation queries (GROUP BY package, rule, version) very fast.

### 9.3 Ingest API Design

Single endpoint, stateless, horizontally scalable.

```
POST /v1/events
Content-Type: application/json
Body: BaseEvent[]

Response: 202 Accepted
```

Server behavior:
1. Validate JSON array, reject if invalid (400).
2. Validate each event against its JSON schema. Drop invalid events silently (log to server-side error stream, do not tell client).
3. Strip `X-Forwarded-For`, `CF-Connecting-IP`, and any client IP from the request before writing to storage. The IP address is not stored anywhere.
4. Write events to storage (SQLite in Phase 1, ClickHouse in Phase 2).
5. Return `202 Accepted` immediately.

Rate limiting: 100 requests/minute per IP (enforced at the edge, e.g., Cloudflare or Fly.io proxy). This prevents abuse without requiring authentication.

### 9.4 Storage Schema (SQLite, Phase 1)

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,         -- "scan" | "triage" | "compact"
  installation_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,          -- ISO 8601
  nark_version TEXT NOT NULL,
  node_version TEXT NOT NULL,
  os_platform TEXT NOT NULL,
  os_arch TEXT NOT NULL,
  payload TEXT NOT NULL,            -- full JSON event
  ingested_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_installation ON events(installation_id);
```

The `payload` column stores the full JSON event. This avoids schema migrations when new fields are added — just query with `json_extract()`.

### 9.5 Data Retention

- Raw events: 90 days, then deleted.
- Daily aggregates: retained indefinitely. Computed via a nightly job:

```sql
-- Example daily aggregate
INSERT INTO daily_scan_stats (date, total_scans, avg_duration_ms, avg_violations, ...)
SELECT
  date(timestamp) as date,
  COUNT(*) as total_scans,
  AVG(json_extract(payload, '$.duration_ms')) as avg_duration_ms,
  AVG(json_extract(payload, '$.violations.total')) as avg_violations
FROM events
WHERE event_type = 'scan'
  AND date(timestamp) = date('now', '-1 day')
GROUP BY date(timestamp);
```

---

## 10. Key Queries (What We Want to Answer)

These queries justify the data model. If a query cannot be answered, the data model is insufficient.

### Contract Quality

```sql
-- False-positive rate per contract rule (most actionable metric)
SELECT
  json_each.value as rule_id,
  SUM(json_extract(json_each.value, '$')) as fp_count
FROM events, json_each(json_extract(payload, '$.false_positives_by_rule'))
WHERE event_type = 'triage'
GROUP BY rule_id
ORDER BY fp_count DESC;
```

### Usage Patterns

```sql
-- Daily active installations
SELECT date(timestamp), COUNT(DISTINCT installation_id)
FROM events
WHERE event_type = 'scan'
GROUP BY date(timestamp);

-- Most scanned packages
SELECT json_each.value as package_name, COUNT(*) as scan_count
FROM events, json_each(json_extract(payload, '$.matched_package_names'))
WHERE event_type = 'scan'
GROUP BY package_name
ORDER BY scan_count DESC
LIMIT 20;

-- Triage adoption rate (installations that triage vs. just scan)
SELECT
  (SELECT COUNT(DISTINCT installation_id) FROM events WHERE event_type = 'triage') * 100.0 /
  (SELECT COUNT(DISTINCT installation_id) FROM events WHERE event_type = 'scan')
  AS triage_adoption_pct;
```

### Ecosystem

```sql
-- Node version distribution
SELECT json_extract(payload, '$.node_version'), COUNT(*)
FROM events
WHERE event_type = 'scan'
GROUP BY 1 ORDER BY 2 DESC;

-- OS distribution
SELECT os_platform, os_arch, COUNT(*)
FROM events
GROUP BY 1, 2 ORDER BY 3 DESC;
```

### Scanner Performance

```sql
-- Scan duration percentiles (p50, p90, p99)
-- (Requires ClickHouse for quantile functions; in SQLite, approximate with ORDER BY + LIMIT)
SELECT
  json_extract(payload, '$.duration_ms') as duration_ms
FROM events
WHERE event_type = 'scan'
ORDER BY duration_ms;

-- Error rate by category
SELECT
  json_extract(payload, '$.error_category') as category,
  COUNT(*) as count
FROM events
WHERE event_type = 'scan' AND json_extract(payload, '$.success') = 0
GROUP BY category
ORDER BY count DESC;
```

---

## 11. Scalability

### Estimated Load at 10k DAU

| Metric | Value |
|--------|-------|
| Scan events/day | ~15,000 (1.5 scans per user avg) |
| Triage events/day | ~2,000 (20% triage adoption) |
| Compact events/day | ~500 |
| Total events/day | ~17,500 |
| Avg event size | ~500 bytes |
| Daily ingest | ~8.75 MB |
| Monthly ingest | ~260 MB |
| 90-day retention | ~780 MB |

This is trivially small. A single SQLite file on a $5/month VPS handles this. ClickHouse becomes relevant at 100k+ DAU or if query patterns become complex.

### Burst Handling

Scans cluster around working hours (9am-6pm local time across timezones). Peak ingest may be 5x average. At 10k DAU, peak is ~70 events/minute. Any backend handles this.

The ingest API should still be stateless and horizontally scalable (deploy 2+ replicas behind a load balancer) to handle traffic spikes and provide zero-downtime deploys.

---

## 12. Client-Side Module Structure

Suggested file layout within the nark package (for implementer reference, not prescriptive):

```
src/
  telemetry/
    config.ts          -- Read telemetry on/off from env, project config, global config
    events.ts          -- Event builder functions: buildScanEvent(), buildTriageEvent(), etc.
    sender.ts          -- HTTPS POST logic, queue management, detached process spawn
    telemetry-sender.js -- Standalone script spawned as detached child process
    schemas.ts         -- Ajv validation of outbound events (optional, for dev builds)
    index.ts           -- Public API: track(event), flush(), isEnabled()
```

Public API surface:

```typescript
// Usage in scan command
import { telemetry } from "./telemetry/index.js";

// After scan completes
telemetry.track({
  event: "scan",
  duration_ms: Date.now() - startTime,
  contracts_loaded: corpus.contracts.length,
  // ...
});

// telemetry.track() is synchronous from the caller's perspective.
// It appends to a buffer, then spawns a detached process to flush on process exit.
```

---

## 13. Security Considerations

| Threat | Mitigation |
|--------|------------|
| Event payload contains PII accidentally | Build events from an allowlist of fields, never serialize arbitrary objects. Schema validation rejects unknown fields. |
| Man-in-the-middle reads events | HTTPS only. HSTS on the ingest domain. |
| Replay/spam attacks flood the ingest API | Rate limit by IP at the edge (100 req/min). Validate `installation_id` is a valid UUIDv4. Validate `nark_version` exists in the npm registry (optional, async). |
| Disk queue (`event-queue.jsonl`) contains sensitive data | The queue contains the same data as the POST body — no PII by construction. File permissions are 600 (owner read/write only). |
| Correlating installation_id across time to identify a user | The ID is a random UUID with no link to machine identity. If a user deletes `~/.config/nark/anonymous-id`, the chain breaks. No server-side join with any identity system. |

---

## 14. Testing Strategy

### Unit Tests

- `config.ts`: Verify precedence (env > project > global > default). Verify CI detection.
- `events.ts`: Verify event builders produce schema-valid JSON. Verify no file paths or source code leak into events.
- `sender.ts`: Verify queue file write on POST failure. Verify queue flush drains oldest first. Verify queue truncation at 500 events.

### Integration Tests

- Mock HTTP server that records received events. Run `nark scan` against a fixture project. Assert the event matches expected shape.
- Run with `NARK_TELEMETRY=off`, assert no HTTP request is made.
- Run with a down server, assert queue file is written. Run again with server up, assert queue is flushed.

### Privacy Audit Test

A dedicated test that:
1. Runs a scan against a fixture project with a known directory name and known file paths.
2. Captures the telemetry event.
3. Asserts that the directory name, file paths, and any string from the source code do NOT appear anywhere in the serialized event JSON.

This test runs in CI and fails if a code change accidentally leaks paths.

---

## 15. Open Questions

1. **Should `matched_package_names` be included?** These are public npm package names (axios, prisma), not user code. Including them is the single most valuable field for prioritizing contract development. Risk is low. **Recommendation: include.**

2. **Should scan events include violation rule IDs?** E.g., `["axios-unhandled-rejection", "prisma-no-try-catch"]`. This helps identify which rules fire most often. Risk: rule IDs contain only contract metadata, no user code. **Recommendation: include in a future version if triage adoption is low (since triage events already capture this).**

3. **Should there be a `config` event when users change settings?** E.g., `{ event: "config", key: "telemetry", value: "off" }`. This tells us opt-out rate. But sending an event when someone opts out of events is ironic. **Recommendation: no.**

4. **What domain for the ingest endpoint?** Options: `telemetry.nark.dev`, `events.nark.dev`, `api.nark.dev/v1/events`. **Recommendation: `telemetry.nark.dev` — clear purpose, easy to firewall.**

---

## 16. Implementation Phases

### Phase 1: MVP (ship with nark v0.2.0)

- [ ] `telemetry/config.ts` — opt-out via env var and config file
- [ ] `telemetry/events.ts` — `buildScanEvent()` only
- [ ] `telemetry/sender.ts` — detached child process POST, queue file fallback
- [ ] First-run notice on stderr
- [ ] Ingest API on Fly.io + SQLite
- [ ] Privacy audit test in CI

### Phase 2: Triage + Compact Events (v0.3.0)

- [ ] `buildTriageBatchEvent()` and `buildCompactEvent()`
- [ ] Nightly aggregation job
- [ ] Grafana dashboard for contract quality metrics

### Phase 3: Scale (v1.0.0+)

- [ ] Migrate storage to Tinybird or self-hosted ClickHouse
- [ ] Public transparency page at `https://nark.dev/telemetry` showing what is collected
- [ ] Quarterly transparency report: total events, top packages, FP rates
