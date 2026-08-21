import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const cli = join(root, 'dist/cli.js')
const expectedFiles = [
  'README.md',
  'dist/cli.js',
  'dist/cli.js.map',
  'package.json',
  'schema/manifest-v1.json',
]

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })
}

function initializeGit(rootDirectory) {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'fixture@example.com'],
    ['config', 'user.name', 'Fixture'],
    ['add', '--all'],
    ['commit', '-m', 'fixture'],
  ]) {
    const result = run('git', args, { cwd: rootDirectory })
    assert.equal(result.status, 0, result.stderr)
  }
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.deepEqual(packageJson.bin, { frontprep: 'dist/cli.js' })

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  }),
)[0]
assert.deepEqual(
  packed.files.map(({ path }) => path),
  expectedFiles,
)
assert.equal(
  packed.files.find(({ path }) => path === 'dist/cli.js').mode,
  0o755,
)
assert.equal(statSync(cli).mode & 0o777, 0o755)
assert.equal(
  readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n'),
  true,
)

const help = run(process.execPath, [cli, '--help'])
assert.equal(help.status, 0, help.stderr)
assert.match(help.stdout, /init \[options\]/u)
assert.match(help.stdout, /check \[options\]/u)

const version = run(process.execPath, [cli, '--version'])
assert.equal(version.status, 0, version.stderr)
assert.equal(version.stdout, `${packageJson.version}\n`)

const unsupportedRoot = mkdtempSync(join(tmpdir(), 'frontprep-unsupported-'))
const unsupported = run(process.execPath, [
  cli,
  'init',
  '--cwd',
  unsupportedRoot,
])
assert.equal(unsupported.status, 2)
assert.match(unsupported.stderr, /package\.json/u)

const supportedRoot = mkdtempSync(join(tmpdir(), 'frontprep-supported-'))
cpSync(join(root, 'tests/fixtures/minimal-next'), supportedRoot, {
  recursive: true,
})
initializeGit(supportedRoot)
const coreOnly = run(process.execPath, [cli, 'init', '--cwd', supportedRoot])
assert.equal(coreOnly.status, 1)
assert.match(coreOnly.stderr, /Frontprep manifest is missing/u)

process.stdout.write('frontprep package verified\n')
