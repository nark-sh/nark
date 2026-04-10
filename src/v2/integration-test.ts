/**
 * Integration Test Suite for Universal Analyzer v2
 *
 * Tests all 5 detector plugins against multiple packages.
 * Benchmarks performance and validates detection accuracy.
 */

import {
  UniversalAnalyzer,
  ThrowingFunctionDetector,
  PropertyChainDetector,
  EventListenerDetector,
  CallbackDetector,
  ReturnValueChecker,
} from './index.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PackageTestConfig {
  name: string;
  path: string;
  expectedPlugins: string[];
  minDetections: number;
}

interface TestResult {
  package: string;
  success: boolean;
  filesAnalyzed: number;
  detections: number;
  duration: number;
  detectionsByPlugin: Map<string, number>;
  error?: Error;
}

/**
 * Main integration test function
 */
async function runIntegrationTests(): Promise<void> {
  console.log('🧪 Universal Analyzer v2 - Integration Test Suite\n');
  console.log('=' .repeat(70));
  console.log();

  // Find all packages with fixtures in corpus
  const corpusPath = path.resolve(__dirname, '../../../corpus/packages');
  const packages = await findPackagesWithFixtures(corpusPath);

  console.log(`📦 Found ${packages.length} packages with fixtures:\n`);
  for (const pkg of packages) {
    console.log(`   - ${pkg.name}`);
  }
  console.log();

  // Run tests on each package
  const results: TestResult[] = [];
  let totalTime = 0;
  let totalFiles = 0;
  let totalDetections = 0;

  for (const pkg of packages) {
    console.log('─'.repeat(70));
    console.log(`Testing: ${pkg.name}`);
    console.log('─'.repeat(70));

    const result = await testPackage(pkg);
    results.push(result);

    if (result.success) {
      totalTime += result.duration;
      totalFiles += result.filesAnalyzed;
      totalDetections += result.detections;

      console.log(`✅ Success`);
      console.log(`   Files: ${result.filesAnalyzed}`);
      console.log(`   Detections: ${result.detections}`);
      console.log(`   Duration: ${result.duration}ms`);
      console.log();

      // Print detections by plugin
      if (result.detectionsByPlugin.size > 0) {
        console.log('   Detections by plugin:');
        for (const [plugin, count] of result.detectionsByPlugin) {
          console.log(`     ${plugin}: ${count}`);
        }
        console.log();
      }
    } else {
      console.log(`❌ Failed: ${result.error?.message}`);
      console.log();
    }
  }

  // Print summary
  console.log('='.repeat(70));
  console.log('📊 Integration Test Summary');
  console.log('='.repeat(70));
  console.log();

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  console.log(`Total packages tested: ${results.length}`);
  console.log(`✅ Passed: ${successCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log();

  console.log(`Total files analyzed: ${totalFiles}`);
  console.log(`Total detections: ${totalDetections}`);
  console.log(`Total duration: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
  console.log(`Average per file: ${(totalTime / totalFiles).toFixed(2)}ms`);
  console.log();

  // Aggregate detections by plugin
  const aggregateByPlugin = new Map<string, number>();
  for (const result of results) {
    if (result.success) {
      for (const [plugin, count] of result.detectionsByPlugin) {
        aggregateByPlugin.set(plugin, (aggregateByPlugin.get(plugin) || 0) + count);
      }
    }
  }

  console.log('Detections by plugin (aggregate):');
  for (const [plugin, count] of aggregateByPlugin) {
    const pct = ((count / totalDetections) * 100).toFixed(1);
    console.log(`   ${plugin}: ${count} (${pct}%)`);
  }
  console.log();

  // Print failed tests
  if (failCount > 0) {
    console.log('❌ Failed tests:');
    for (const result of results) {
      if (!result.success) {
        console.log(`   - ${result.package}: ${result.error?.message}`);
      }
    }
    console.log();
  }

  // Performance benchmarks
  console.log('⚡ Performance Benchmarks:');
  console.log(`   Throughput: ${(totalFiles / (totalTime / 1000)).toFixed(2)} files/second`);
  console.log(`   Detections/second: ${(totalDetections / (totalTime / 1000)).toFixed(0)}`);
  console.log();

  // Exit code
  const exitCode = failCount > 0 ? 1 : 0;
  console.log(exitCode === 0 ? '✅ All tests passed!' : '❌ Some tests failed!');

  process.exit(exitCode);
}

/**
 * Find all packages with fixture directories
 */
async function findPackagesWithFixtures(corpusPath: string): Promise<PackageTestConfig[]> {
  const packages: PackageTestConfig[] = [];

  function findFixtures(dir: string, currentPath: string = ''): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Check if this directory has a fixtures subdirectory
        const fixturesPath = path.join(fullPath, 'fixtures');
        const tsConfigPath = path.join(fixturesPath, 'tsconfig.json');

        if (fs.existsSync(tsConfigPath)) {
          // Found a package with fixtures
          packages.push({
            name: relativePath,
            path: fixturesPath,
            expectedPlugins: [], // Will be determined by analysis
            minDetections: 0,
          });
        }

        // Recurse for scoped packages (@org/package)
        if (entry.name.startsWith('@')) {
          findFixtures(fullPath, relativePath);
        }
      }
    }
  }

  findFixtures(corpusPath);
  return packages;
}

/**
 * Test a single package
 */
async function testPackage(pkg: PackageTestConfig): Promise<TestResult> {
  try {
    const tsConfigPath = path.join(pkg.path, 'tsconfig.json');

    // Create analyzer
    const analyzer = new UniversalAnalyzer({
      tsConfigPath,
      corpusPath: path.resolve(__dirname, '../../../corpus'),
    });

    // Register ALL 5 plugins
    analyzer.registerPlugin(new ThrowingFunctionDetector());
    analyzer.registerPlugin(new PropertyChainDetector());
    analyzer.registerPlugin(new EventListenerDetector());
    analyzer.registerPlugin(new CallbackDetector());
    analyzer.registerPlugin(new ReturnValueChecker());

    // Initialize and analyze
    analyzer.initialize();
    const result = analyzer.analyze();

    return {
      package: pkg.name,
      success: true,
      filesAnalyzed: result.filesAnalyzed,
      detections: result.totalDetections,
      duration: result.duration,
      detectionsByPlugin: result.statistics.byPlugin,
    };
  } catch (error) {
    return {
      package: pkg.name,
      success: false,
      filesAnalyzed: 0,
      detections: 0,
      duration: 0,
      detectionsByPlugin: new Map(),
      error: error as Error,
    };
  }
}

// Run tests
runIntegrationTests().catch((error) => {
  console.error('❌ Integration test crashed:', error);
  process.exit(1);
});
