import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
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

const temporaryRoot = mkdtempSync(join(tmpdir(), 'frontprep-package-'))
try {
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  )
  assert.deepEqual(packageJson.bin, { frontprep: 'dist/cli.js' })

  const packDirectory = join(temporaryRoot, 'pack')
  const installDirectory = join(temporaryRoot, 'install')
  mkdirSync(packDirectory)
  const packed = JSON.parse(
    execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', packDirectory],
      { cwd: root, encoding: 'utf8' },
    ),
  )[0]
  assert.deepEqual(
    packed.files.map(({ path }) => path),
    expectedFiles,
  )
  assert.equal(
    packed.files.find(({ path }) => path === 'dist/cli.js').mode,
    0o755,
  )

  const tarball = join(packDirectory, packed.filename)
  const installation = run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      installDirectory,
      tarball,
    ],
    { cwd: temporaryRoot },
  )
  assert.equal(installation.status, 0, installation.stderr)

  const cli = join(installDirectory, 'node_modules/.bin/frontprep')
  const installedEntry = join(
    installDirectory,
    'node_modules/@mingyeongbin/frontprep/dist/cli.js',
  )
  assert.equal(statSync(installedEntry).mode & 0o777, 0o755)
  assert.equal(
    readFileSync(installedEntry, 'utf8').startsWith('#!/usr/bin/env node\n'),
    true,
  )

  const help = run(cli, ['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /init \[options\]/u)
  assert.match(help.stdout, /check \[options\]/u)

  const version = run(cli, ['--version'])
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout, `${packageJson.version}\n`)

  const unsupportedRoot = join(temporaryRoot, 'unsupported')
  const unsupported = run(cli, ['init', '--cwd', unsupportedRoot])
  assert.equal(unsupported.status, 2)
  assert.match(unsupported.stderr, /does not exist/u)

  const supportedRoot = join(temporaryRoot, 'supported')
  cpSync(join(root, 'tests/fixtures/minimal-next'), supportedRoot, {
    recursive: true,
  })
  initializeGit(supportedRoot)
  const coreOnly = run(cli, ['init', '--cwd', supportedRoot])
  assert.equal(coreOnly.status, 1)
  assert.match(coreOnly.stderr, /Frontprep manifest is missing/u)

  process.stdout.write('frontprep package verified\n')
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}
