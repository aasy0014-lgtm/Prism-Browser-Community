import { lstat, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appendPrivateText } from './atomic-file'
import { safeErrorText } from './redaction'

export interface McpAuditEvent {
  action: 'permission-enable' | 'permission-disable' | 'profiles-list' | 'profile-status' | 'profile-launch' | 'profile-close'
    | 'page-open' | 'page-read' | 'page-click' | 'page-type'
    | 'session-start' | 'session-stop' | 'emergency-stop'
  outcome: 'allowed' | 'success' | 'failure'
  profileId?: string
  requestId?: string
  detail?: string
}

export class McpAuditLog {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string) { this.path = join(vaultPath, 'logs', 'mcp-audit.jsonl') }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      const info = await lstat(this.path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('MCP 审计日志无效')
      if (info.size >= 10 * 1024 * 1024) await rename(this.path, `${this.path}.previous`)
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await appendPrivateText(this.path, '')
  }

  record(event: McpAuditEvent): void {
    const safe = {
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      ...event,
      profileId: event.profileId?.slice(0, 100),
      requestId: event.requestId?.slice(0, 100),
      detail: event.detail ? safeErrorText(event.detail).slice(0, 300) : undefined
    }
    this.queue = this.queue.then(() => appendPrivateText(this.path, `${JSON.stringify(safe)}\n`)).catch(() => undefined)
  }

  flush(): Promise<void> { return this.queue }
}
