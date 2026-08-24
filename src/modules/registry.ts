import { ConflictError } from '../core/errors.js'
import { MODULE_ORDER } from '../core/types.js'
import { ciModule } from './ci.js'
import { gitHooksModule } from './git-hooks.js'
import { qualityModule } from './quality.js'
import { tailwindModule } from './tailwind.js'
import { testModule } from './test.js'
import type { SetupModule } from './types.js'

export const DEFAULT_MODULES: readonly SetupModule[] = Object.freeze([
  qualityModule,
  tailwindModule,
  testModule,
  gitHooksModule,
  ciModule,
])

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
