import { lstat, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appendPrivateText } from './atomic-file'

export interface SchedulerAuditEvent {
  action: 'task-create' | 'task-update' | 'task-enable' | 'task-disable' | 'task-remove' | 'task-run' | 'task-skip'
  outcome: 'success' | 'failure' | 'skipped'
  taskId?: string
  profileId?: string
  attempt?: number
  detail?: string
}

export class SchedulerAuditLog {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'logs', 'scheduler-audit.jsonl')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      const info = await lstat(this.path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('计划审计日志无效')
      if (info.size >= 10 * 1024 * 1024) await rename(this.path, `${this.path}.previous`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await appendPrivateText(this.path, '')
  }

  record(event: SchedulerAuditEvent): void {
    const safe = {
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      ...event,
      taskId: event.taskId?.slice(0, 100),
      profileId: event.profileId?.slice(0, 100),
      detail: event.detail?.slice(0, 300)
    }
    this.queue = this.queue.then(() => appendPrivateText(this.path, `${JSON.stringify(safe)}\n`))
      .catch(() => undefined)
  }

  flush(): Promise<void> { return this.queue }
}
