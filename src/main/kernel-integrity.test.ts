import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashStableFile, readStableTextFile } from './kernel-integrity'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('kernel file integrity reads', () => {
  it('reads and hashes a stable regular file through an opened handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-kernel-integrity-'))
    roots.push(root)
    const path = join(root, 'manifest.json')
    const content = '{"schemaVersion":2}\n'
    await writeFile(path, content)

    await expect(readStableTextFile(path)).resolves.toBe(content)
    await expect(hashStableFile(path)).resolves.toBe(createHash('sha256').update(content).digest('hex'))
  })

  it.skipIf(process.platform === 'win32')('rejects metadata and payload symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-kernel-integrity-link-'))
    roots.push(root)
    const target = join(root, 'target')
    const link = join(root, 'link')
    await writeFile(target, 'sensitive')
    await symlink(target, link)

    await expect(readStableTextFile(link)).rejects.toThrow()
    await expect(hashStableFile(link)).rejects.toThrow()
    await expect(readFile(target, 'utf8')).resolves.toBe('sensitive')
  })
})
