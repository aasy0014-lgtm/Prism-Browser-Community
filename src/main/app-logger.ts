import { lstat, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { appendPrivateText } from './atomic-file'
import { redactSensitiveText } from './redaction'

export interface Logger {
  info(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}

function detailsText(details: unknown): string {
  if (details === undefined) return ''
  if (details instanceof Error) return ` ${redactSensitiveText(details.stack ?? details.message)}`
  try {
    return ` ${redactSensitiveText(JSON.stringify(details, (key, value) =>
      /password|passwd|secret|token|authorization/i.test(key) ? '[REDACTED]' : value
    ))}`
  } catch {
    return ` ${redactSensitiveText(String(details))}`
  }
}

export class AppLogger implements Logger {
  readonly directory: string
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string) {
    this.directory = join(vaultPath, 'logs')
    this.path = join(this.directory, 'prism.log')
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    try {
      const info = await lstat(this.path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('日志文件无效')
      if (info.size >= 5 * 1024 * 1024) {
        await rename(this.path, join(this.directory, 'prism.previous.log'))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await appendPrivateText(this.path, '')
  }

  info(message: string, details?: unknown): void {
    this.append('INFO', message, details)
  }

  error(message: string, details?: unknown): void {
    this.append('ERROR', message, details)
  }

  flush(): Promise<void> {
    return this.queue
  }

  private append(level: 'INFO' | 'ERROR', message: string, details?: unknown): void {
    const line = `${new Date().toISOString()} [${level}] ${message}${detailsText(details)}\n`
    this.queue = this.queue.then(() => appendPrivateText(this.path, line))
      .catch((error) => console.error('[logger] write failed', error))
  }
}
