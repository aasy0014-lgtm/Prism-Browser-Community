import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../shared/types'
import { readStableText, writeAtomicJson } from './atomic-file'

export class SettingsStore {
  private settings: AppSettings = { browserExecutable: '', fingerprintKernel: false, enginePreference: 'auto', recycleRetentionDays: 0 }
  private readonly path: string

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'settings.json')
  }

  async initialize(): Promise<void> {
    try {
      const stored = JSON.parse(await readStableText(this.path, 1024 * 1024)) as Partial<AppSettings>
      this.settings = {
        browserExecutable: typeof stored.browserExecutable === 'string' ? stored.browserExecutable : '',
        fingerprintKernel: stored.fingerprintKernel === true,
        enginePreference: stored.enginePreference === 'bundled' || stored.enginePreference === 'system' ? stored.enginePreference : 'auto',
        recycleRetentionDays: stored.recycleRetentionDays === 7 || stored.recycleRetentionDays === 30 || stored.recycleRetentionDays === 90
          ? stored.recycleRetentionDays
          : 0
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch }
    await mkdir(dirname(this.path), { recursive: true })
    await writeAtomicJson(this.path, this.settings)
    return this.get()
  }

  async hasConfiguredExecutable(): Promise<boolean> {
    if (!this.settings.browserExecutable) return false
    try {
      await access(this.settings.browserExecutable, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}
