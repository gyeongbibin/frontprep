import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { Command, CommanderError } from 'commander'

import { runCheck } from './commands/check.js'
import {
  createCommandServices,
  FRONTPREP_VERSION,
  runInit,
  type CommandServices,
} from './commands/init.js'
import { FrontprepError } from './core/errors.js'
import { ProcessFailure } from './core/process.js'
import { Reporter, type OutputWriter } from './core/reporter.js'

export interface CliIo {
  isTTY?: boolean
  writeErr(value: string): void
  writeOut(value: string): void
}

const DEFAULT_IO: CliIo = {
  isTTY: process.stdout.isTTY,
  writeErr: (value) => process.stderr.write(value),
  writeOut: (value) => process.stdout.write(value),
}

function writer(io: CliIo, target: 'err' | 'out'): OutputWriter {
  return {
    isTTY: io.isTTY,
    write: (value) =>
      target === 'out' ? io.writeOut(value) : io.writeErr(value),
  }
}

function servicesForIo(io: CliIo): CommandServices {
  return createCommandServices(
    new Reporter(writer(io, 'out'), writer(io, 'err')),
  )
}

export function createCli(
  services: CommandServices,
  io: CliIo = DEFAULT_IO,
): Command {
  const program = new Command()
  program
    .name('frontprep')
    .description('Apply and verify an opinionated frontend tooling baseline.')
    .version(FRONTPREP_VERSION)
    .exitOverride()
    .configureOutput({
      outputError: (value, write) => write(value),
      writeErr: (value) => io.writeErr(value),
      writeOut: (value) => io.writeOut(value),
    })

  program
    .command('init')
    .description('Apply every registered frontprep module.')
    .option('--cwd <path>', 'project root', process.cwd())
    .action(async ({ cwd }: { cwd: string }) => {
      await runInit({ cwd }, services)
    })

  program
    .command('check')
    .description('Verify frontprep configuration without changing files.')
    .option('--cwd <path>', 'project root', process.cwd())
    .action(async ({ cwd }: { cwd: string }) => runCheck({ cwd }, services))

  return program
}

export async function runCli(
  argv: readonly string[],
  suppliedServices?: CommandServices,
  io: CliIo = DEFAULT_IO,
): Promise<number> {
  const services = suppliedServices ?? servicesForIo(io)
  const diagnostics = new Reporter(writer(io, 'out'), writer(io, 'err'))
  try {
    await createCli(services, io).parseAsync([...argv], { from: 'node' })
    return 0
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version'
        ? 0
        : 2
    }
    if (error instanceof FrontprepError) {
      diagnostics.error(error)
      return error.exitCode
    }
    if (error instanceof ProcessFailure) {
      diagnostics.error(error)
      return 1
    }

    diagnostics.unexpected(
      error,
      randomUUID(),
      process.env.DEBUG === 'frontprep',
    )
    return 1
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runCli(process.argv)
}
