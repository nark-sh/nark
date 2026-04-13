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
import chalk from 'chalk';

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
}

const TELEMETRY_ENDPOINT = 'https://nark.sh/api/telemetry/scan';

export function getTelemetryConfigPath(): string {
  return path.join(os.homedir(), '.nark', 'telemetry.json');
}

export function readTelemetryConfig(): TelemetryConfig {
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
 * Fire a telemetry event as fire-and-forget.
 * Never throws, never blocks the caller.
 */
export function fireTelemetryEvent(payload: TelemetryPayload): void {
  const config = readTelemetryConfig();
  if (!config.enabled) return;
  try {
    fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
          const statusLabel = config.enabled
            ? chalk.green('Enabled')
            : chalk.yellow('Disabled');

          console.log('');
          console.log(chalk.bold('Nark Telemetry'));
          console.log('');
          console.log(`Status:   ${statusLabel}`);
          console.log(`Config:   ${getTelemetryConfigPath()}`);
          console.log('');
          console.log(chalk.dim('Run `nark telemetry off` to opt out.'));
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
