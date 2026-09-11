import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpProfilePermission } from '../shared/types'
import { copyTextAtomic, readStableText, writeAtomicJson } from './atomic-file'

interface StoredPermissions {
  schemaVersion: 1
  permissions: McpProfilePermission[]
}

function validatePermission(value: unknown): McpProfilePermission {
  const permission = value as Partial<McpProfilePermission>
  if (!permission || typeof permission.profileId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(permission.profileId)
    || typeof permission.enabled !== 'boolean' || typeof permission.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(permission.updatedAt))) throw new Error('MCP 环境权限记录无效')
  return permission as McpProfilePermission
}

export class McpPermissionStore {
  readonly path: string
  readonly backupPath: string
  private permissions = new Map<string, McpProfilePermission>()
  private mutation: Promise<unknown> = Promise.resolve()

  constructor(vaultPath: string, private readonly now: () => Date = () => new Date()) {
    this.path = join(vaultPath, 'mcp', 'permissions.json')
    this.backupPath = `${this.path}.backup`
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await this.load(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await this.load(this.backupPath); await this.persist(false) }
        catch (backupError) {
          if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT') throw backupError
          await this.persist()
        }
        return
      }
      await this.load(this.backupPath)
      await this.persist(false)
    }
  }

  list(): McpProfilePermission[] {
    return [...this.permissions.values()].sort((first, second) => first.profileId.localeCompare(second.profileId)).map((item) => ({ ...item }))
  }

  enabled(profileId: string): boolean { return this.permissions.get(profileId)?.enabled === true }

  set(profileId: string, enabled: boolean): Promise<McpProfilePermission[]> {
    return this.mutate(async () => {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(profileId) || typeof enabled !== 'boolean') throw new Error('MCP 环境权限参数无效')
      this.permissions.set(profileId, { profileId, enabled, updatedAt: this.now().toISOString() })
      await this.persist()
      return this.list()
    })
  }

  remove(profileId: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.permissions.delete(profileId)) return
      await this.persist()
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutation.then(operation, operation)
    this.mutation = current.then(() => undefined, () => undefined)
    return current
  }

  private async load(path: string): Promise<void> {
    const value = JSON.parse(await readStableText(path, 4 * 1024 * 1024)) as Partial<StoredPermissions>
    if (value.schemaVersion !== 1 || !Array.isArray(value.permissions) || value.permissions.length > 1000) throw new Error('MCP 权限文件格式无效')
    const permissions = value.permissions.map(validatePermission)
    if (new Set(permissions.map((item) => item.profileId)).size !== permissions.length) throw new Error('MCP 权限文件包含重复环境')
    this.permissions = new Map(permissions.map((item) => [item.profileId, item]))
  }

  private async persist(backupExisting = true): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    if (backupExisting) {
      try { await copyTextAtomic(this.path, this.backupPath) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const value: StoredPermissions = { schemaVersion: 1, permissions: this.list() }
    await writeAtomicJson(this.path, value)
  }
}
