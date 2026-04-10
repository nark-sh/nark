/**
 * Multi-Package Test for Universal Analyzer v2
 *
 * Tests both ThrowingFunctionDetector and PropertyChainDetector
 * against axios (depth 1) and Prisma (depth 2+) fixtures.
 */

import {
  UniversalAnalyzer,
  ThrowingFunctionDetector,
  PropertyChainDetector,
  FileAnalysisResult,
} from './index.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PackageTest {
  name: string;
  path: string;
  expectedPatterns: string[];
}

async function testPackage(pkg: PackageTest, analyzer: UniversalAnalyzer) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📦 Testing: ${pkg.name}`);
  console.log(`${'='.repeat(60)}\n`);

  const tsConfigPath = path.join(pkg.path, 'tsconfig.json');
  console.log(`📋 Using tsconfig: ${tsConfigPath}\n`);

  // Reinitialize analyzer for new package
  analyzer = new UniversalAnalyzer({
    tsConfigPath,
    corpusPath: path.resolve(__dirname, '../../../corpus'),
  });

  // Register both detectors
  analyzer.registerPlugin(new ThrowingFunctionDetector());
  analyzer.registerPlugin(new PropertyChainDetector());

  console.log('🔌 Registered plugins:');
  for (const plugin of analyzer.getPlugins()) {
    console.log(`   - ${plugin.name} v${plugin.version}`);
  }
  console.log();

  // Initialize and analyze
  console.log('⚙️  Initializing analyzer...');
  analyzer.initialize();
  console.log('✅ Analyzer initialized\n');

  console.log('🔍 Running analysis...');
  const result = analyzer.analyze();

  // Print results
  console.log('\n📊 Analysis Results:');
  console.log(`   Files analyzed: ${result.filesAnalyzed}`);
  console.log(`   Total detections: ${result.totalDetections}`);
  console.log(`   Duration: ${result.duration}ms\n`);

  // Print detections by plugin
  console.log('🔍 Detections by plugin:');
  for (const [plugin, count] of result.statistics.byPlugin) {
    console.log(`   ${plugin}: ${count} detections`);
  }
  console.log();

  // Print sample detections
  const fileWithDetections = result.files.find((f: FileAnalysisResult) => f.detections.length > 0);
  if (fileWithDetections) {
    console.log(`📄 Sample detections from ${path.basename(fileWithDetections.file)}:`);

    // Group by pattern
    const byPattern = new Map<string, number>();
    const samples = new Map<string, any>();

    for (const detection of fileWithDetections.detections) {
      const key = detection.pattern;
      byPattern.set(key, (byPattern.get(key) || 0) + 1);

      if (!samples.has(key)) {
        samples.set(key, detection);
      }
    }

    for (const [pattern, count] of byPattern) {
      const sample = samples.get(pattern);
      console.log(`\n   Pattern: ${pattern} (${count} occurrences)`);
      console.log(`   Example: ${sample.packageName}.${sample.functionName}`);
      console.log(`   Confidence: ${sample.confidence}`);
      if (sample.metadata?.depth) {
        console.log(`   Chain depth: ${sample.metadata.depth}`);
      }
      if (sample.metadata?.chain) {
        console.log(`   Chain: ${sample.metadata.chain.join('.')}`);
      }
    }
  }

  // Verify expected patterns were found
  console.log('\n✅ Pattern Verification:');
  for (const expected of pkg.expectedPatterns) {
    const found = result.files.some((f: FileAnalysisResult) =>
      f.detections.some((d) => d.pattern === expected)
    );
    console.log(`   ${found ? '✅' : '❌'} ${expected}: ${found ? 'FOUND' : 'NOT FOUND'}`);
  }

  return result;
}

async function main() {
  console.log('🧪 Testing Universal Analyzer v2 - Multi-Package Test\n');

  const packagesToTest: PackageTest[] = [
    {
      name: 'axios (depth 1 patterns)',
      path: path.resolve(__dirname, '../../../corpus/packages/axios/fixtures'),
      expectedPatterns: ['throwing-function'],
    },
    {
      name: '@prisma/client (depth 2+ patterns)',
      path: path.resolve(__dirname, '../../../corpus/packages/@prisma/client/fixtures'),
      expectedPatterns: ['property-chain'],
    },
  ];

  const results = [];

  for (const pkg of packagesToTest) {
    try {
      const analyzer = new UniversalAnalyzer({
        tsConfigPath: '', // Will be set in testPackage
        corpusPath: '',
      });
      const result = await testPackage(pkg, analyzer);
      results.push({ package: pkg.name, result, success: true });
    } catch (error) {
      console.error(`\n❌ Error testing ${pkg.name}:`, error);
      results.push({ package: pkg.name, error, success: false });
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 Summary');
  console.log(`${'='.repeat(60)}\n`);

  let totalDetections = 0;
  let totalFiles = 0;
  let totalDuration = 0;

  for (const r of results) {
    if (r.success && r.result) {
      console.log(`✅ ${r.package}`);
      console.log(`   Files: ${r.result.filesAnalyzed}`);
      console.log(`   Detections: ${r.result.totalDetections}`);
      console.log(`   Duration: ${r.result.duration}ms`);

      totalDetections += r.result.totalDetections;
      totalFiles += r.result.filesAnalyzed;
      totalDuration += r.result.duration;
    } else {
      console.log(`❌ ${r.package}: FAILED`);
    }
  }

  console.log(`\n📈 Totals:`);
  console.log(`   Packages tested: ${results.length}`);
  console.log(`   Files analyzed: ${totalFiles}`);
  console.log(`   Total detections: ${totalDetections}`);
  console.log(`   Total duration: ${totalDuration}ms`);
  console.log(`   Avg per file: ${(totalDuration / totalFiles).toFixed(2)}ms`);

  const allSuccess = results.every((r) => r.success);
  console.log(`\n${allSuccess ? '✅' : '❌'} Test ${allSuccess ? 'PASSED' : 'FAILED'}!`);

  process.exit(allSuccess ? 0 : 1);
}

// Run test
main().catch((error) => {
  console.error('❌ Test crashed:', error);
  process.exit(1);
});
