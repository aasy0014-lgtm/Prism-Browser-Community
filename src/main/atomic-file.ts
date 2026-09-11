import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { createWriteStream, type WriteStream } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'

const READ_ONLY_NOFOLLOW = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW
const APPEND_NOFOLLOW = process.platform === 'win32'
  ? 'a'
  : constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
const MAX_COPIED_TEXT_BYTES = 16 * 1024 * 1024
const MAX_STABLE_TEXT_BYTES = 16 * 1024 * 1024

export interface PrivateFileIdentity {
  dev: number
  ino: number
}

export interface PrivateWriteStream {
  stream: WriteStream
  identity: PrivateFileIdentity
  close: () => Promise<void>
}

function fileIdentity(value: { dev: number; ino: number }): PrivateFileIdentity {
  return { dev: value.dev, ino: value.ino }
}

function sameFileIdentity(first: PrivateFileIdentity, second: PrivateFileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

async function readStableHandleText(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
  maximum: number
): Promise<string> {
  const opened = await handle.stat()
  if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== expectedSize || opened.size > maximum) {
    throw new Error('文本文件在读取期间发生变化')
  }
  const buffer = Buffer.alloc(maximum + 1)
  let bytesRead = 0
  while (bytesRead < buffer.length) {
    const result = await handle.read({
      buffer,
      offset: bytesRead,
      length: buffer.length - bytesRead,
      position: bytesRead
    })
    if (!result.bytesRead) break
    bytesRead += result.bytesRead
  }
  if (bytesRead > maximum || bytesRead !== opened.size) throw new Error('文本文件在读取期间发生变化')
  const final = await handle.stat()
  if (!final.isFile() || final.isSymbolicLink() || final.size !== opened.size) {
    throw new Error('文本文件在读取期间发生变化')
  }
  return buffer.subarray(0, bytesRead).toString('utf8')
}

async function openPrivateStream(
  path: string,
  flags: string | number,
  expected?: PrivateFileIdentity
): Promise<PrivateWriteStream> {
  const handle = await open(path, flags, 0o600)
  let closed = false
  try {
    const opened = await handle.stat()
    const current = await lstat(path)
    const identity = fileIdentity(opened)
    if (!opened.isFile() || opened.isSymbolicLink() || !current.isFile() || current.isSymbolicLink()
      || !sameFileIdentity(identity, fileIdentity(current))
      || expected && !sameFileIdentity(identity, expected)) {
      throw new Error('私有文件在打开期间发生变化')
    }
    const stream = createWriteStream(path, { fd: handle.fd, autoClose: false })
    return {
      stream,
      identity,
      close: async () => {
        if (closed) return
        try {
          let final
          try {
            final = await handle.stat()
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'EBADF' || code === 'ERR_INVALID_STATE' || (error instanceof Error && error.message === 'file closed')) return
            throw error
          }
          const currentPath = await lstat(path)
          if (!final.isFile() || final.isSymbolicLink() || !currentPath.isFile() || currentPath.isSymbolicLink()
            || !sameFileIdentity(identity, fileIdentity(final))
            || !sameFileIdentity(identity, fileIdentity(currentPath))) {
            throw new Error('私有文件在写入期间发生变化')
          }
        } finally {
          closed = true
          await handle.close().catch(() => undefined)
        }
      }
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/** Open a new private file without following a pre-existing path. */
export function openPrivateExclusiveStream(path: string): Promise<PrivateWriteStream> {
  return openPrivateStream(path, 'wx')
}

/** Open an existing private file for append without following a replaceable path. */
export function openPrivateAppendStream(path: string, expected?: PrivateFileIdentity): Promise<PrivateWriteStream> {
  return openPrivateStream(path, APPEND_NOFOLLOW, expected)
}

/** Read a small application-owned text file through one stable file handle. */
export async function readStableText(path: string, maximum = MAX_STABLE_TEXT_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_STABLE_TEXT_BYTES) {
    throw new Error('文本文件大小限制无效')
  }
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 1 || initial.size > maximum) {
    throw new Error('文本文件无效')
  }
  const handle = await open(path, READ_ONLY_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== initial.size
      || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new Error('文本文件在读取期间发生变化')
    }
    return await readStableHandleText(handle, opened.size, maximum)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

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

/** Append to an application-owned log without following a replaceable path. */
export async function appendPrivateText(path: string, value: string, expected?: PrivateFileIdentity): Promise<void> {
  const writer = await openPrivateAppendStream(path, expected)
  try {
    await new Promise<void>((resolvePromise, reject) => {
      writer.stream.once('finish', resolvePromise)
      writer.stream.once('error', reject)
      writer.stream.end(value)
    })
  } finally {
    await writer.close()
  }
}

/** Append binary data to an application-owned file without following a replaceable path. */
export async function appendPrivateBuffer(path: string, value: Uint8Array, expected?: PrivateFileIdentity): Promise<void> {
  const writer = await openPrivateAppendStream(path, expected)
  try {
    await new Promise<void>((resolvePromise, reject) => {
      writer.stream.once('finish', resolvePromise)
      writer.stream.once('error', reject)
      writer.stream.end(value)
    })
  } finally {
    await writer.close()
  }
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
    const value = await readStableHandleText(handle, opened.size, MAX_COPIED_TEXT_BYTES)
    await writeAtomicText(destination, value)
  } finally {
    await handle.close().catch(() => undefined)
  }
}
