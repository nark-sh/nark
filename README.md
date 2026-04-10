# nark

**Contract coverage scanner for npm packages — find missing error handling before production.**

nark scans your TypeScript codebase against a curated library of 169+ behavioral contracts to find places where error handling is missing. Think of it as a linter, but for runtime failure modes — unhandled promise rejections, missing `.on('error')` listeners, uncaught API exceptions.

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

## AI Agent Integration

nark includes `FORAIAGENTS.md` — a machine-readable instruction file that teaches AI agents how to interpret and fix violations. Point your agent at it:

```bash
# Get the path to the instructions file
nark --instructions-path

# Or reference in your AI config
# Claude Code: add to CLAUDE.md
# Cursor: add to .cursorrules
```

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--tsconfig <path>` | Path to tsconfig.json | `./tsconfig.json` |
| `--corpus <path>` | Path to corpus directory | bundled |
| `--output <path>` | Output path for audit JSON | auto-generated |
| `--project <path>` | Project root for package.json discovery | cwd |
| `--no-terminal` | Disable terminal output (JSON only) | false |
| `--fail-on-warnings` | Exit non-zero on warnings | false |
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

MIT
