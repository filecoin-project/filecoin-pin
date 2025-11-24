import { describe, expect, it } from 'vitest'

describe('filecoin-pin isomorphic import', () => {
  it('doesnt throw when importing filecoin-pin', async () => {
    await expect(import('filecoin-pin')).resolves.toBeDefined()
  })

  it('browser and node.js exports are handled properly', async () => {
    const { createCarFromPath, createCarFromFiles } = await import('filecoin-pin')

    expect(typeof createCarFromPath).toBe('function')
    expect(typeof createCarFromFiles).toBe('function')
    expect(typeof createCarFromPath).toBe('function')
    if (typeof window !== 'undefined') {
      expect(() => exports.createCarFromPath('foo')).toThrow('Function not available in the browser.')
    } else {
      await expect(exports.createCarFromPath('foo')).rejects.toThrow('ENOENT')
    }
  })
})
