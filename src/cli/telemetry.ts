/**
 * CLI Command: telemetry
 * Manage anonymous usage telemetry collection.
 *
 * nark telemetry [on|off|status]
 *
 * State stored at ~/.nark/telemetry.json
 * Shape: { enabled: boolean, notified: boolean }
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { getToken } from '../lib/auth.js';

export interface TelemetryConfig {
  enabled: boolean;
  notified: boolean;
}

export interface TelemetryPayload {
  version: string;
  os: string;
  arch: string;
  nodeVersion: string;
  packageNames: string[];
  contractIds: string[];
  violationCountsByContract: Record<string, number>;
  scanDurationMs: number;
  isCiMode: boolean;
  repoFingerprint?: string;
  fileCount?: number;
  totalCallSites?: number;
  corpusVersion?: string;
  suppressionCount?: number;
  scanMode?: string;
  exitCode?: number;
}

/**
 * Compute a SHA256 hash of the git remote origin URL for the current working directory.
 * Returns undefined if git is unavailable, there is no origin remote, or any error occurs.
 * Never throws.
 */
function getRepoFingerprint(): string | undefined {
  try {
    const url = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!url) return undefined;
    return createHash('sha256').update(url).digest('hex');
  } catch {
    return undefined;
  }
}

const NARK_API_BASE = process.env['NARK_API_URL'] ?? 'https://nark.sh';
const TELEMETRY_ENDPOINT = `${NARK_API_BASE}/api/telemetry/scan`;

export function getTelemetryConfigPath(): string {
  return path.join(os.homedir(), '.nark', 'telemetry.json');
}

/**
 * Check if telemetry is disabled via environment variable.
 * Supports NARK_TELEMETRY=off and the standard DO_NOT_TRACK=1.
 */
function isEnvDisabled(): boolean {
  const narkEnv = process.env['NARK_TELEMETRY'];
  if (narkEnv !== undefined && ['off', 'false', '0'].includes(narkEnv.toLowerCase())) {
    return true;
  }
  if (process.env['DO_NOT_TRACK'] === '1') {
    return true;
  }
  return false;
}

export function readTelemetryConfig(): TelemetryConfig {
  // Environment variable overrides file config
  if (isEnvDisabled()) {
    return { enabled: false, notified: true };
  }

  const configPath = getTelemetryConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return { enabled: true, notified: false };
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.enabled === 'boolean' &&
      typeof parsed.notified === 'boolean'
    ) {
      return parsed as TelemetryConfig;
    }
    return { enabled: true, notified: false };
  } catch {
    return { enabled: true, notified: false };
  }
}

export function writeTelemetryConfig(config: TelemetryConfig): void {
  const configPath = getTelemetryConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Print first-run notice to stderr if the user has never been notified.
 * Sets notified=true after printing.
 */
export function handleFirstRunNotice(): void {
  const configPath = getTelemetryConfigPath();
  const fileExists = fs.existsSync(configPath);
  const config = readTelemetryConfig();

  if (!fileExists || !config.notified) {
    process.stderr.write(
      chalk.dim(
        '\nNark collects anonymous usage data to improve the tool.\n' +
        'Run `nark telemetry off` to opt out. Learn more: https://nark.sh/telemetry\n\n'
      )
    );
    writeTelemetryConfig({ ...config, notified: true });
  }
}

/**
 * Fire a telemetry event. Returns a promise that resolves when the request
 * completes (or fails). Never rejects — errors are silently swallowed.
 * The caller should await this before process.exit() to avoid the request
 * being killed mid-flight.
 *
 * When a user is logged in, includes Authorization: Bearer <token> header.
 * When a git remote is available, includes repoFingerprint (SHA256 of origin URL).
 */
export async function fireTelemetryEvent(payload: TelemetryPayload): Promise<void> {
  const config = readTelemetryConfig();
  if (!config.enabled) return;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token !== null) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    const fp = getRepoFingerprint();
    const enriched = { ...payload, ...(fp ? { repoFingerprint: fp } : {}) };
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(enriched),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    // ignore — telemetry must never affect the scanner
  }
}

/**
 * Create the `nark telemetry` subcommand.
 */
export function createTelemetryCommand(): Command {
  const cmd = new Command('telemetry');

  cmd
    .description('Manage anonymous usage telemetry collection')
    .argument('[action]', 'on, off, or status (default: status)')
    .action((action = 'status') => {
      const config = readTelemetryConfig();

      switch (action) {
        case 'status': {
          const envOverride = isEnvDisabled();
          const statusLabel = config.enabled
            ? chalk.green('Enabled')
            : chalk.yellow('Disabled');

          console.log('');
          console.log(chalk.bold('Nark Telemetry'));
          console.log('');
          console.log(`Status:   ${statusLabel}`);
          if (envOverride) {
            console.log(`          ${chalk.dim('(disabled via environment variable)')}`);
          }
          console.log(`Config:   ${getTelemetryConfigPath()}`);
          console.log(`Endpoint: ${TELEMETRY_ENDPOINT}`);
          console.log('');
          console.log(chalk.dim('Run `nark telemetry off` to opt out.'));
          console.log(chalk.dim('Set NARK_TELEMETRY=off or DO_NOT_TRACK=1 to disable via env.'));
          console.log(chalk.dim('Learn more: https://nark.sh/telemetry'));
          console.log('');
          break;
        }

        case 'on': {
          writeTelemetryConfig({ ...config, enabled: true });
          console.log(chalk.green('Nark telemetry has been enabled. Thank you for helping improve Nark.'));
          break;
        }

        case 'off': {
          writeTelemetryConfig({ ...config, enabled: false });
          console.log(chalk.yellow('Nark telemetry has been disabled. No data will be collected.'));
          break;
        }

        default: {
          console.error(chalk.red(`Unknown telemetry action: "${action}". Use on, off, or status.`));
          process.exit(1);
        }
      }
    });

  return cmd;
}
