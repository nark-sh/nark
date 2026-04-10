/**
 * Test script for Universal Analyzer v2
 *
 * Quick test to verify the analyzer and ThrowingFunctionDetector work correctly.
 */

import { UniversalAnalyzer, ThrowingFunctionDetector, FileAnalysisResult } from './index.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('🧪 Testing Universal Analyzer v2\n');

  // Path to axios fixtures
  const axiosFixturesPath = path.resolve(
    __dirname,
    '../../../corpus/packages/axios/fixtures'
  );
  const tsConfigPath = path.join(axiosFixturesPath, 'tsconfig.json');

  console.log(`📁 Analyzing: ${axiosFixturesPath}`);
  console.log(`📋 Using tsconfig: ${tsConfigPath}\n`);

  // Create analyzer
  const analyzer = new UniversalAnalyzer({
    tsConfigPath,
    corpusPath: path.resolve(__dirname, '../../../corpus'),
  });

  // Register ThrowingFunctionDetector plugin
  analyzer.registerPlugin(new ThrowingFunctionDetector());

  console.log('🔌 Registered plugins:');
  for (const plugin of analyzer.getPlugins()) {
    console.log(`   - ${plugin.name} v${plugin.version}`);
  }
  console.log();

  // Initialize analyzer (loads TypeScript program)
  console.log('⚙️  Initializing analyzer...');
  analyzer.initialize();
  console.log('✅ Analyzer initialized\n');

  // Run analysis
  console.log('🔍 Running analysis...');
  const result = analyzer.analyze();

  // Print results
  console.log('\n📊 Analysis Results:');
  console.log(`   Files analyzed: ${result.filesAnalyzed}`);
  console.log(`   Total detections: ${result.totalDetections}`);
  console.log(`   Total violations: ${result.totalViolations}`);
  console.log(`   Duration: ${result.duration}ms\n`);

  // Print detections by plugin
  console.log('🔍 Detections by plugin:');
  for (const [plugin, count] of result.statistics.byPlugin) {
    console.log(`   ${plugin}: ${count} detections`);
  }
  console.log();

  // Print detailed detections for first file
  if (result.files.length > 0) {
    const firstFile = result.files.find((f: FileAnalysisResult) => f.detections.length > 0);
    if (firstFile) {
      console.log(`📄 Detections in ${path.basename(firstFile.file)}:`);
      for (const detection of firstFile.detections.slice(0, 10)) {
        // Show first 10
        console.log(`   - ${detection.packageName}.${detection.functionName}`);
        console.log(`     Pattern: ${detection.pattern}`);
        console.log(`     Confidence: ${detection.confidence}`);
        if (detection.metadata) {
          console.log(`     Metadata: ${JSON.stringify(detection.metadata)}`);
        }
        console.log();
      }

      if (firstFile.detections.length > 10) {
        console.log(`   ... and ${firstFile.detections.length - 10} more\n`);
      }
    }
  }

  // Print any errors
  const filesWithErrors = result.files.filter((f: FileAnalysisResult) => f.errors.length > 0);
  if (filesWithErrors.length > 0) {
    console.log('❌ Errors encountered:');
    for (const file of filesWithErrors) {
      console.log(`   File: ${path.basename(file.file)}`);
      for (const error of file.errors) {
        console.log(`   - ${error.message}`);
      }
    }
    console.log();
  }

  console.log('✅ Test complete!');
}

// Run test
main().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
