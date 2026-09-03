import type { ProjectContext } from './types.js'

export function freezeProjectContext(context: ProjectContext): ProjectContext {
  const layout = Object.freeze({
    ...context.layout,
    stylesheet: Object.freeze({ ...context.layout.stylesheet }),
    tests: Object.freeze({ ...context.layout.tests }),
    utilities: Object.freeze({ ...context.layout.utilities }),
  })
  return Object.freeze({
    ...context,
    layout,
    packageJson: Object.freeze(context.packageJson),
    packageManager: Object.freeze(context.packageManager),
  })
}
