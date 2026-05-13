import { stat } from 'node:fs/promises'
import type { Logger } from 'pino'
import { type CreateCarOptions, type CreateCarResult, cleanupTempCar, createCarFromPath } from './car-builder.js'

export * from './car-builder.js'
export { importerOptions, UNIXFS_PROFILE } from './importer-options.js'

export interface CarBuildResult {
  carPath: string
  rootCid: string
  name: string
  size?: number
}

export interface FileBuilder {
  buildCar(sourcePath: string, options?: CreateCarOptions): Promise<CarBuildResult>
  cleanup(carPath: string, logger?: Logger): Promise<void>
}

export function createUnixfsCarBuilder(): FileBuilder {
  return {
    async buildCar(sourcePath: string, options: CreateCarOptions = {}): Promise<CarBuildResult> {
      const { carPath, rootCid, name }: CreateCarResult = await createCarFromPath(sourcePath, options)

      let size: number | undefined
      try {
        const stats = await stat(carPath)
        size = stats.size
      } catch {
        size = undefined
      }

      const baseResult: CarBuildResult = {
        carPath,
        rootCid: rootCid.toString(),
        name,
      }

      return size !== undefined ? { ...baseResult, size } : baseResult
    },

    async cleanup(carPath: string, logger?: Logger): Promise<void> {
      await cleanupTempCar(carPath, logger)
    },
  }
}
