import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KernelRelease } from '../shared/types'
import { KernelManager } from './kernel-manager'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function release(payload: Buffer): KernelRelease {
  return {
    version: '144.0.7559.132',
    publishedAt: new Date().toISOString(),
    assetName: 'fixture',
    downloadUrl: 'https://github.com/example/fixture',
    size: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
    installed: false,
    remoteAvailable: true,
    origin: 'release'
  }
}

function download(manager: KernelManager, item: KernelRelease, destination: string): Promise<void> {
  return (manager as unknown as {
    download: (release: KernelRelease, destination: string) => Promise<void>
  }).download(item, destination)
}

describe('KernelManager download hardening', () => {
  it('replaces a stale symbolic-link destination without following it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-kernel-download-'))
    roots.push(root)
    const destination = join(root, 'kernel.download')
    const external = join(root, 'external.data')
    const payload = Buffer.from('verified-kernel-payload')
    await writeFile(external, 'external-content')
    await symlink(external, destination)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      body: Readable.from([payload]),
      headers: new Headers({ 'content-length': String(payload.length) })
    })))
    const manager = new KernelManager(root, {} as never, () => undefined)
    await download(manager, release(payload), destination)

    await expect(readFile(destination)).resolves.toEqual(payload)
    await expect(readFile(external, 'utf8')).resolves.toBe('external-content')
  })

  it('rejects an HTTP body that exceeds the signed artifact size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-kernel-download-overflow-'))
    roots.push(root)
    const destination = join(root, 'kernel.download')
    const expected = Buffer.from('short')
    const oversized = Buffer.concat([expected, Buffer.from('unexpected')])
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      body: Readable.from([oversized]),
      headers: new Headers({ 'content-length': String(oversized.length) })
    })))
    const manager = new KernelManager(root, {} as never, () => undefined)

    await expect(download(manager, release(expected), destination)).rejects.toThrow('超过发行包声明的大小')
  })
})
