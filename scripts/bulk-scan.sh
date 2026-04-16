#!/bin/bash
# Bulk scan all test-repos/ and rank by violations.
# Run from the nark directory: ./scripts/bulk-scan.sh

set -euo pipefail

# macOS doesn't have GNU timeout — use perl fallback
if command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout"
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

WORKSPACE_ROOT="$(cd ../.. && pwd)"
RESULTS_DIR="output/$(date +%Y%m%d)-bulk"
CORPUS_PATH="../nark-corpus"
SUMMARY_FILE="$RESULTS_DIR/SUMMARY.txt"

mkdir -p "$RESULTS_DIR"

# Clear previous run artifacts
rm -f "$RESULTS_DIR/crashes.txt" "$RESULTS_DIR/ranked.txt"

echo "Bulk scan started: $(date)" | tee "$SUMMARY_FILE"
echo "Results: $RESULTS_DIR" | tee -a "$SUMMARY_FILE"
echo "---" | tee -a "$SUMMARY_FILE"

SCANNED=0
SKIPPED=0
CRASHED=0
TOTAL_VIOLATIONS=0

for repo in "$WORKSPACE_ROOT"/test-repos/*/; do
  name=$(basename "$repo")

  # Find tsconfig (auto-discovery order)
  tsconfig=""
  for candidate in \
    "$repo/tsconfig.json" \
    "$repo/tsconfig.build.json"; do
    if [ -f "$candidate" ]; then
      tsconfig="$candidate"
      break
    fi
  done

  if [ -z "$tsconfig" ]; then
    echo "SKIP $name (no tsconfig)" | tee -a "$SUMMARY_FILE"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo -n "Scanning $name... "

  # Run with 90s timeout, capture output
  set +e
  if [ "$TIMEOUT_CMD" = "run_with_timeout" ]; then
    run_with_timeout 90 node dist/index.js \
      --tsconfig "$tsconfig" \
      --corpus "$CORPUS_PATH" \
      --report-only \
      --no-terminal \
      --output "$RESULTS_DIR/$name-audit.json" \
      > "$RESULTS_DIR/$name-output.txt" 2>&1
  else
    $TIMEOUT_CMD 90 node dist/index.js \
      --tsconfig "$tsconfig" \
      --corpus "$CORPUS_PATH" \
      --report-only \
      --no-terminal \
      --output "$RESULTS_DIR/$name-audit.json" \
      > "$RESULTS_DIR/$name-output.txt" 2>&1
  fi
  EXIT_CODE=$?
  set -e

  if [ $EXIT_CODE -eq 124 ]; then
    echo "TIMEOUT" | tee -a "$SUMMARY_FILE"
    echo "TIMEOUT $name" >> "$RESULTS_DIR/crashes.txt"
    CRASHED=$((CRASHED + 1))
    continue
  elif [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 1 ]; then
    echo "CRASH (exit $EXIT_CODE)" | tee -a "$SUMMARY_FILE"
    echo "CRASH $name (exit $EXIT_CODE)" >> "$RESULTS_DIR/crashes.txt"
    CRASHED=$((CRASHED + 1))
    continue
  fi

  # Extract violation count from audit JSON
  if [ -f "$RESULTS_DIR/$name-audit.json" ]; then
    VIOLATIONS=$(python3 -c "
import json, sys
try:
    with open('$RESULTS_DIR/$name-audit.json') as f:
        d = json.load(f)
    print(d.get('summary', {}).get('total_violations', 0))
except:
    print(0)
" 2>/dev/null || echo "0")
  else
    VIOLATIONS=0
  fi

  echo "$VIOLATIONS violations"
  echo "$VIOLATIONS $name" >> "$RESULTS_DIR/ranked.txt"
  SCANNED=$((SCANNED + 1))
  TOTAL_VIOLATIONS=$((TOTAL_VIOLATIONS + VIOLATIONS))
done

echo "" | tee -a "$SUMMARY_FILE"
echo "=== RESULTS ===" | tee -a "$SUMMARY_FILE"
echo "Scanned: $SCANNED" | tee -a "$SUMMARY_FILE"
echo "Skipped: $SKIPPED" | tee -a "$SUMMARY_FILE"
echo "Crashed: $CRASHED" | tee -a "$SUMMARY_FILE"
echo "Total violations: $TOTAL_VIOLATIONS" | tee -a "$SUMMARY_FILE"

# Sort by violation count
if [ -f "$RESULTS_DIR/ranked.txt" ]; then
  echo "" | tee -a "$SUMMARY_FILE"
  echo "=== TOP REPOS BY VIOLATIONS ===" | tee -a "$SUMMARY_FILE"
  sort -rn "$RESULTS_DIR/ranked.txt" | head -20 | tee -a "$SUMMARY_FILE"
fi

if [ -f "$RESULTS_DIR/crashes.txt" ]; then
  echo "" | tee -a "$SUMMARY_FILE"
  echo "=== CRASHES ===" | tee -a "$SUMMARY_FILE"
  cat "$RESULTS_DIR/crashes.txt" | tee -a "$SUMMARY_FILE"
fi

echo "" | tee -a "$SUMMARY_FILE"
echo "Bulk scan complete: $(date)" | tee -a "$SUMMARY_FILE"
