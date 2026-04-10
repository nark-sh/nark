/**
 * D3.js Visualization Generator - Professional Sentry-Inspired Design
 *
 * Design principles (following .claude/rules/design-system.md):
 * - Clean, minimal, professional aesthetic
 * - Subtle color palette (dark grays, muted accents)
 * - Small fonts (12-14px), generous whitespace
 * - Sentry-like professionalism
 *
 * Color palette:
 * - Background: #0E1116 (dark)
 * - Cards: #1C1F26 (slightly lighter)
 * - Borders: #2D3139 (subtle)
 * - Text: #E6EDF3 (light gray)
 * - Muted: #7D8590 (gray)
 * - Accent: #8B5CF6 (purple)
 * - Success: #3FB950 (green)
 * - Warning: #D29922 (amber)
 * - Error: #F85149 (red)
 */

import type { AuditRecord, EnhancedAuditRecord } from '../types.js';
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

/**
 * Generate interactive D3.js HTML dashboard
 */
export function generateD3Dashboard(data: D3VisualizationData): string {
  const { audit, health, packageBreakdown, benchmarking, benchmark } = data;

  // Extract repo name
  const repoName = extractRepoName(audit.tsconfig);
  const timestamp = new Date(audit.timestamp).toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Behavioral Contracts Analysis - ${repoName}</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      /* Sentry-inspired color palette */
      --bg-primary: #0E1116;
      --bg-secondary: #1C1F26;
      --bg-tertiary: #22252D;
      --border-primary: #2D3139;
      --border-secondary: #3D4149;
      --text-primary: #E6EDF3;
      --text-secondary: #B1BAC4;
      --text-muted: #7D8590;
      --accent-purple: #8B5CF6;
      --success-green: #3FB950;
      --warning-amber: #D29922;
      --error-red: #F85149;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 13px;
      line-height: 1.5;
      padding: 0;
      min-height: 100vh;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    /* Header */
    .header {
      background: var(--bg-secondary);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      padding: 20px 24px;
      margin-bottom: 24px;
    }

    .header h1 {
      color: var(--text-primary);
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
      letter-spacing: -0.01em;
    }

    .header .meta {
      color: var(--text-muted);
      font-size: 12px;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }

    .header .meta span {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .header .meta .separator {
      color: var(--border-secondary);
    }

    /* Grid Layout */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }

    .grid-full {
      grid-column: 1 / -1;
    }

    /* Card */
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      padding: 20px;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-primary);
    }

    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .stat {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-primary);
      border-radius: 4px;
      padding: 12px;
    }

    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1;
      margin-bottom: 4px;
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 500;
    }

    .stat-value.success { color: var(--success-green); }
    .stat-value.error { color: var(--error-red); }
    .stat-value.warning { color: var(--warning-amber); }
    .stat-value.accent { color: var(--accent-purple); }

    /* Gauge */
    .gauge-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 12px 0;
    }

    .gauge-score {
      font-size: 48px;
      font-weight: 700;
      margin-top: 8px;
      line-height: 1;
    }

    .gauge-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 8px;
      font-weight: 500;
    }

    /* Table */
    .table-container {
      overflow-x: auto;
      margin-top: 12px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    thead {
      border-bottom: 1px solid var(--border-primary);
    }

    th {
      text-align: left;
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-primary);
      color: var(--text-secondary);
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    tbody tr:hover {
      background: var(--bg-tertiary);
    }

    /* Badge */
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge-success {
      background: rgba(63, 185, 80, 0.15);
      color: var(--success-green);
    }

    .badge-error {
      background: rgba(248, 81, 73, 0.15);
      color: var(--error-red);
    }

    /* Progress Bar */
    .progress-bar {
      height: 4px;
      background: var(--bg-tertiary);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 6px;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent-purple), var(--success-green));
      transition: width 0.3s ease;
      border-radius: 2px;
    }

    /* Insights */
    .insights {
      background: rgba(139, 92, 246, 0.08);
      border: 1px solid rgba(139, 92, 246, 0.2);
      border-radius: 4px;
      padding: 12px 16px;
      margin-top: 16px;
    }

    .insights-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--accent-purple);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }

    .insights ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .insights li {
      padding: 4px 0;
      font-size: 12px;
      color: var(--text-secondary);
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .insights li::before {
      content: "→";
      color: var(--accent-purple);
      flex-shrink: 0;
      margin-top: 2px;
    }

    /* Benchmark Card */
    .benchmark-layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 24px;
      align-items: center;
    }

    .benchmark-stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .benchmark-highlight {
      margin-top: 12px;
      padding: 12px;
      background: rgba(63, 185, 80, 0.08);
      border: 1px solid rgba(63, 185, 80, 0.2);
      border-radius: 4px;
    }

    .benchmark-highlight strong {
      color: var(--success-green);
    }

    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }

      .benchmark-layout {
        grid-template-columns: 1fr;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <h1>Behavioral Contracts Analysis</h1>
      <div class="meta">
        <span><strong>${repoName}</strong></span>
        <span class="separator">•</span>
        <span>${timestamp}</span>
        <span class="separator">•</span>
        <span>${audit.files_analyzed} files</span>
        <span class="separator">•</span>
        <span>${audit.contracts_applied} checks</span>
      </div>
    </div>

    <!-- Main Grid -->
    <div class="grid">
      <!-- Health Score -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Health Score</div>
        </div>
        <div class="gauge-container">
          <svg id="health-gauge" width="280" height="160"></svg>
          <div class="gauge-score" id="gauge-score">--</div>
          <div class="gauge-label">Overall Code Health</div>
        </div>
        <div class="stats-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-value">${health.errorHandlingCompliance}%</div>
            <div class="stat-label">Error Handling</div>
          </div>
          <div class="stat">
            <div class="stat-value">${health.packageCoverage}%</div>
            <div class="stat-label">Coverage</div>
          </div>
          <div class="stat">
            <div class="stat-value">${health.codeMaturity}</div>
            <div class="stat-label">Maturity</div>
          </div>
          <div class="stat">
            <div class="stat-value">${health.riskLevel}</div>
            <div class="stat-label">Risk Level</div>
          </div>
        </div>
      </div>

      <!-- Summary Stats -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Summary</div>
        </div>
        <div class="stats-grid">
          <div class="stat">
            <div class="stat-value accent">${health.checksPerformed}</div>
            <div class="stat-label">Checks Performed</div>
          </div>
          <div class="stat">
            <div class="stat-value success">${health.checksPassed}</div>
            <div class="stat-label">Checks Passed</div>
          </div>
          <div class="stat">
            <div class="stat-value ${audit.violations.length === 0 ? 'success' : 'error'}">${audit.violations.length}</div>
            <div class="stat-label">Violations Found</div>
          </div>
          <div class="stat">
            <div class="stat-value">${packageBreakdown.packagesWithContracts}</div>
            <div class="stat-label">Packages</div>
          </div>
        </div>
        ${generateInsightsHTML(health, audit, benchmarking)}
      </div>
    </div>

    ${benchmarking && benchmark ? generateBenchmarkingHTML(benchmarking, benchmark) : ''}

    <!-- Package Breakdown -->
    <div class="card grid-full">
      <div class="card-header">
        <div class="card-title">Package Breakdown</div>
        <div style="font-size: 11px; color: var(--text-muted);">
          ${packageBreakdown.packagesFullyCompliant} passing, ${packageBreakdown.packagesWithViolations} failing
        </div>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Package</th>
              <th style="text-align: center;">Checks</th>
              <th style="text-align: center;">Passed</th>
              <th style="text-align: center;">Failed</th>
              <th>Compliance</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${packageBreakdown.packages.map(pkg => `
              <tr>
                <td><strong>${pkg.packageName}</strong></td>
                <td style="text-align: center;">${pkg.contractsApplied}</td>
                <td style="text-align: center; color: var(--success-green);">${pkg.checksPassedCount}</td>
                <td style="text-align: center; color: ${pkg.violationsFound > 0 ? 'var(--error-red)' : 'var(--text-muted)'};">${pkg.violationsFound}</td>
                <td>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="min-width: 32px;">${pkg.compliancePercent}%</span>
                    <div class="progress-bar" style="flex: 1;">
                      <div class="progress-fill" style="width: ${pkg.compliancePercent}%"></div>
                    </div>
                  </div>
                </td>
                <td>
                  <span class="badge badge-${pkg.status === 'PASS' ? 'success' : 'error'}">
                    ${pkg.status === 'PASS' ? '✓ Pass' : '✗ Fail'}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    // Data
    const healthScore = ${health.overallScore};
    ${benchmarking && benchmark ? `
    const benchmarkData = ${JSON.stringify(benchmark)};
    const comparisonData = ${JSON.stringify(benchmarking)};
    ` : ''}

    // Health Score Gauge
    function drawHealthGauge() {
      const width = 280;
      const height = 160;
      const radius = 70;

      const svg = d3.select('#health-gauge');

      // Color scale - subtle gradient
      const colorScale = d3.scaleLinear()
        .domain([0, 50, 70, 90, 100])
        .range(['#F85149', '#D29922', '#8B5CF6', '#3FB950', '#3FB950']);

      // Background arc
      const bgArc = d3.arc()
        .innerRadius(radius - 12)
        .outerRadius(radius)
        .startAngle(-Math.PI / 2)
        .endAngle(Math.PI / 2);

      svg.append('path')
        .attr('d', bgArc)
        .attr('transform', \`translate(\${width/2}, \${height-20})\`)
        .attr('fill', '#22252D')
        .attr('opacity', 0.5);

      // Score arc (animated)
      const scoreAngle = -Math.PI / 2 + (healthScore / 100) * Math.PI;

      const scoreArc = d3.arc()
        .innerRadius(radius - 12)
        .outerRadius(radius)
        .startAngle(-Math.PI / 2)
        .endAngle(scoreAngle);

      const path = svg.append('path')
        .attr('transform', \`translate(\${width/2}, \${height-20})\`)
        .attr('fill', colorScale(healthScore));

      // Animate the arc
      path.transition()
        .duration(1200)
        .ease(d3.easeCubicOut)
        .attrTween('d', function() {
          const interpolate = d3.interpolate(-Math.PI / 2, scoreAngle);
          return function(t) {
            const currentArc = d3.arc()
              .innerRadius(radius - 12)
              .outerRadius(radius)
              .startAngle(-Math.PI / 2)
              .endAngle(interpolate(t));
            return currentArc();
          };
        });

      // Animate the score number
      d3.select('#gauge-score')
        .transition()
        .duration(1200)
        .tween('text', function() {
          const interpolate = d3.interpolate(0, healthScore);
          return function(t) {
            this.textContent = Math.round(interpolate(t));
          };
        })
        .style('color', colorScale(healthScore));

      // Add subtle tick marks
      const ticks = [0, 25, 50, 75, 100];
      ticks.forEach(tick => {
        const angle = -Math.PI / 2 + (tick / 100) * Math.PI;
        const x1 = Math.cos(angle) * (radius - 15);
        const y1 = Math.sin(angle) * (radius - 15);
        const x2 = Math.cos(angle) * (radius + 2);
        const y2 = Math.sin(angle) * (radius + 2);

        svg.append('line')
          .attr('transform', \`translate(\${width/2}, \${height-20})\`)
          .attr('x1', x1)
          .attr('y1', y1)
          .attr('x2', x2)
          .attr('y2', y2)
          .attr('stroke', '#3D4149')
          .attr('stroke-width', 1.5);

        svg.append('text')
          .attr('transform', \`translate(\${width/2}, \${height-20})\`)
          .attr('x', Math.cos(angle) * (radius + 15))
          .attr('y', Math.sin(angle) * (radius + 15))
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .attr('fill', '#7D8590')
          .attr('font-size', '10px')
          .text(tick);
      });
    }

    ${benchmarking && benchmark ? `
    // Benchmarking Distribution Chart
    function drawBenchmarkChart() {
      const margin = {top: 10, right: 20, bottom: 30, left: 50};
      const width = 450 - margin.left - margin.right;
      const height = 200 - margin.top - margin.bottom;

      const svg = d3.select('#benchmark-chart')
        .append('svg')
        .attr('width', width + margin.left + margin.right)
        .attr('height', height + margin.top + margin.bottom)
        .append('g')
        .attr('transform', \`translate(\${margin.left},\${margin.top})\`);

      const percentiles = [
        { label: '25th', value: benchmarkData.percentiles.p25, y: 0.75 },
        { label: 'Median', value: benchmarkData.percentiles.p50, y: 0.5 },
        { label: '75th', value: benchmarkData.percentiles.p75, y: 0.25 },
        { label: '90th', value: benchmarkData.percentiles.p90, y: 0.1 }
      ];

      const maxViolations = Math.max(benchmarkData.percentiles.p90, comparisonData.your_violations) + 10;

      const x = d3.scaleLinear()
        .domain([0, maxViolations])
        .range([0, width]);

      const y = d3.scaleLinear()
        .domain([0, 1])
        .range([height, 0]);

      // Draw distribution area
      const area = d3.area()
        .x(d => x(d.value))
        .y0(d => y(d.y - 0.12))
        .y1(d => y(d.y + 0.12))
        .curve(d3.curveBasis);

      svg.append('path')
        .datum(percentiles)
        .attr('fill', '#8B5CF6')
        .attr('opacity', 0.2)
        .attr('d', area);

      // Draw percentile markers
      percentiles.forEach(p => {
        svg.append('line')
          .attr('x1', x(p.value))
          .attr('x2', x(p.value))
          .attr('y1', y(p.y - 0.1))
          .attr('y2', y(p.y + 0.1))
          .attr('stroke', '#8B5CF6')
          .attr('stroke-width', 1.5);

        svg.append('text')
          .attr('x', x(p.value))
          .attr('y', y(p.y - 0.18))
          .attr('text-anchor', 'middle')
          .attr('font-size', '10px')
          .attr('fill', '#7D8590')
          .text(p.label);
      });

      // Draw your position
      const yourX = x(comparisonData.your_violations);
      svg.append('line')
        .attr('x1', yourX)
        .attr('x2', yourX)
        .attr('y1', 0)
        .attr('y2', height)
        .attr('stroke', '#3FB950')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '3,3');

      svg.append('circle')
        .attr('cx', yourX)
        .attr('cy', height / 2)
        .attr('r', 5)
        .attr('fill', '#3FB950')
        .attr('stroke', '#1C1F26')
        .attr('stroke-width', 2);

      svg.append('text')
        .attr('x', yourX)
        .attr('y', height / 2 - 15)
        .attr('text-anchor', 'middle')
        .attr('font-weight', '600')
        .attr('font-size', '10px')
        .attr('fill', '#3FB950')
        .text('YOU');

      // X-axis
      svg.append('g')
        .attr('transform', \`translate(0,\${height})\`)
        .call(d3.axisBottom(x).ticks(5))
        .attr('color', '#3D4149')
        .selectAll('text')
        .attr('font-size', '10px')
        .attr('fill', '#7D8590');

      svg.append('text')
        .attr('x', width / 2)
        .attr('y', height + 28)
        .attr('text-anchor', 'middle')
        .attr('font-size', '10px')
        .attr('fill', '#7D8590')
        .text('Violations');
    }
    ` : ''}

    // Initialize
    drawHealthGauge();
    ${benchmarking && benchmark ? 'drawBenchmarkChart();' : ''}
  </script>
</body>
</html>`;
}

/**
 * Generate insights HTML
 */
function generateInsightsHTML(
  health: HealthMetrics,
  audit: AuditRecord | EnhancedAuditRecord,
  benchmarking?: ComparisonMetrics
): string {
  const insights: string[] = [];

  if (health.errorHandlingCompliance === 100) {
    insights.push('Perfect compliance across all package usage points');
  } else if (health.errorHandlingCompliance >= 95) {
    insights.push(`High compliance rate with only ${audit.violations.length} issues`);
  }

  if (benchmarking && benchmarking.violations_avoided > 0) {
    insights.push(`Avoided ${benchmarking.violations_avoided} violations vs average repo`);
  }

  if (health.checksPerformed > 100) {
    insights.push(`Comprehensive analysis with ${health.checksPerformed} checks performed`);
  }

  if (insights.length === 0) return '';

  return `
    <div class="insights">
      <div class="insights-title">Key Insights</div>
      <ul>
        ${insights.map(insight => `<li>${insight}</li>`).join('')}
      </ul>
    </div>
  `;
}

/**
 * Generate benchmarking section HTML
 */
function generateBenchmarkingHTML(
  benchmarking: ComparisonMetrics,
  benchmark: BenchmarkData
): string {
  return `
    <div class="card grid-full">
      <div class="card-header">
        <div class="card-title">Benchmarking</div>
        <div style="font-size: 11px; color: var(--text-muted);">
          Compared against ${benchmark.sample_size} repositories
        </div>
      </div>
      <div class="benchmark-layout">
        <div>
          <div class="benchmark-stats">
            <div class="stat">
              <div class="stat-value">${benchmarking.your_violations}</div>
              <div class="stat-label">Your Violations</div>
            </div>
            <div class="stat">
              <div class="stat-value">${benchmarking.avg_violations}</div>
              <div class="stat-label">Average</div>
            </div>
            <div class="stat">
              <div class="stat-value success">Top ${100 - benchmarking.percentile_rank}%</div>
              <div class="stat-label">Ranking</div>
            </div>
            <div class="stat">
              <div class="stat-value">${benchmark.sample_size}</div>
              <div class="stat-label">Repos Analyzed</div>
            </div>
          </div>
          <div class="benchmark-highlight" style="font-size: 12px;">
            Your repo is <strong>${benchmarking.comparison.toLowerCase()}</strong> than ${benchmarking.percentile_rank}% of repos scanned.
            ${benchmarking.violations_avoided > 0 ? `<br>You avoided <strong>${benchmarking.violations_avoided} violations</strong> compared to average.` : ''}
          </div>
        </div>
        <div id="benchmark-chart"></div>
      </div>
    </div>
  `;
}

/**
 * Extract repository name from tsconfig path
 */
function extractRepoName(tsconfigPath: string): string {
  const parts = tsconfigPath.split('/');
  const repoIndex = parts.findIndex(p => p === 'test-repos') + 1;

  if (repoIndex > 0 && repoIndex < parts.length) {
    return parts[repoIndex];
  }

  return parts[parts.length - 2] || 'Unknown Repository';
}

/**
 * Write D3 visualization to file
 */
export async function writeD3Visualization(
  data: D3VisualizationData,
  outputPath: string
): Promise<void> {
  const { writeFile } = await import('fs/promises');
  const html = generateD3Dashboard(data);
  await writeFile(outputPath, html, 'utf-8');
}
