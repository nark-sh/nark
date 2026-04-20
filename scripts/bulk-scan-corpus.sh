#!/bin/bash
# Bulk scan all repos in corpus-builder/active/ (6,974 repos).
# Run from the nark directory: ./scripts/bulk-scan-corpus.sh
#
# Prerequisites:
#   - npm run build (local dist/index.js must exist)
#   - nark auth login (token at ~/.nark/credentials for enriched telemetry)

set -uo pipefail

# macOS doesn't have GNU timeout — use perl fallback
if command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout"
else
  # Perl-based timeout fallback for macOS
  run_with_timeout() {
    local secs="$1"; shift
    perl -e '
      alarm shift @ARGV;
      $SIG{ALRM} = sub { kill 9, $pid; exit 124 };
      $pid = fork // die;
      unless ($pid) { exec @ARGV; die "exec: $!" }
      waitpid $pid, 0;
      exit ($? >> 8);
    ' "$secs" "$@"
  }
  TIMEOUT_CMD="run_with_timeout"
fi

NARK_BIN="$(pwd)/dist/index.js"
REPOS_DIR="/Users/calebgates/WebstormProjects/behavioral-contracts/corpus-builder/active"
RESULTS_DIR="output/$(date +%Y%m%d)-corpus-bulk"
TIMEOUT_SECS=300
ERRORS_FILE="$RESULTS_DIR/ERRORS.txt"

# Validate nark build exists
if [ ! -f "$NARK_BIN" ]; then
  echo "ERROR: dist/index.js not found. Run 'npm run build' first."
  exit 1
fi

# Validate repos directory exists
if [ ! -d "$REPOS_DIR" ]; then
  echo "ERROR: $REPOS_DIR does not exist."
  exit 1
fi

mkdir -p "$RESULTS_DIR"
> "$ERRORS_FILE"

TOTAL=0
SCANNED=0
SKIPPED=0
ERRORS=0
TIMEOUTS=0

echo "Bulk corpus scan started: $(date)"
echo "Repos dir: $REPOS_DIR"
echo "Results:   $RESULTS_DIR"
echo "Timeout:   ${TIMEOUT_SECS}s per repo"
echo "---"

for repo_dir in "$REPOS_DIR"/*/; do
  [ -d "$repo_dir" ] || continue
  repo_name=$(basename "$repo_dir")
  TOTAL=$((TOTAL + 1))

  # Clean any existing .nark/ artifacts before scanning
  rm -rf "$repo_dir/.nark"

  # Find tsconfig — check common locations
  TSCONFIG=""
  for candidate in \
    "$repo_dir/tsconfig.json" \
    "$repo_dir/tsconfig.build.json" \
    "$repo_dir/tsconfig.base.json" \
    "$repo_dir/tsconfig.app.json"; do
    if [ -f "$candidate" ]; then
      TSCONFIG="$candidate"
      break
    fi
  done

  if [ -z "$TSCONFIG" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  AUDIT_FILE="$RESULTS_DIR/${repo_name}-audit.json"

  echo -n "[$TOTAL] $repo_name... "

  # Run with timeout, capture exit code
  set +e
  if [ "$TIMEOUT_CMD" = "run_with_timeout" ]; then
    run_with_timeout "$TIMEOUT_SECS" node "$NARK_BIN" \
      --tsconfig "$TSCONFIG" \
      --json \
      --output "$AUDIT_FILE" \
      > /dev/null 2>&1
  else
    $TIMEOUT_CMD "$TIMEOUT_SECS" node "$NARK_BIN" \
      --tsconfig "$TSCONFIG" \
      --json \
      --output "$AUDIT_FILE" \
      > /dev/null 2>&1
  fi
  EXIT_CODE=$?
  set -e

  if [ $EXIT_CODE -eq 124 ]; then
    echo "TIMEOUT"
    echo "TIMEOUT $repo_name" >> "$ERRORS_FILE"
    TIMEOUTS=$((TIMEOUTS + 1))
    continue
  elif [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 1 ]; then
    echo "ERROR (exit $EXIT_CODE)"
    echo "ERROR $repo_name (exit $EXIT_CODE)" >> "$ERRORS_FILE"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Quick status from audit file
  if [ -f "$AUDIT_FILE" ]; then
    echo "OK"
    SCANNED=$((SCANNED + 1))
  else
    echo "NO OUTPUT"
    echo "NO_OUTPUT $repo_name (exit $EXIT_CODE)" >> "$ERRORS_FILE"
    ERRORS=$((ERRORS + 1))
  fi

  # Progress report every 100 repos
  if [ $((TOTAL % 100)) -eq 0 ]; then
    echo "--- Progress: $TOTAL processed, $SCANNED scanned, $SKIPPED skipped ---"
  fi
done

echo ""
echo "=== BULK CORPUS SCAN COMPLETE ==="
echo "Total repos:   $TOTAL"
echo "Scanned OK:    $SCANNED"
echo "Skipped:       $SKIPPED (no tsconfig)"
echo "Timeouts:      $TIMEOUTS"
echo "Errors:        $ERRORS"
echo "Completed:     $(date)"
echo ""
echo "Results: $RESULTS_DIR/"
echo "Run: node scripts/rank-results.js $RESULTS_DIR"
