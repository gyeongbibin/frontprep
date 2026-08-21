import { ConflictError } from '../core/errors.js'
import { MODULE_ORDER } from '../core/types.js'
import type { SetupModule } from './types.js'

export function createModuleRegistry(
  modules: readonly SetupModule[] = [],
): readonly SetupModule[] {
  const byId = new Map<SetupModule['id'], SetupModule>()
  for (const setupModule of modules) {
    if (byId.has(setupModule.id)) {
      throw new ConflictError(`Duplicate module: ${setupModule.id}`)
    }
    byId.set(setupModule.id, setupModule)
  }

  return Object.freeze(
    MODULE_ORDER.flatMap((moduleId) => {
      const setupModule = byId.get(moduleId)
      return setupModule === undefined ? [] : [setupModule]
    }),
  )
}
