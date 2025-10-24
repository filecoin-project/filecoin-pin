import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch as any

// Mock os.homedir
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof os>('node:os')
  return {
    ...actual,
    homedir: vi.fn(),
  }
})

describe('Telemetry', () => {
  let testDir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    // Create temporary test directory
    testDir = join(tmpdir(), `filecoin-pin-test-${randomUUID()}`)
    mkdirSync(testDir, { recursive: true })

    // Save original environment
    originalEnv = { ...process.env }

    // Mock homedir to use test directory
    vi.mocked(os.homedir).mockReturnValue(testDir)

    // Reset fetch mock
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
    } as Response)
  })

  afterEach(() => {
    // Restore environment
    process.env = originalEnv

    // Clean up test directory
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  })

  it('should create telemetry ID file on first run', async () => {
    // Import module fresh for each test
    const { trackFirstRun } = await import('../../core/telemetry.js')

    trackFirstRun('0.7.3')

    // Wait for async operation
    await new Promise((resolve) => setTimeout(resolve, 100))

    const telemetryFile = join(testDir, '.filecoin-pin', '.telemetry-id')
    expect(existsSync(telemetryFile)).toBe(true)

    const telemetryId = readFileSync(telemetryFile, 'utf-8').trim()
    expect(telemetryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('should send telemetry event on first run', async () => {
    const { trackFirstRun } = await import('../../core/telemetry.js')

    trackFirstRun('0.7.3')

    // Wait for async operation
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://eomwm816g3v5sar.m.pipedream.net',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
    )

    const callArgs = mockFetch.mock.calls[0]
    if (!callArgs) throw new Error('Expected fetch to be called')
    const body = JSON.parse(callArgs[1].body)

    expect(body).toMatchObject({
      event: 'cli_first_run',
      version: '0.7.3',
      platform: process.platform,
    })
    expect(body.anonymousId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('should not send telemetry when disabled via environment variable', async () => {
    process.env.FILECOIN_PIN_TELEMETRY_DISABLED = '1'

    const { trackFirstRun } = await import('../../core/telemetry.js')

    trackFirstRun('0.7.3')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('should handle function call without throwing', async () => {
    const { trackFirstRun } = await import('../../core/telemetry.js')

    // Should not throw even if network fails
    expect(() => trackFirstRun('0.7.3')).not.toThrow()
  })
})
