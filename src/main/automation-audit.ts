import { lstat, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appendPrivateText } from './atomic-file'

export interface AutomationAuditEvent {
  action: 'agent-start' | 'agent-stop' | 'emergency-stop' | 'profiles-list' | 'profile-status' | 'profile-launch' | 'profile-close'
  outcome: 'allowed' | 'success' | 'failure'
  requestId?: string
  profileId?: string
  detail?: string
}

export class AutomationAuditLog {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'logs', 'automation-audit.jsonl')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      const info = await lstat(this.path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('自动化审计日志无效')
      if (info.size >= 10 * 1024 * 1024) await rename(this.path, `${this.path}.previous`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await appendPrivateText(this.path, '')
  }

  record(event: AutomationAuditEvent): void {
    const safe = {
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      ...event,
      requestId: event.requestId?.slice(0, 100),
      profileId: event.profileId?.slice(0, 100),
      detail: event.detail?.slice(0, 300)
    }
    const line = `${JSON.stringify(safe)}\n`
    this.queue = this.queue.then(() => appendPrivateText(this.path, line))
      .catch(() => undefined)
  }

  flush(): Promise<void> { return this.queue }
}
