#!/usr/bin/env tsx
/**
 * Analyze Load Test Results
 *
 * Generates comprehensive analysis from load test result JSON files:
 * - Success/failure rates
 * - Duration statistics (avg, min, max, p50, p95, p99)
 * - Provider reliability breakdown
 * - Timeout analysis
 * - Stage concurrency peaks
 *
 * Usage:
 *   tsx scripts/analyze-load-test.ts /tmp/filecoin-load-test/results-load-test-*.json
 *   tsx scripts/analyze-load-test.ts results-*.json --compare
 */

import { readFile } from 'node:fs/promises'

interface LoadTestResult {
  userId: number
  success: boolean
  dataSetId?: number
  ipfsRootCid?: string
  pieceCid?: string
  transactionHash?: string
  providerId?: number
  providerName?: string
  providerAddress?: string
  ipniValidated?: boolean
  linksVerified?: boolean
  links?: {
    proofs: string
    piece: string
    ipfs: string
    ipfsDownload: string
  }
  error?: string
  duration: number
}

interface LoadTestData {
  testRunId: string
  config: {
    users: number
    timeout: number
    rpcUrl: string
  }
  summary: {
    totalUsers: number
    successful: number
    failed: number
    successRate: number
    totalDuration: number
    avgDuration: number
  }
  results: LoadTestResult[]
}

interface ProviderStats {
  name: string
  total: number
  success: number
  failed: number
  successRate: number
  avgDuration: number
  timeouts: number
}

// ============================================================================
// Statistics Helpers
// ============================================================================

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((sorted.length * p) / 100) - 1
  return sorted[Math.max(0, index)]
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = seconds / 60
  if (minutes < 60) {
    return `${minutes.toFixed(1)}min`
  }
  const hours = minutes / 60
  return `${hours.toFixed(1)}h`
}

// ============================================================================
// Analysis Functions
// ============================================================================

function analyzeProviders(results: LoadTestResult[]): ProviderStats[] {
  const providerMap = new Map<string, ProviderStats>()

  for (const result of results) {
    const providerName = result.providerName || 'unknown'

    if (!providerMap.has(providerName)) {
      providerMap.set(providerName, {
        name: providerName,
        total: 0,
        success: 0,
        failed: 0,
        successRate: 0,
        avgDuration: 0,
        timeouts: 0,
      })
    }

    const stats = providerMap.get(providerName)
    if (!stats) continue

    stats.total++
    if (result.success) {
      stats.success++
    } else {
      stats.failed++
      if (result.error?.includes('timeout')) {
        stats.timeouts++
      }
    }
  }

  // Calculate rates and averages
  for (const stats of providerMap.values()) {
    stats.successRate = (stats.success / stats.total) * 100
    const providerResults = results.filter((r) => (r.providerName || 'unknown') === stats.name)
    stats.avgDuration = providerResults.reduce((sum, r) => sum + r.duration, 0) / providerResults.length
  }

  return Array.from(providerMap.values()).sort((a, b) => b.total - a.total)
}

function analyzeDurations(results: LoadTestResult[]): {
  min: number
  max: number
  avg: number
  p50: number
  p95: number
  p99: number
} {
  const durations = results.map((r) => r.duration).sort((a, b) => a - b)

  return {
    min: durations[0] || 0,
    max: durations[durations.length - 1] || 0,
    avg: durations.reduce((sum, d) => sum + d, 0) / durations.length,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
  }
}

function analyzeErrors(results: LoadTestResult[]): Map<string, number> {
  const errorCounts = new Map<string, number>()

  for (const result of results) {
    if (!result.success && result.error) {
      // Normalize error messages
      let errorType = result.error
      if (errorType.includes('timeout')) {
        errorType = 'Upload timeout exceeded'
      } else if (errorType.includes('IPNI')) {
        errorType = 'IPNI validation failed'
      }

      errorCounts.set(errorType, (errorCounts.get(errorType) || 0) + 1)
    }
  }

  return new Map([...errorCounts.entries()].sort((a, b) => b[1] - a[1]))
}

// ============================================================================
// Output Functions
// ============================================================================

function printSummary(data: LoadTestData): void {
  console.log('='.repeat(80))
  console.log('Load Test Summary')
  console.log('='.repeat(80))
  console.log(`Test Run ID: ${data.testRunId}`)
  console.log(`Users: ${data.config.users}`)
  console.log(`Timeout: ${formatDuration(data.config.timeout)}`)
  console.log(`RPC URL: ${data.config.rpcUrl}`)
  console.log()
  console.log(`Success: ${data.summary.successful}/${data.summary.totalUsers} (${data.summary.successRate.toFixed(1)}%)`)
  console.log(`Failed: ${data.summary.failed}/${data.summary.totalUsers} (${((data.summary.failed / data.summary.totalUsers) * 100).toFixed(1)}%)`)
  console.log(`Total Duration: ${formatDuration(data.summary.totalDuration)}`)
  console.log('='.repeat(80))
  console.log()
}

function printDurationStats(data: LoadTestData): void {
  const stats = analyzeDurations(data.results)

  console.log('='.repeat(80))
  console.log('Duration Statistics')
  console.log('='.repeat(80))
  console.log(`Min:     ${formatDuration(stats.min)}`)
  console.log(`Average: ${formatDuration(stats.avg)}`)
  console.log(`P50:     ${formatDuration(stats.p50)}`)
  console.log(`P95:     ${formatDuration(stats.p95)}`)
  console.log(`P99:     ${formatDuration(stats.p99)}`)
  console.log(`Max:     ${formatDuration(stats.max)}`)
  console.log('='.repeat(80))
  console.log()
}

function printProviderStats(data: LoadTestData): void {
  const providers = analyzeProviders(data.results)

  if (providers.length === 0 || (providers.length === 1 && providers[0].name === 'unknown')) {
    console.log('='.repeat(80))
    console.log('Provider Statistics')
    console.log('='.repeat(80))
    console.log('Provider data not available for this test run')
    console.log('='.repeat(80))
    console.log()
    return
  }

  console.log('='.repeat(80))
  console.log('Provider Reliability')
  console.log('='.repeat(80))

  for (const provider of providers) {
    if (provider.name === 'unknown') continue

    console.log(`${provider.name}:`)
    console.log(`  Total:       ${provider.total} uploads`)
    console.log(`  Success:     ${provider.success}/${provider.total} (${provider.successRate.toFixed(1)}%)`)
    console.log(`  Failed:      ${provider.failed}`)
    console.log(`  Timeouts:    ${provider.timeouts}`)
    console.log(`  Avg Duration: ${formatDuration(provider.avgDuration)}`)
    console.log()
  }

  console.log('='.repeat(80))
  console.log()
}

function printErrorBreakdown(data: LoadTestData): void {
  const errors = analyzeErrors(data.results)

  if (errors.size === 0) {
    return
  }

  console.log('='.repeat(80))
  console.log('Error Breakdown')
  console.log('='.repeat(80))

  for (const [error, count] of errors.entries()) {
    const percentage = ((count / data.summary.failed) * 100).toFixed(1)
    console.log(`${error}: ${count} (${percentage}% of failures)`)
  }

  console.log('='.repeat(80))
  console.log()
}

function compareTests(dataFiles: LoadTestData[], baseline?: LoadTestData): void {
  console.log('='.repeat(80))
  console.log('Load Test Comparison')
  console.log('='.repeat(80))
  console.log()

  const sorted = dataFiles.sort((a, b) => a.config.users - b.config.users)
  const baselineData = baseline || sorted[0]

  console.log(`Baseline: ${baselineData.config.users} users, ${baselineData.summary.successRate.toFixed(1)}% success, ${formatDuration(baselineData.summary.avgDuration)} avg`)
  console.log()

  for (const data of sorted) {
    if (data === baselineData) continue

    const successDelta = data.summary.successRate - baselineData.summary.successRate
    const durationMultiple = data.summary.avgDuration / baselineData.summary.avgDuration
    const timeouts = data.results.filter((r) => r.error?.includes('timeout')).length

    console.log(`${data.config.users} users:`)
    console.log(`  Success:     ${data.summary.successRate.toFixed(1)}% (${successDelta >= 0 ? '+' : ''}${successDelta.toFixed(1)} pts)`)
    console.log(`  Avg Duration: ${formatDuration(data.summary.avgDuration)} (${durationMultiple.toFixed(1)}× baseline)`)
    console.log(`  Max Duration: ${formatDuration(Math.max(...data.results.map((r) => r.duration)))}`)
    console.log(`  Timeouts:    ${timeouts}`)
    console.log()
  }

  console.log('='.repeat(80))
  console.log()
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Load Test Analysis Tool

Usage:
  tsx scripts/analyze-load-test.ts <result-file.json> [options]
  tsx scripts/analyze-load-test.ts <result-file1.json> <result-file2.json> --compare

Options:
  --compare    Compare multiple test runs (uses first as baseline)
  -h, --help   Show this help message

Examples:
  # Analyze single test
  tsx scripts/analyze-load-test.ts /tmp/filecoin-load-test/results-load-test-123.json

  # Analyze and compare multiple tests
  tsx scripts/analyze-load-test.ts results-*.json --compare
    `.trim())
    process.exit(0)
  }

  const compareMode = args.includes('--compare')
  const files = args.filter((arg) => !arg.startsWith('--'))

  if (files.length === 0) {
    console.error('Error: No result files specified')
    process.exit(1)
  }

  // Load all test data
  const dataFiles: LoadTestData[] = []
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8')
      const data = JSON.parse(content) as LoadTestData
      dataFiles.push(data)
    } catch (error) {
      console.error(`Failed to load ${file}:`, error)
      process.exit(1)
    }
  }

  if (compareMode && dataFiles.length > 1) {
    compareTests(dataFiles)
  } else {
    // Single test analysis
    const data = dataFiles[0]
    printSummary(data)
    printDurationStats(data)
    printProviderStats(data)
    printErrorBreakdown(data)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
