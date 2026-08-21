import { ConflictError } from '../errors.js'
import type { ConfigFragmentIntent, ConfigValue } from '../intents.js'

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function renderValue(value: ConfigValue): string {
  if (typeof value === 'string') {
    return quote(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(quote).join(', ')}]`
  }
  return String(value)
}

export function composePrettierConfig(
  fragments: readonly ConfigFragmentIntent[],
): string {
  const values = new Map<string, ConfigValue>()
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment.values)) {
      const existing = values.get(key)
      if (Array.isArray(value)) {
        const previous = Array.isArray(existing) ? existing : []
        values.set(key, [...new Set([...previous, ...value])].sort())
      } else if (existing !== undefined && existing !== value) {
        throw new ConflictError(`Conflicting Prettier value for ${key}.`)
      } else {
        values.set(key, value)
      }
    }
  }

  const plugins = values.get('plugins')
  if (Array.isArray(plugins)) {
    const withoutTailwind = plugins.filter(
      (plugin) => plugin !== 'prettier-plugin-tailwindcss',
    )
    values.set(
      'plugins',
      plugins.includes('prettier-plugin-tailwindcss')
        ? [...withoutTailwind, 'prettier-plugin-tailwindcss']
        : withoutTailwind,
    )
  }

  const properties = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `  ${key}: ${renderValue(value)},`)
    .join('\n')

  return [
    "/** @type {import('prettier').Config} */",
    'const config = {',
    properties,
    '}',
    '',
    'export default config',
    '',
  ].join('\n')
}
