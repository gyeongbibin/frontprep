import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

interface PackageJson {
  bin: Record<string, string>
  engines: { node: string }
  files: string[]
  name: string
}

describe('package metadata', () => {
  it('publishes the frontprep executable and runtime assets', async () => {
    const contents = await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )
    const packageJson = JSON.parse(contents) as PackageJson

    expect(packageJson.name).toBe('@mingyeongbin/frontprep')
    expect(packageJson.bin).toEqual({ frontprep: 'dist/cli.js' })
    expect(packageJson.engines.node).toBe('>=20.9.0')
    expect(packageJson.files).toEqual(['dist', 'schema'])
  })
})
