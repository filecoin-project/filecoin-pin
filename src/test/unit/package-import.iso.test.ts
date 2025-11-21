import { describe, expect, it } from 'vitest'

describe('package import in Node.js', () => {
  it('doesnt throw when importing filecoin-pin', () => {
    expect(() => {
      import('filecoin-pin')
    }).not.toThrow()
  })

  it('browser and node.js exports are handled properly', async () => {
    const exports = await import('filecoin-pin')

    expect(typeof exports.createCarFromFile).toBe('function')
    expect(typeof exports.createCarFromFiles).toBe('function')
    expect(typeof exports.createCarFromPath).toBe('function')
    if (typeof window !== 'undefined') {
      expect(() => exports.createCarFromPath('foo')).toThrow('Function not available in the browser.')
    } else {
      await expect(exports.createCarFromPath('foo')).rejects.toThrow("ENOENT: no such file or directory, stat 'foo'")
    }
  })
})
