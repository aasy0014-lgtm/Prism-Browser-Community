import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'

const READ_ONLY_NOFOLLOW = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW
const MAX_COPIED_TEXT_BYTES = 16 * 1024 * 1024

/**
 * Write a small application-owned text file without following a pre-existing
 * temporary symlink and without exposing a partially-written destination.
 */
export async function writeAtomicText(path: string, value: string): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(value, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined

    try {
      await rename(temporary, path)
    } catch (error) {
      // Node cannot replace an existing destination on some Windows filesystems.
      // The temporary file is still unique and exclusively created, so only the
      // destination replacement needs this platform-specific fallback.
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code ?? '')) throw error
      await rm(path, { force: true })
      await rename(temporary, path)
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await writeAtomicText(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Copy an application-owned JSON/text file without following source or destination symlinks. */
export async function copyTextAtomic(source: string, destination: string): Promise<void> {
  const initial = await lstat(source)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_COPIED_TEXT_BYTES) {
    throw new Error('源文件不是受支持的文本文件')
  }
  const handle = await open(source, READ_ONLY_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== initial.size
      || opened.dev !== initial.dev || opened.ino !== initial.ino) throw new Error('源文件在复制期间发生变化')
    const value = await handle.readFile({ encoding: 'utf8' })
    const final = await handle.stat()
    if (!final.isFile() || final.isSymbolicLink() || final.size !== opened.size) throw new Error('源文件在复制期间发生变化')
    await writeAtomicText(destination, value)
  } finally {
    await handle.close().catch(() => undefined)
  }
}
