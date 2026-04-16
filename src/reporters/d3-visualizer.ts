/**
 * Nark HTML Report Generator — Light mode, SaaS share-page inspired
 *
 * Matches the behavioral-contracts-saas light theme:
 * - bg: #FAFAF9, card: #FFFFFF, border: #DFE1E6, text: #172B4D
 * - Code snippets with amber left-border, expand/collapse per violation
 * - No external JS dependencies
 */

import * as fs from 'fs';
import type { AuditRecord, EnhancedAuditRecord, Violation } from '../types.js';
import type { HealthMetrics } from './health-score.js';
import type { PackageBreakdownSummary } from './package-breakdown.js';
import type { ComparisonMetrics, BenchmarkData } from './benchmarking.js';

export interface D3VisualizationData {
  audit: AuditRecord | EnhancedAuditRecord;
  health: HealthMetrics;
  packageBreakdown: PackageBreakdownSummary;
  benchmarking?: ComparisonMetrics;
  benchmark?: BenchmarkData;
}

/** Read source lines around a violation for the code snippet */
function readCodeSnippet(filePath: string, line: number, context: number = 3): Array<{ line: number; content: string; highlighted: boolean }> | null {
  try {
    const src = fs.readFileSync(filePath, 'utf-8');
    const lines = src.split('\n');
    const start = Math.max(0, line - 1 - context);
    const end = Math.min(lines.length, line + context);
    const result: Array<{ line: number; content: string; highlighted: boolean }> = [];
    for (let i = start; i < end; i++) {
      result.push({ line: i + 1, content: lines[i], highlighted: i + 1 === line });
    }
    return result;
  } catch {
    return null;
  }
}

export function generateD3Dashboard(data: D3VisualizationData): string {
  const { audit, packageBreakdown } = data;

  const repoName = extractRepoName(audit.tsconfig);
  const timestamp = new Date(audit.timestamp).toLocaleString();
  const commitSha = audit.git_commit ? audit.git_commit.slice(0, 7) : null;
  const branch = audit.git_branch || null;

  const errors = audit.violations.filter(v => v.severity === 'error');
  const warnings = audit.violations.filter(v => v.severity === 'warning');
  const totalViolations = errors.length + warnings.length;

  const tsconfigDir = audit.tsconfig.replace(/[/\\][^/\\]+$/, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nark Report — ${esc(repoName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #FAFAF9;
      --bg-card: #FFFFFF;
      --bg-hover: #F4F5F7;
      --bg-muted: #F4F5F7;
      --border: #DFE1E6;
      --border-active: #C1C7D0;
      --text: #172B4D;
      --text-secondary: #44546F;
      --text-muted: #6B778C;
      --brand: #8B5CF6;
      --brand-light: rgba(139, 92, 246, 0.08);
      --error: #FF5630;
      --error-light: rgba(255, 86, 48, 0.1);
      --warning: #FFAB00;
      --warning-light: rgba(255, 171, 0, 0.12);
      --success: #36B37E;
      --success-light: rgba(54, 179, 126, 0.1);
      --amber-border: rgba(245, 158, 11, 0.4);
      --amber-bg: rgba(245, 158, 11, 0.06);
      --amber-highlight: rgba(245, 158, 11, 0.1);
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      line-height: 1.5;
    }

    /* Sticky Header */
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 10;
      height: 48px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
    }

    .top-bar-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .top-bar-left .repo-name { font-size: 13px; font-weight: 600; white-space: nowrap; }

    .top-bar-left .meta-item {
      font-size: 11px;
      color: var(--text-muted);
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      white-space: nowrap;
    }

    .top-bar-left .separator { color: var(--border); font-size: 11px; }

    .cta-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--brand);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      text-decoration: none;
      transition: opacity 0.15s;
    }
    .cta-btn:hover { opacity: 0.9; }

    .content { max-width: 960px; margin: 0 auto; padding: 24px; }

    /* Stat Strip */
    .stat-strip {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 20px 0;
      margin-bottom: 8px;
    }

    .stat-strip .big-num { font-size: 28px; font-weight: 700; line-height: 1; }
    .stat-strip .big-num.error { color: var(--error); }
    .stat-strip .big-num.warning { color: #B47500; }
    .stat-strip .big-num.success { color: var(--success); }

    .stat-strip .big-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 500;
    }

    .stat-strip .divider { width: 1px; height: 32px; background: var(--border); }
    .stat-strip .stat-group { display: flex; flex-direction: column; align-items: center; }

    .stat-strip .meta-stats {
      display: flex;
      gap: 16px;
      margin-left: auto;
      font-size: 12px;
      color: var(--text-muted);
    }

    /* Section Headers */
    .section-header {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      padding: 12px 0 8px;
      border-bottom: 1px solid var(--border);
    }

    /* Filter Bar */
    .filter-bar { display: flex; gap: 6px; padding: 10px 0; }

    .filter-btn {
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      font-family: inherit;
    }
    .filter-btn:hover { border-color: var(--border-active); color: var(--text-secondary); }
    .filter-btn.active { border-color: var(--brand); color: var(--brand); background: var(--brand-light); }

    /* Violation Rows */
    .violation-list { list-style: none; }

    .v-row {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 6px;
      background: var(--bg-card);
      transition: border-color 0.15s;
      overflow: hidden;
    }
    .v-row:hover { border-color: var(--border-active); }

    .v-row-main {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
    }

    .severity-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .severity-badge.error { background: var(--error-light); color: var(--error); }
    .severity-badge.warning { background: var(--warning-light); color: #B47500; }

    .v-pkg {
      font-size: 11px;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      color: var(--brand);
      flex-shrink: 0;
    }

    .v-body { flex: 1; min-width: 0; }

    .v-msg { font-size: 12px; color: var(--text); line-height: 1.4; }

    .v-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 3px;
    }

    .v-file {
      font-size: 11px;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .v-file a { color: var(--text-muted); text-decoration: none; }
    .v-file a:hover { text-decoration: underline; color: var(--brand); }

    .v-fn { font-size: 11px; color: var(--text-muted); opacity: 0.7; }

    /* Code expand toggle */
    .v-expand-btn {
      font-size: 10px;
      color: var(--brand);
      cursor: pointer;
      background: none;
      border: none;
      font-family: inherit;
      font-weight: 500;
      padding: 0;
      margin-left: auto;
      flex-shrink: 0;
    }
    .v-expand-btn:hover { text-decoration: underline; }

    /* Code Snippet */
    .v-code {
      display: none;
      border-top: 1px solid var(--border);
      border-left: 4px solid var(--amber-border);
      background: var(--bg-muted);
      overflow-x: auto;
    }
    .v-code.open { display: block; }

    .code-line {
      display: flex;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 11px;
      line-height: 1.6;
    }
    .code-line.highlighted { background: var(--amber-highlight); }
    .code-line:hover { background: var(--amber-bg); }

    .line-num {
      min-width: 44px;
      padding: 0 8px;
      text-align: right;
      color: var(--text-muted);
      user-select: none;
      flex-shrink: 0;
      opacity: 0.6;
    }
    .code-line.highlighted .line-num {
      background: rgba(245, 158, 11, 0.15);
      opacity: 1;
    }

    .line-content {
      padding: 0 12px 0 8px;
      white-space: pre;
      color: var(--text);
    }

    /* Packages */
    .pkg-section { margin-top: 32px; }

    .pkg-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .pkg-table th {
      text-align: left;
      padding: 8px 12px;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border);
    }
    .pkg-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--text-secondary); }
    .pkg-table tbody tr:hover { background: var(--bg-hover); }
    .pkg-table .pkg-name { font-weight: 600; color: var(--text); }
    .pkg-table .num-cell { text-align: center; }
    .pkg-table .error-cell { color: var(--error); font-weight: 600; }

    .clean-section {
      margin-top: 8px;
      border: 1px solid var(--border);
      border-left: 3px solid var(--success);
      border-radius: 4px;
      overflow: hidden;
    }
    .clean-header {
      padding: 10px 12px;
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-card);
    }
    .clean-header:hover { background: var(--bg-hover); }
    .clean-toggle { font-size: 10px; color: var(--text-muted); transition: transform 0.15s; }
    .clean-toggle.open { transform: rotate(90deg); }
    .clean-body { display: none; padding: 0 12px 8px; background: var(--bg-card); }
    .clean-body.open { display: block; }
    .clean-pkg { padding: 4px 0; font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
    .clean-pkg .check { color: var(--success); font-size: 11px; }

    /* Upsell */
    .upsell {
      margin-top: 32px;
      padding: 16px 20px;
      border: 1px solid rgba(139, 92, 246, 0.2);
      border-radius: 6px;
      background: var(--brand-light);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .upsell-text { font-size: 12px; color: var(--text-secondary); }
    .upsell-text strong { color: var(--text); }
    .upsell .cta-btn { flex-shrink: 0; }

    .clean-banner {
      text-align: center;
      padding: 40px 20px;
      color: var(--success);
      font-size: 14px;
      font-weight: 500;
    }
    .clean-banner .big-check { font-size: 32px; margin-bottom: 8px; }

    .footer {
      text-align: center;
      padding: 32px 0 24px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .footer a { color: var(--text-muted); text-decoration: none; }
    .footer a:hover { color: var(--brand); }

    @media (max-width: 768px) {
      .top-bar { padding: 0 12px; }
      .content { padding: 16px; }
      .stat-strip { flex-wrap: wrap; }
      .stat-strip .meta-stats { margin-left: 0; width: 100%; }
      .v-row-main { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="top-bar-left">
      <span class="repo-name">${esc(repoName)}</span>
      ${commitSha ? `<span class="separator">&middot;</span><span class="meta-item">${commitSha}</span>` : ''}
      ${branch ? `<span class="separator">&middot;</span><span class="meta-item">${esc(branch)}</span>` : ''}
      <span class="separator">&middot;</span>
      <span class="meta-item" style="font-family: inherit;">${timestamp}</span>
    </div>
    <div class="top-bar-right">
      <a class="cta-btn" href="https://app.nark.sh" target="_blank">Get hosted reports &rarr;</a>
    </div>
  </div>

  <div class="content">
    <div class="stat-strip">
      ${totalViolations === 0 ? `
        <div class="stat-group">
          <div class="big-num success">0</div>
          <div class="big-label">Violations</div>
        </div>
      ` : `
        <div class="stat-group">
          <div class="big-num error">${errors.length}</div>
          <div class="big-label">Error${errors.length === 1 ? '' : 's'}</div>
        </div>
        <div class="divider"></div>
        <div class="stat-group">
          <div class="big-num warning">${warnings.length}</div>
          <div class="big-label">Warning${warnings.length === 1 ? '' : 's'}</div>
        </div>
      `}
      <div class="meta-stats">
        <span>${audit.files_analyzed} files scanned</span>
        <span>&middot;</span>
        <span>${packageBreakdown.packagesWithContracts} packages matched</span>
      </div>
    </div>

    ${totalViolations === 0 ? `
      <div class="clean-banner">
        <div class="big-check">&#10003;</div>
        All ${packageBreakdown.packagesWithContracts} matched packages are compliant — no violations found.
      </div>
    ` : `
      <div class="section-header">Violations (${totalViolations})</div>
      <div class="filter-bar">
        <button class="filter-btn active" onclick="filterViolations('all')">All (${totalViolations})</button>
        ${errors.length > 0 ? `<button class="filter-btn" onclick="filterViolations('error')">Errors (${errors.length})</button>` : ''}
        ${warnings.length > 0 ? `<button class="filter-btn" onclick="filterViolations('warning')">Warnings (${warnings.length})</button>` : ''}
      </div>
      <ul class="violation-list">
        ${generateViolationRows(audit.violations, tsconfigDir)}
      </ul>
    `}

    <div class="pkg-section">
      <div class="section-header">Packages</div>
      ${generatePackagesHTML(packageBreakdown)}
    </div>

    <div class="upsell">
      <div class="upsell-text">
        <strong>Want shareable links, scan history, and team dashboards?</strong><br>
        Add your API key to get hosted reports on app.nark.sh.
      </div>
      <a class="cta-btn" href="https://app.nark.sh" target="_blank">Sign up free &rarr;</a>
    </div>

    <div class="footer">
      Generated by <a href="https://nark.sh">Nark</a> &middot; ${timestamp}
    </div>
  </div>

  <script>
    function filterViolations(severity) {
      document.querySelectorAll('.v-row').forEach(function(row) {
        if (severity === 'all') { row.style.display = ''; }
        else { row.style.display = row.dataset.severity === severity ? '' : 'none'; }
      });
      document.querySelectorAll('.filter-btn').forEach(function(btn) {
        var t = btn.textContent.toLowerCase();
        btn.classList.toggle('active', severity === 'all' ? t.startsWith('all') : t.startsWith(severity));
      });
    }

    function toggleCode(id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle('open');
    }

    function toggleClean(id) {
      var body = document.getElementById(id);
      var toggle = document.getElementById(id + '-toggle');
      if (body) { body.classList.toggle('open'); if (toggle) toggle.classList.toggle('open'); }
    }
  </script>
</body>
</html>`;
}

function generateViolationRows(violations: Violation[], tsconfigDir: string): string {
  const filtered = violations.filter(v => v.severity === 'error' || v.severity === 'warning');

  const sorted = [...filtered].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if (a.package !== b.package) return a.package.localeCompare(b.package);
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  return sorted.map((v, idx) => {
    let relFile = v.file;
    if (v.file.startsWith(tsconfigDir)) {
      relFile = v.file.slice(tsconfigDir.length + 1);
    }
    const vscodeLink = `vscode://file${v.file}:${v.line}:${v.column}`;
    const desc = v.description.length > 150 ? v.description.slice(0, 147) + '...' : v.description;
    const codeId = `code-${idx}`;

    // Read source code snippet
    const snippet = readCodeSnippet(v.file, v.line, 3);
    const codeHtml = snippet ? snippet.map(l =>
      `<div class="code-line${l.highlighted ? ' highlighted' : ''}"><span class="line-num">${l.line}</span><span class="line-content">${esc(l.content)}</span></div>`
    ).join('') : '';

    return `<li class="v-row" data-severity="${v.severity}" data-package="${esc(v.package)}">
          <div class="v-row-main">
            <span class="severity-badge ${v.severity}">${v.severity}</span>
            <span class="v-pkg">${esc(v.package)}</span>
            <div class="v-body">
              <div class="v-msg">${esc(desc)}</div>
              <div class="v-meta">
                <span class="v-file"><a href="${vscodeLink}" title="Open in VS Code">${esc(relFile)}:${v.line}</a></span>
                <span class="v-fn">${esc(v.function)}()</span>
              </div>
            </div>
            ${codeHtml ? `<button class="v-expand-btn" onclick="toggleCode('${codeId}')">code &darr;</button>` : ''}
          </div>
          ${codeHtml ? `<div class="v-code" id="${codeId}">${codeHtml}</div>` : ''}
        </li>`;
  }).join('\n');
}

function generatePackagesHTML(breakdown: PackageBreakdownSummary): string {
  const withViolations = breakdown.packages.filter(p => p.violationsFound > 0);
  const clean = breakdown.packages.filter(p => p.violationsFound === 0);

  let html = '';

  if (withViolations.length > 0) {
    const rows = withViolations
      .sort((a, b) => b.violationsFound - a.violationsFound)
      .map(pkg => {
        const parts: string[] = [];
        if (pkg.violationBreakdown.errors > 0) parts.push(`<span style="color:var(--error)">${pkg.violationBreakdown.errors} errors</span>`);
        if (pkg.violationBreakdown.warnings > 0) parts.push(`<span style="color:#B47500">${pkg.violationBreakdown.warnings} warnings</span>`);
        return `<tr>
          <td class="pkg-name">${esc(pkg.packageName)}</td>
          <td class="num-cell">${!pkg.isEstimated && pkg.contractsApplied > 0 ? pkg.contractsApplied : '\u2014'}</td>
          <td class="num-cell error-cell">${pkg.violationsFound}</td>
          <td>${parts.join(', ')}</td>
        </tr>`;
      }).join('');

    html += `<table class="pkg-table" style="margin-top: 12px;">
        <thead><tr><th>Package</th><th class="num-cell">Call Sites</th><th class="num-cell">Violations</th><th>Breakdown</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  if (clean.length > 0) {
    const cleanItems = clean
      .sort((a, b) => a.packageName.localeCompare(b.packageName))
      .map(p => `<div class="clean-pkg"><span class="check">&#10003;</span> ${esc(p.packageName)}</div>`)
      .join('');

    html += `<div class="clean-section">
        <div class="clean-header" onclick="toggleClean('clean-pkgs')">
          <span class="clean-toggle" id="clean-pkgs-toggle">&#9654;</span>
          ${clean.length} package${clean.length === 1 ? '' : 's'} with contracts — 0 violations
        </div>
        <div class="clean-body" id="clean-pkgs">${cleanItems}</div>
      </div>`;
  }

  return html;
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractRepoName(tsconfigPath: string): string {
  const parts = tsconfigPath.split('/');
  const repoIndex = parts.findIndex(p => p === 'test-repos') + 1;
  if (repoIndex > 0 && repoIndex < parts.length) return parts[repoIndex];
  return parts[parts.length - 2] || 'Unknown Repository';
}

export async function writeD3Visualization(
  data: D3VisualizationData,
  outputPath: string
): Promise<void> {
  const { writeFile } = await import('fs/promises');
  const html = generateD3Dashboard(data);
  await writeFile(outputPath, html, 'utf-8');
}
