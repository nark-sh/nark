#!/usr/bin/env node
/**
 * scan-progress.js — Live progress view for bulk scan (reads local JSON files)
 *
 * Usage:
 *   node scripts/scan-progress.js [results-dir]
 *
 * Defaults to today's corpus-bulk dir if no arg given.
 */

const fs = require('fs');
const path = require('path');

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const resultsDir = process.argv[2] || path.join(__dirname, '..', 'output', `${today}-corpus-bulk`);
const errorsFile = path.join(resultsDir, 'ERRORS.txt');
const TOTAL_REPOS = 6974;

if (!fs.existsSync(resultsDir)) {
  console.error(`No results dir found: ${resultsDir}`);
  console.error('Is the bulk scan running?');
  process.exit(1);
}

// Count audit JSON files
const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('-audit.json'));
const scanned = files.length;
const pct = ((scanned / TOTAL_REPOS) * 100).toFixed(1);

// Parse errors file
let timeouts = 0;
let errors = 0;
let noOutput = 0;
if (fs.existsSync(errorsFile)) {
  const lines = fs.readFileSync(errorsFile, 'utf-8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('TIMEOUT')) timeouts++;
    else if (line.startsWith('NO_OUTPUT')) noOutput++;
    else if (line.startsWith('ERROR')) errors++;
  }
}

// Quick violation stats from JSON files (sample last 50 for speed)
const recentFiles = files.slice(-50);
let totalViolations = 0;
let reposWithViolations = 0;
const pkgCounts = {};

for (const file of recentFiles) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf-8'));
    const violations = data.violations || [];
    if (violations.length > 0) {
      reposWithViolations++;
      totalViolations += violations.length;
    }
    for (const v of violations) {
      const pkg = v.package || v.packageName || v.contract || v.contractId || 'unknown';
      pkgCounts[pkg] = (pkgCounts[pkg] || 0) + 1;
    }
  } catch {}
}

// Top packages
const topPkgs = Object.entries(pkgCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);

// Estimate time remaining based on file timestamps
let eta = '—';
if (files.length >= 10) {
  // Use 10th file as start to avoid skew from previous run's stale files
  const startIdx = Math.max(0, files.length - 50);
  const startFile = files[startIdx];
  const lastFile = files[files.length - 1];
  const firstTime = fs.statSync(path.join(resultsDir, startFile)).mtimeMs;
  const lastTime = fs.statSync(path.join(resultsDir, lastFile)).mtimeMs;
  const elapsed = lastTime - firstTime;
  const span = files.length - 1 - startIdx;
  const perRepo = span > 0 ? elapsed / span : 0;
  const remaining = perRepo > 0 ? (TOTAL_REPOS - scanned) * perRepo : 0;
  const remainMin = Math.max(0, Math.round(remaining / 60000));
  if (remainMin < 60) {
    eta = `~${remainMin}m`;
  } else {
    const hrs = Math.floor(remainMin / 60);
    const mins = remainMin % 60;
    eta = `~${hrs}h ${mins}m`;
  }
}

// Output
console.log('');
console.log('=== BULK SCAN PROGRESS ===');
console.log('');
const bar = '█'.repeat(Math.round(scanned / TOTAL_REPOS * 40)) + '░'.repeat(40 - Math.round(scanned / TOTAL_REPOS * 40));
console.log(`  [${bar}] ${pct}%`);
console.log(`  ${scanned} / ${TOTAL_REPOS} repos scanned    ETA: ${eta}`);
console.log('');
console.log(`  OK:        ${scanned}`);
console.log(`  Errors:    ${errors}`);
console.log(`  Timeouts:  ${timeouts}`);
console.log(`  No output: ${noOutput}`);
console.log('');
console.log(`  --- Last ${recentFiles.length} repos ---`);
console.log(`  Repos with violations: ${reposWithViolations}/${recentFiles.length}`);
console.log(`  Total violations: ${totalViolations}`);
console.log('');
if (topPkgs.length > 0) {
  console.log('  Top packages:');
  for (const [pkg, count] of topPkgs) {
    console.log(`    ${pkg.padEnd(30)} ${count}`);
  }
}
console.log('');
