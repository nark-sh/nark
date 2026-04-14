# nark

**Contract coverage scanner for npm packages — find missing error handling before production.**

nark scans your TypeScript codebase against a curated library of 169+ package contracts to find places where error handling is missing. Think of it as a linter, but for runtime failure modes — unhandled promise rejections, missing `.on('error')` listeners, uncaught API exceptions.

## Quick Start

```bash
# Clone nark and the contract corpus side by side
git clone https://github.com/nark-sh/nark.git
git clone https://github.com/nark-sh/nark-corpus.git

# Build
cd nark
npm install
npm run build

# Verify it works by scanning nark itself
node bin/nark.js --tsconfig ./tsconfig.json --corpus ../nark-corpus

# Then scan your own project
node bin/nark.js --tsconfig /path/to/your/project/tsconfig.json --corpus ../nark-corpus
```

Scanning nark's own repo is a good smoke test — you should see a clean report with 0 violations and a handful of contracted packages detected.

If your project doesn't have a `tsconfig.json`, nark will generate a minimal one automatically.

If `nark-corpus` is installed as an npm package, nark finds it automatically — no `--corpus` flag needed.

## What It Finds

nark knows how 169+ npm packages fail at runtime. For each one, it checks that your code handles those failures. Example violations:

```
ERROR  axios.get() call without try-catch
  → src/api/client.ts:42
  Contract: axios → postcondition "network-error-handling"
  Fix: Wrap in try-catch and handle AxiosError

WARN   redis.connect() without .on('error') listener
  → src/cache/redis.ts:18
  Contract: ioredis → postcondition "connection-error-listener"
  Fix: Register error listener before calling connect()
```

## How It Works

1. **Contracts** define how packages fail (what errors they throw, what events they emit)
2. **Scanner** walks your TypeScript AST and finds calls to contracted packages
3. **Analyzer** checks if each call site has appropriate error handling
4. **Reporter** outputs violations with severity, location, and fix suggestions

Contracts are YAML files in the [nark-corpus](https://github.com/nark-sh/nark-corpus) package. The scanner uses TypeScript's compiler API — no runtime execution.

## Output

Results go to `.nark/` in your project directory:

```
.nark/
├── config.yaml              # Scanner configuration
├── latest -> scans/002/     # Symlink to most recent scan
├── scans/
│   ├── 001/
│   │   ├── summary.json     # Machine-readable results
│   │   └── summary.md       # Human-readable report
│   └── 002/
│       ├── summary.json
│       └── summary.md
└── violations/
    ├── axios/
    │   └── network-error-handling.md
    └── ioredis/
        └── connection-error-listener.md
```

## Commands

### Scan (default)

```bash
# Scan current directory
nark

# Scan a specific project
nark --tsconfig ./tsconfig.json

# Include test files
nark --include-tests

# Fail CI on warnings
nark --fail-on-warnings

# Report-only mode (always exit 0 — never block CI)
nark --report-only

# Exit 1 if any warnings or errors found
nark --fail-threshold warning

# SARIF output for GitHub Code Scanning
nark --sarif
nark --sarif-output results.sarif

# Verbose progress output to stderr
nark --verbose
```

### Show

Inspect nark's configuration and supported packages:

```bash
# Print nark version, Node version, corpus path, contract count
nark show version

# List all contracted packages (human-readable)
nark show supported-packages

# List as JSON
nark show supported-packages --json

# Show current auth/API endpoint config
nark show deployment
```

### Telemetry

```bash
# Check telemetry status
nark telemetry status

# Opt out
nark telemetry off

# Opt back in
nark telemetry on
```

### Auth

```bash
# Authenticate with the nark SaaS (stores token in ~/.nark/auth.json)
nark login

# Remove stored credentials
nark logout
```

### CI (diff-aware scanning)

Scans only the files changed in the current PR/branch — ideal for GitHub Actions:

```bash
# Scan files changed since HEAD~1
nark ci

# Scan files changed since a specific commit
nark ci --baseline-commit <hash>

# With SARIF output (for GitHub Check Runs / Code Scanning)
nark ci --sarif
nark ci --sarif-output results.sarif
```

### Triage

Review and categorize violations:

```bash
# List untriaged violations
nark triage list

# Mark a violation
nark triage mark <fingerprint> true-positive
nark triage mark <fingerprint> false-positive --reason "handled by framework"
nark triage mark <fingerprint> wont-fix --reason "acceptable risk"

# Show triage stats
nark triage summary
```

False positives are automatically suppressed in future scans.

### Suppressions

```bash
# List all suppressions
nark suppressions list

# Add a suppression
nark suppressions add --fingerprint <hash> --reason "handled by middleware"

# Find and remove stale suppressions
nark suppressions clean
```

### Other

```bash
# Initialize .nark/ config in a project
nark init

# Compact scan history (keeps triage decisions)
nark compact

# Get AI agent instructions (for Claude, Cursor, etc.)
nark --instructions-path
```

## Configuration File

Place a `.narkrc.yaml` in your project root to persist CLI options. CLI flags always override file values.

```yaml
# .narkrc.yaml

# Fail threshold: error | warning | info (default: error)
failThreshold: error

# Always exit 0 (report-only mode)
# reportOnly: false

# Output paths
output:
  json: .nark/latest.json
  sarif: .nark/results.sarif

# Exclude patterns
exclude:
  - '**/*.test.ts'
  - '**/node_modules/**'

# Include draft/in-development contracts
# includeDrafts: false
```

| Field | Description | Default |
|-------|-------------|---------|
| `tsconfig` | Path to tsconfig.json | `./tsconfig.json` |
| `corpus` | Path to corpus directory | auto-detected |
| `failThreshold` | Severity that triggers exit `1` (`error`\|`warning`\|`info`) | `error` |
| `reportOnly` | Always exit `0` regardless of violations | `false` |
| `output.json` | Custom path for JSON audit record | auto |
| `output.sarif` | Custom path for SARIF output | none |
| `include` | Glob patterns to restrict analyzed files | all `.ts` |
| `exclude` | Glob patterns to exclude | none |
| `includeDrafts` | Include draft contracts | `false` |
| `includeTests` | Include test files | `false` |
| `includeDeprecated` | Include deprecated contracts | `false` |
| `telemetry` | Telemetry enabled | `true` |

## AI Agent Integration

nark includes `FORAIAGENTS.md` — a machine-readable instruction file that teaches AI agents how to interpret and fix violations. Point your agent at it:

```bash
# Get the path to the instructions file
nark --instructions-path

# Or reference in your AI config
# Claude Code: add to CLAUDE.md
# Cursor: add to .cursorrules
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Clean scan — no violations at or above the fail threshold |
| `1` | Violations found at or above `--fail-threshold` (default: `error`) |
| `2` | Internal error (bad tsconfig, missing corpus, etc.) |

Use `--report-only` to always get `0`, or `--fail-threshold warning` to block on warnings too.

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--tsconfig <path>` | Path to tsconfig.json | `./tsconfig.json` |
| `--corpus <path>` | Path to corpus directory | bundled |
| `--output <path>` | Output path for audit JSON | auto-generated |
| `--project <path>` | Project root for package.json discovery | cwd |
| `--no-terminal` | Disable terminal output (JSON only) | false |
| `--report-only` | Always exit 0 (never block CI) | false |
| `--fail-threshold <level>` | Exit 1 if violations at/above this severity | `error` |
| `--fail-on-warnings` | Shorthand for `--fail-threshold warning` | false |
| `--sarif` | Write SARIF 2.1.0 to `.nark/results.sarif` | false |
| `--sarif-output <file>` | Write SARIF to a custom path | — |
| `--verbose` | Emit progress checkpoints to stderr | false |
| `--include-tests` | Include test files | false |
| `--include-drafts` | Include draft contracts | false |
| `--show-suppressions` | Show suppressed violations | false |
| `--check-dead-suppressions` | Report stale suppressions | false |
| `--fail-on-dead-suppressions` | Exit non-zero on stale suppressions | false |

## Building from Source

```bash
# Clone both repos (corpus is needed for scanning, not for building)
git clone https://github.com/nark-sh/nark.git
git clone https://github.com/nark-sh/nark-corpus.git

cd nark
npm install
npm run build
npm test
```

Requires Node.js >= 18.

## Corpus

The contract library ([nark-corpus](https://github.com/nark-sh/nark-corpus)) includes 169+ contracts covering packages like:

- **HTTP:** axios, got, node-fetch, undici, superagent
- **Databases:** prisma, knex, sequelize, typeorm, drizzle, pg, mysql2, better-sqlite3
- **Cloud:** aws-sdk, @google-cloud/*, @azure/*
- **Auth:** jsonwebtoken, bcrypt, passport, @clerk/*, @auth0/*
- **Queues:** bullmq, amqplib, kafkajs
- **AI:** openai, @anthropic-ai/sdk, @langchain/*
- **And 100+ more...**

## License

AGPL-3.0 — see [LICENSE](./LICENSE) for details. Free for local use, CI/CD, and self-hosting. SaaS providers must open-source modifications or obtain a commercial license.
