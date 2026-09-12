import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendPrivateText, copyTextAtomic, ensurePrivateDirectory, readStableText, writeAtomicJson } from './atomic-file'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('atomic file writes', () => {
  it('replaces JSON as one complete file with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-atomic-file-'))
    roots.push(root)
    const path = join(root, 'state.json')

    await writeAtomicJson(path, { version: 1 })
    await writeAtomicJson(path, { version: 2, ready: true })

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 2, ready: true })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(lstat(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads stable text and appends private log data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-atomic-log-'))
    roots.push(root)
    const path = join(root, 'audit.log')

    await appendPrivateText(path, 'first\n')
    await appendPrivateText(path, 'second\n')

    await expect(readStableText(path)).resolves.toBe('first\nsecond\n')
  })

  it.skipIf(process.platform === 'win32')('does not follow a pre-existing temporary symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-atomic-symlink-'))
    roots.push(root)
    const path = join(root, 'state.json')
    const secret = join(root, 'secret.txt')
    await writeFile(secret, 'unchanged')
    await symlink(secret, `${path}.tmp`)

    await writeAtomicJson(path, { safe: true })

    await expect(readFile(secret, 'utf8')).resolves.toBe('unchanged')
    await expect(readFile(path, 'utf8')).resolves.toContain('"safe": true')
  })

  it.skipIf(process.platform === 'win32')('does not follow a destination symlink while copying a backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-atomic-copy-'))
    roots.push(root)
    const source = join(root, 'source.json')
    const destination = join(root, 'backup.json')
    const secret = join(root, 'secret.txt')
    await writeFile(source, '{"safe":true}\n')
    await writeFile(secret, 'unchanged')
    await symlink(secret, destination)

    await copyTextAtomic(source, destination)

    await expect(readFile(secret, 'utf8')).resolves.toBe('unchanged')
    await expect(readFile(destination, 'utf8')).resolves.toContain('"safe":true')
  })

  it.skipIf(process.platform === 'win32')('does not append through a log symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-atomic-log-link-'))
    roots.push(root)
    const path = join(root, 'audit.log')
    const secret = join(root, 'secret.txt')
    await writeFile(secret, 'unchanged')
    await symlink(secret, path)

    await expect(appendPrivateText(path, 'must not leak')).rejects.toThrow()
    await expect(readFile(secret, 'utf8')).resolves.toBe('unchanged')
  })

  it.skipIf(process.platform === 'win32')('does not create files below a symlinked private directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-atomic-directory-link-'))
    roots.push(root)
    const external = join(root, 'external')
    const redirected = join(root, 'redirected')
    await mkdir(external)
    await symlink(external, redirected)

    await expect(ensurePrivateDirectory(join(redirected, 'nested'))).rejects.toThrow('私有目录结构无效')
    await expect(lstat(join(external, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
