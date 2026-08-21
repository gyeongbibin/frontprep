import type { ProjectContext } from './types.js'

export function freezeProjectContext(context: ProjectContext): ProjectContext {
  return Object.freeze({
    ...context,
    packageJson: Object.freeze(context.packageJson),
    packageManager: Object.freeze(context.packageManager),
  })
}
