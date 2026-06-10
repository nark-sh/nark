import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface NarkRcConfig {
  tsconfig?: string;
  /**
   * Corpus directory path, or array of paths in PRECEDENCE order (highest first).
   * Single string is treated as one corpus. Array form is the multi-corpus
   * chain — e.g. `[<private>, <pro>, <public>]`.
   */
  corpus?: string | string[];
  exclude?: string[];
  include?: string[];
  telemetry?: boolean;
  failThreshold?: 'error' | 'warning' | 'info';
  output?: {
    sarif?: string;
    json?: string;
  };
  includeDrafts?: boolean;
  includeTests?: boolean;
  includeDeprecated?: boolean;
}

/**
 * Walk up from startDir to find a .git directory (git root boundary).
 * Returns the directory containing .git, or null if not found.
 */
function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Load .nark/config.yaml from projectRoot or any ancestor up to git root.
 * Returns null if no config file is found.
 */
export function loadNarkRc(projectRoot: string): NarkRcConfig | null {
  const gitRoot = findGitRoot(projectRoot);
  let current = path.resolve(projectRoot);
  const fsRoot = path.parse(current).root;

  while (true) {
    const yamlPath = path.join(current, '.nark', 'config.yaml');

    if (fs.existsSync(yamlPath)) {
      try {
        const raw = fs.readFileSync(yamlPath, 'utf-8');
        return (parseYaml(raw) as NarkRcConfig) ?? null;
      } catch (err) {
        throw new Error(
          `Failed to parse ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Stop at git root or filesystem root
    if (current === gitRoot || current === fsRoot || current === path.dirname(current)) break;
    current = path.dirname(current);
  }

  return null;
}
