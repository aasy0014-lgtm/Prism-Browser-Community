import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, UpdateManager } from './update-manager'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'prism-update-manager-'))
  roots.push(root)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from('verified-update-payload')
  const kind = process.platform === 'win32' ? 'exe' as const : 'dmg' as const
  const artifact = {
    url: `https://updates.example.test/app.${kind}`,
    size: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
    kind
  }
  const unsigned = {
    schemaVersion: 1 as const,
    channel: 'beta' as const,
    distributionMode: 'internal-unsigned' as const,
    version: '9.9.9',
    publishedAt: new Date().toISOString(),
    notes: 'fixture',
    artifacts: { [`${process.platform}-${process.arch}`]: artifact }
  }
  const manifest = {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64')
  }
  const configPath = join(root, 'update-config.json')
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    channel: 'beta',
    distributionMode: 'internal-unsigned',
    manifestUrl: 'https://updates.example.test/manifest.json',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }))
  return { root, payload, artifact, manifest, configPath }
}

describe('UpdateManager download hardening', () => {
  it('serializes concurrent downloads and writes a verified artifact', async () => {
    const item = await fixture()
    const fetchMock = vi.fn(async (url: string) => url.includes('manifest')
      ? { ok: true, status: 200, headers: new Headers({ 'content-length': String(JSON.stringify(item.manifest).length) }), text: async () => JSON.stringify(item.manifest) }
      : { ok: true, status: 200, headers: new Headers({ 'content-length': String(item.payload.length) }), body: Readable.from([item.payload]) })
    vi.stubGlobal('fetch', fetchMock)
    const manager = new UpdateManager(item.root, '0.0.1', '/tmp', () => undefined, undefined, item.configPath)

    const [first, second] = await Promise.all([manager.download(), manager.download()])

    expect(first).toEqual(second)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(readFile(first.downloadedPath!)).resolves.toEqual(item.payload)
  })

  it.skipIf(process.platform === 'win32')('does not follow a symlink when revalidating the downloaded installer', async () => {
    const item = await fixture()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('manifest')
      ? { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(item.manifest) }
      : { ok: true, status: 200, headers: new Headers(), body: Readable.from([item.payload]) }))
    const manager = new UpdateManager(item.root, '0.0.1', '/tmp', () => undefined, undefined, item.configPath)
    const ready = await manager.download()
    const installer = ready.downloadedPath!
    const external = join(item.root, 'external.data')
    await writeFile(external, 'external-secret')
    await rm(installer)
    await symlink(external, installer)

    await expect(manager.downloadedPath()).rejects.toThrow('校验失败')
    await expect(readFile(external, 'utf8')).resolves.toBe('external-secret')
    await expect(readFile(installer)).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('does not download through a symlinked update directory', async () => {
    const item = await fixture()
    const downloads = join(item.root, 'downloads')
    const external = join(item.root, 'external-downloads')
    await mkdir(downloads)
    await mkdir(external)
    await symlink(external, join(downloads, 'app-updates'))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('manifest')
      ? { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(item.manifest) }
      : { ok: true, status: 200, headers: new Headers(), body: Readable.from([item.payload]) }))
    const manager = new UpdateManager(item.root, '0.0.1', '/tmp', () => undefined, undefined, item.configPath)

    await expect(manager.download()).rejects.toThrow('私有目录结构无效')
    await expect(readdir(external)).resolves.toEqual([])
  })
})
