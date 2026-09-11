import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { ProfileBackupManager } from './profile-backup'
import { ProfileStore } from './profile-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ProfileBackupManager', () => {
  it('encrypts the manifest and browser data before importing as a new environment', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-backup-vault-'))
    const destination = await mkdtemp(join(tmpdir(), 'prism-backup-output-'))
    temporaryPaths.push(vault, destination)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.name = '迁移环境'
    draft.extensionIds = ['11111111-1111-1111-1111-111111111111']
    draft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'secret-password' }
    const source = await profiles.create(draft)
    const sourceData = profiles.profileDataPath(source.id)
    const browserData = new Map([
      ['Default/Cookies.test', 'session-data'],
      ['Default/Local Storage/leveldb/000003.log', 'local-storage'],
      ['Default/IndexedDB/http_localhost_0.indexeddb.leveldb/000003.log', 'indexed-db'],
      ['Default/Service Worker/CacheStorage/cache-entry', 'cache-storage'],
      ['Default/Service Worker/Database/000003.log', 'service-worker'],
      ['Default/File System/Origins/000003.log', 'origin-file-system']
    ])
    for (const [relativePath, content] of browserData) {
      const path = join(sourceData, relativePath)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, content)
    }
    const manager = new ProfileBackupManager(profiles, '0.1.0')

    const archive = join(destination, 'profile.prism-backup')
    const exported = await manager.export(source.id, archive, 'correct horse battery staple')
    const archiveBytes = await readFile(exported.path)
    expect(archiveBytes.includes(Buffer.from('secret-password'))).toBe(false)
    expect(archiveBytes.includes(Buffer.from('session-data'))).toBe(false)
    expect(archiveBytes.includes(Buffer.from('迁移环境'))).toBe(false)

    const imported = await manager.import(exported.path, 'correct horse battery staple')
    expect(imported.profile.id).not.toBe(source.id)
    expect(imported.profile.name).toContain('迁移')
    expect(imported.profile.proxy.password).toBe('')
    expect(imported.profile.extensionIds).toEqual([])
    for (const [relativePath, content] of browserData) {
      await expect(readFile(join(profiles.profileDataPath(imported.profile.id), relativePath), 'utf8')).resolves.toBe(content)
    }
    expect(JSON.parse(await readFile(profiles.profileOwnerPath(imported.profile.id), 'utf8')).profileId).toBe(imported.profile.id)

    const profileCount = profiles.list().length
    const tampered = join(destination, 'tampered.prism-backup')
    const tamperedBytes = Buffer.from(archiveBytes)
    tamperedBytes[tamperedBytes.length - 1] ^= 0xff
    await writeFile(tampered, tamperedBytes)
    await expect(manager.import(tampered, 'correct horse battery staple')).rejects.toThrow(/损坏|认证|authenticate/)
    expect(profiles.list()).toHaveLength(profileCount)
    expect(await profiles.listTrash()).toHaveLength(0)
    expect((await readdir(vault)).filter((name) => name.startsWith('.profile-backup-import-'))).toEqual([])
  })

  it('rejects an unencrypted legacy backup before creating an imported environment', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-backup-vault-'))
    const source = await mkdtemp(join(tmpdir(), 'prism-backup-input-'))
    temporaryPaths.push(vault, source)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    await mkdir(join(source, 'user-data'))
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ schemaVersion: 1, profile: defaultProfileDraft() }))

    const manager = new ProfileBackupManager(profiles, '0.1.0')
    await expect(manager.import(source, 'correct horse battery staple')).rejects.toThrow('加密备份文件无效')
    expect(profiles.list()).toHaveLength(0)
  })

  it('round-trips a profile with an empty data directory', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-backup-empty-vault-'))
    const destination = await mkdtemp(join(tmpdir(), 'prism-backup-empty-output-'))
    temporaryPaths.push(vault, destination)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const source = await profiles.create(defaultProfileDraft())
    const manager = new ProfileBackupManager(profiles, '0.3.10')

    const exported = await manager.export(source.id, join(destination, 'empty.prism-backup'), 'correct horse battery staple')
    expect(exported).toMatchObject({ fileCount: 0, totalBytes: 0 })
    const imported = await manager.import(exported.path, 'correct horse battery staple')
    expect(imported.result).toMatchObject({ fileCount: 0, totalBytes: 0 })
    await expect(readdir(profiles.profileDataPath(imported.profile.id))).resolves.toEqual([])
  })
})
