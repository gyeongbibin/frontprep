import { spawn } from 'node:child_process'

export interface ProcessOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  input?: string | Uint8Array
  signal?: AbortSignal
}

export interface ProcessResult {
  exitCode: number
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

export class ProcessFailure extends Error {
  readonly args: readonly string[]
  readonly command: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly stdout: string

  constructor(
    command: string,
    args: readonly string[],
    result: Omit<ProcessResult, 'exitCode'> & { exitCode: number | null },
    cause?: unknown,
  ) {
    super(
      `Command failed: ${[command, ...args].map((value) => JSON.stringify(value)).join(' ')}`,
      { cause },
    )
    this.name = new.target.name
    this.args = Object.freeze([...args])
    this.command = command
    this.exitCode = result.exitCode
    this.signal = result.signal
    this.stderr = result.stderr
    this.stdout = result.stdout
  }
}

export class ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let spawnError: unknown

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.once('error', (error) => {
        spawnError = error
      })

      const abort = (): void => {
        child.kill('SIGTERM')
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted === true) abort()

      child.once('close', (exitCode, signal) => {
        options.signal?.removeEventListener('abort', abort)
        const result = {
          exitCode,
          signal,
          stderr: Buffer.concat(stderr).toString('utf8'),
          stdout: Buffer.concat(stdout).toString('utf8'),
        }
        if (exitCode === 0) {
          resolve({ ...result, exitCode })
        } else {
          reject(new ProcessFailure(command, args, result, spawnError))
        }
      })

      if (options.input === undefined) {
        child.stdin.end()
      } else {
        child.stdin.end(options.input)
      }
    })
  }
}
