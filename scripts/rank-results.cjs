#!/usr/bin/env node
/**
 * rank-results.js — Parse bulk scan JSON results and produce RANKED.md
 *
 * Usage:
 *   node scripts/rank-results.js output/YYYYMMDD-corpus-bulk/
 *
 * Output:
 *   <results-dir>/RANKED.md — Markdown table sorted by error count DESC
 *   <results-dir>/RANKED.json — Machine-readable ranked data
 */

const fs = require('fs');
const path = require('path');

const resultsDir = process.argv[2];

if (!resultsDir) {
  console.error('Usage: node scripts/rank-results.js <results-dir>');
  console.error('Example: node scripts/rank-results.js output/20260420-corpus-bulk/');
  process.exit(1);
}

if (!fs.existsSync(resultsDir)) {
  console.error(`ERROR: Directory not found: ${resultsDir}`);
  process.exit(1);
}

// Find all audit JSON files
const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('-audit.json'));

if (files.length === 0) {
  console.error(`ERROR: No *-audit.json files found in ${resultsDir}`);
  process.exit(1);
}

console.log(`Parsing ${files.length} audit files...`);

const results = [];

for (const file of files) {
  const filePath = path.join(resultsDir, file);
  const repoName = file.replace(/-audit\.json$/, '');

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    // Extract summary data — adapt to nark's output format
    const summary = data.summary || {};
    const violations = data.violations || [];

    // Count errors and warnings
    let errors = 0;
    let warnings = 0;
    const packagesHit = new Set();

    for (const v of violations) {
      const severity = (v.severity || v.level || '').toLowerCase();
      if (severity === 'error') {
        errors++;
      } else if (severity === 'warning' || severity === 'warn') {
        warnings++;
      } else {
        // Default to error if no severity specified
        errors++;
      }
      if (v.package || v.packageName || v.contract || v.contractId) {
        packagesHit.add(v.package || v.packageName || v.contract || v.contractId);
      }
    }

    // Fallback: use summary fields if violations array parsing yielded nothing
    if (errors === 0 && warnings === 0 && summary.total_violations) {
      errors = summary.total_violations || 0;
    }
    if (errors === 0 && warnings === 0 && summary.totalViolations) {
      errors = summary.totalViolations || 0;
    }

    const score = summary.score ?? summary.overallScore ?? null;

    results.push({
      repo: repoName,
      errors,
      warnings,
      total: errors + warnings,
      score,
      packages: Array.from(packagesHit),
    });
  } catch (err) {
    // Skip malformed JSON
    console.warn(`  WARN: Could not parse ${file}: ${err.message}`);
  }
}

// Sort by errors DESC, then warnings DESC
results.sort((a, b) => {
  if (b.errors !== a.errors) return b.errors - a.errors;
  if (b.warnings !== a.warnings) return b.warnings - a.warnings;
  return (a.score ?? 999) - (b.score ?? 999);
});

// Write RANKED.json
const rankedJsonPath = path.join(resultsDir, 'RANKED.json');
fs.writeFileSync(rankedJsonPath, JSON.stringify(results, null, 2));
console.log(`Wrote ${rankedJsonPath}`);

// Write RANKED.md
const rankedMdPath = path.join(resultsDir, 'RANKED.md');
const lines = [];

lines.push('# Bulk Scan Results — Ranked by Errors');
lines.push('');
lines.push(`**Total repos scanned:** ${results.length}`);
lines.push(`**Repos with violations:** ${results.filter(r => r.total > 0).length}`);
lines.push(`**Generated:** ${new Date().toISOString().split('T')[0]}`);
lines.push('');
lines.push('| # | Repo | Errors | Warnings | Score | Packages Hit |');
lines.push('|---|------|--------|----------|-------|--------------|');

let rank = 0;
for (const r of results) {
  if (r.total === 0) break; // Stop listing repos with no violations
  rank++;
  const scoreStr = r.score !== null ? String(r.score) : '—';
  const pkgStr = r.packages.length > 0 ? r.packages.join(', ') : '—';
  lines.push(`| ${rank} | ${r.repo} | ${r.errors} | ${r.warnings} | ${scoreStr} | ${pkgStr} |`);
}

if (rank === 0) {
  lines.push('| — | No violations found in any repo | — | — | — | — |');
}

lines.push('');
lines.push('---');
lines.push('');
lines.push(`Total repos with zero violations: ${results.filter(r => r.total === 0).length}`);
lines.push('');

fs.writeFileSync(rankedMdPath, lines.join('\n'));
console.log(`Wrote ${rankedMdPath}`);
console.log('');
console.log(`Top 10:`);
results.slice(0, 10).forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.repo} — ${r.errors} errors, ${r.warnings} warnings${r.score !== null ? `, score: ${r.score}` : ''}`);
});
