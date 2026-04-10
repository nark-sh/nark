/**
 * .nark/config.yaml manager
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface NarkConfig {
  analytics: boolean;
  suppress_false_positives: boolean;
  output_format: 'both' | 'md' | 'json';
}

const DEFAULT_CONFIG: NarkConfig = {
  analytics: true,
  suppress_false_positives: true,
  output_format: 'both',
};

const CONFIG_HEADER = `# nark configuration
# analytics: Set to false to opt out of anonymous analytics
# suppress_false_positives: Re-use triage verdicts on re-scan
# output_format: "both", "md", "json"
`;

export function loadConfig(narkDir: string): NarkConfig {
  const configPath = path.join(narkDir, 'config.yaml');
  try {
    if (!fs.existsSync(configPath)) {
      return { ...DEFAULT_CONFIG };
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content) as Partial<NarkConfig>;
    return {
      analytics: parsed.analytics ?? DEFAULT_CONFIG.analytics,
      suppress_false_positives: parsed.suppress_false_positives ?? DEFAULT_CONFIG.suppress_false_positives,
      output_format: parsed.output_format ?? DEFAULT_CONFIG.output_format,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(narkDir: string, config: NarkConfig): void {
  const configPath = path.join(narkDir, 'config.yaml');
  const yaml = stringifyYaml(config);
  fs.writeFileSync(configPath, CONFIG_HEADER + yaml, 'utf-8');
}

export function ensureConfig(narkDir: string): NarkConfig {
  const configPath = path.join(narkDir, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(narkDir, { recursive: true });
    saveConfig(narkDir, DEFAULT_CONFIG);
  }
  return loadConfig(narkDir);
}
