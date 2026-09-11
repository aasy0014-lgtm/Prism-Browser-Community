import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { CookieManager, parseDevToolsPort, validateDevToolsWebSocket } from './cookie-manager'
import type { ProcessInspector, SystemProcess } from './process-inspector'
import { ProfileStore } from './profile-store'
import { SettingsStore } from './settings-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CookieManager process guard', () => {
  it('accepts only a loopback CDP endpoint matching the rendezvous port', () => {
    expect(parseDevToolsPort('9222\n/devtools/browser/test')).toBe(9222)
    expect(validateDevToolsWebSocket('ws://127.0.0.1:9222/devtools/page/test', 9222))
      .toBe('ws://127.0.0.1:9222/devtools/page/test')
    expect(() => parseDevToolsPort('0')).toThrow()
    expect(() => parseDevToolsPort('65536')).toThrow()
    expect(() => validateDevToolsWebSocket('ws://127.0.0.1:9223/devtools/page/test', 9222)).toThrow()
    expect(() => validateDevToolsWebSocket('ws://attacker.example/devtools/page/test', 9222)).toThrow()
    expect(() => validateDevToolsWebSocket('wss://127.0.0.1:9222/devtools/page/test', 9222)).toThrow()
    expect(() => validateDevToolsWebSocket('ws://127.0.0.1:9222/not-cdp', 9222)).toThrow()
  })

  it('does not alter a profile while an external browser owns its data directory', async () => {
    const settingsRoot = await mkdtemp(join(tmpdir(), 'prism-cookie-settings-'))
    const vault = await mkdtemp(join(tmpdir(), 'prism-cookie-vault-'))
    roots.push(settingsRoot, vault)
    const profiles = new ProfileStore(vault)
    const settings = new SettingsStore(settingsRoot)
    await Promise.all([profiles.initialize(), settings.initialize()])
    const profile = await profiles.create(defaultProfileDraft())
    const inspector: ProcessInspector = {
      list: async (): Promise<SystemProcess[]> => [{
        pid: 4242,
        command: `chromium --user-data-dir=${profiles.profileDataPath(profile.id)}`
      }],
      terminate: async () => undefined
    }
    const manager = new CookieManager(profiles, settings, undefined, inspector)

    await expect(manager.importCookies(profile.id, [])).rejects.toThrow('仍占用数据目录')
    expect(manager.isBusy(profile.id)).toBe(false)
  })

  it('fails closed when process inspection is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-cookie-manager-'))
    roots.push(root)
    const profiles = new ProfileStore(root)
    const settings = new SettingsStore(root)
    await Promise.all([profiles.initialize(), settings.initialize()])
    const profile = await profiles.create(defaultProfileDraft())
    const inspector: ProcessInspector = {
      list: async () => { throw new Error('permission denied') },
      terminate: async () => undefined
    }
    const manager = new CookieManager(profiles, settings, undefined, inspector)

    await expect(manager.importCookies(profile.id, [])).rejects.toThrow('无法检查浏览器进程占用状态')
    expect(manager.isBusy(profile.id)).toBe(false)
  })
})
