import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface KernelCriticalFile {
  path: string
  size: number
  sha256: string
}

export interface KernelIntegrityFields {
  criticalFiles?: KernelCriticalFile[]
  criticalFilesSha256?: string
}

export type KernelIntegrityResult =
  | { status: 'healthy'; files: number }
  | { status: 'legacy'; reason: string }
  | { status: 'corrupt'; reason: string }

const SHA256_PATTERN = /^[a-f\d]{64}$/i
const WINDOWS_CRITICAL_NAMES = [
  'chrome.dll',
  'chrome_elf.dll',
  'icudtl.dat',
  'resources.pak',
  'v8_context_snapshot.bin',
  'snapshot_blob.bin'
]
const READ_ONLY_NOFOLLOW = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW
const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024

function portableRelative(path: string): string {
  return path.split(sep).join('/')
}

function isSafePortableRelative(candidate: string): boolean {
  if (!candidate || candidate.includes('\0') || candidate.includes('\\') || candidate.startsWith('/')) return false
  const parts = candidate.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function resolveSafeRelative(root: string, candidate: string): string | undefined {
  if (!isSafePortableRelative(portableRelative(candidate)) || isAbsolute(candidate)) return undefined
  const normalizedRoot = resolve(root)
  const resolved = resolve(normalizedRoot, candidate)
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${sep}`)) return undefined
  return resolved
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink() && info.size > 0
  } catch {
    return false
  }
}

/** Read small metadata through the opened handle, not through a replaceable path. */
export async function readStableTextFile(path: string, maximum = MAX_TEXT_FILE_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_TEXT_FILE_BYTES) throw new Error('内核元数据大小限制无效')
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 1 || initial.size > maximum) {
    throw new Error('内核元数据文件无效')
  }
  const handle = await open(path, READ_ONLY_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== initial.size
      || opened.dev !== initial.dev || opened.ino !== initial.ino) throw new Error('内核元数据在读取期间发生变化')
    const buffer = Buffer.alloc(maximum + 1)
    const { bytesRead } = await handle.read({ buffer, position: 0 })
    if (bytesRead > maximum || bytesRead !== opened.size) throw new Error('内核元数据在读取期间发生变化')
    const final = await handle.stat()
    if (!final.isFile() || final.isSymbolicLink() || final.size !== opened.size) throw new Error('内核元数据在读取期间发生变化')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Hash the opened file handle so a path replacement cannot change the bytes mid-check. */
export async function hashStableFile(path: string, expectedSize?: number): Promise<string> {
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink()
    || expectedSize !== undefined && initial.size !== expectedSize) throw new Error('内核关键文件在校验期间发生变化')
  const handle = await open(path, READ_ONLY_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== initial.size
      || expectedSize !== undefined && opened.size !== expectedSize
      || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new Error('内核关键文件在校验期间发生变化')
    }
    const hash = createHash('sha256')
    let bytesRead = 0
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) {
      const data = chunk as Buffer
      bytesRead += data.length
      if (bytesRead > opened.size) throw new Error('内核关键文件在校验期间发生变化')
      hash.update(data)
    }
    const final = await handle.stat()
    if (!final.isFile() || final.isSymbolicLink() || final.size !== opened.size || bytesRead !== opened.size) {
      throw new Error('内核关键文件在校验期间发生变化')
    }
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function aggregateCriticalFiles(files: KernelCriticalFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`)
  return hash.digest('hex')
}

async function discoverMacFrameworkBinaries(root: string, executableRelative: string): Promise<string[]> {
  const parts = portableRelative(executableRelative).split('/')
  const appIndex = parts.findIndex((part) => part.endsWith('.app'))
  if (appIndex < 0) return []
  const appRelative = parts.slice(0, appIndex + 1).join('/')
  const versionsRelative = `${appRelative}/Contents/Frameworks/Chromium Framework.framework/Versions`
  const versionsPath = resolveSafeRelative(root, versionsRelative)
  if (!versionsPath) return []
  try {
    const entries = await readdir(versionsPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.name !== 'Current' && entry.isDirectory())
      .map((entry) => `${versionsRelative}/${entry.name}/Chromium Framework`)
      .sort()
  } catch {
    return []
  }
}

/**
 * Select the files that contain executable browser code or runtime data. The
 * list intentionally stays small so launch-time verification remains bounded.
 */
export async function discoverKernelCriticalPaths(root: string, executableRelative: string): Promise<string[]> {
  const normalizedExecutable = portableRelative(executableRelative)
  const candidates = new Set<string>([normalizedExecutable])
  const executableDirectory = portableRelative(dirname(normalizedExecutable))

  if (normalizedExecutable.toLowerCase().endsWith('.exe')) {
    for (const name of WINDOWS_CRITICAL_NAMES) {
      candidates.add(executableDirectory === '.' ? name : `${executableDirectory}/${name}`)
    }
  } else {
    for (const framework of await discoverMacFrameworkBinaries(root, normalizedExecutable)) candidates.add(framework)
  }

  const existing: string[] = []
  for (const candidate of candidates) {
    const absolute = resolveSafeRelative(root, candidate)
    if (absolute && await isNonEmptyFile(absolute)) existing.push(portableRelative(relative(resolve(root), absolute)))
  }
  return existing.sort()
}

export async function collectKernelIntegrity(
  root: string,
  executableRelative: string
): Promise<Required<KernelIntegrityFields>> {
  const paths = await discoverKernelCriticalPaths(root, executableRelative)
  if (!paths.includes(portableRelative(executableRelative))) {
    throw new Error('浏览器可执行文件不存在或为空')
  }
  const criticalFiles: KernelCriticalFile[] = []
  for (const path of paths) {
    const absolute = resolveSafeRelative(root, path)
    if (!absolute) throw new Error('内核关键文件路径越界')
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error('内核关键文件不能是符号链接')
    criticalFiles.push({ path, size: info.size, sha256: await hashStableFile(absolute, info.size) })
  }
  return { criticalFiles, criticalFilesSha256: aggregateCriticalFiles(criticalFiles) }
}

export function kernelPayloadIdentity(fields: Required<KernelIntegrityFields>, executableRelative: string): string {
  const executable = portableRelative(executableRelative)
  const records = fields.criticalFiles.map((file) => {
    let role = file.path === executable ? '@executable' : file.path.split('/').at(-1)?.toLowerCase() ?? file.path
    if (file.path.endsWith('/Chromium Framework')) role = '@framework'
    return `${role}\0${file.size}\0${file.sha256}`
  }).sort()
  return createHash('sha256').update(records.join('\n')).digest('hex')
}

export function validateKernelIntegrityFields(fields: KernelIntegrityFields, executableRelative: string): string | undefined {
  if (fields.criticalFiles === undefined && fields.criticalFilesSha256 === undefined) return undefined
  if (!Array.isArray(fields.criticalFiles) || fields.criticalFiles.length < 1 || fields.criticalFiles.length > 32
    || typeof fields.criticalFilesSha256 !== 'string' || !SHA256_PATTERN.test(fields.criticalFilesSha256)) {
    return '内核关键文件摘要字段无效'
  }
  const paths = new Set<string>()
  for (const file of fields.criticalFiles) {
    if (!file || typeof file.path !== 'string' || file.path !== portableRelative(file.path)
      || !isSafePortableRelative(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.size) || file.size <= 0
      || typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
      return '内核关键文件清单无效'
    }
    paths.add(file.path)
  }
  if (!paths.has(portableRelative(executableRelative))) return '内核关键文件清单缺少浏览器入口'
  const sorted = [...fields.criticalFiles].sort((first, second) =>
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0)
  if (sorted.some((file, index) => file.path !== fields.criticalFiles?.[index]?.path)) return '内核关键文件清单顺序无效'
  if (aggregateCriticalFiles(sorted) !== fields.criticalFilesSha256.toLowerCase()) return '内核关键文件聚合摘要无效'
  return undefined
}

export async function verifyKernelIntegrity(
  root: string,
  executableRelative: string,
  fields: KernelIntegrityFields
): Promise<KernelIntegrityResult> {
  if (fields.criticalFiles === undefined && fields.criticalFilesSha256 === undefined) {
    return { status: 'legacy', reason: '旧版内核清单只记录浏览器入口，未记录内核主体摘要' }
  }
  const invalid = validateKernelIntegrityFields(fields, executableRelative)
  if (invalid) return { status: 'corrupt', reason: invalid }

  for (const file of fields.criticalFiles ?? []) {
    const absolute = resolveSafeRelative(root, file.path)
    if (!absolute) return { status: 'corrupt', reason: `内核关键文件路径越界：${file.path}` }
    try {
      const info = await lstat(absolute)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
        return { status: 'corrupt', reason: `内核关键文件大小不一致：${file.path}` }
      }
      if (await hashStableFile(absolute, file.size) !== file.sha256.toLowerCase()) {
        return { status: 'corrupt', reason: `内核关键文件 SHA-256 不一致：${file.path}` }
      }
    } catch {
      return { status: 'corrupt', reason: `内核关键文件缺失：${file.path}` }
    }
  }
  return { status: 'healthy', files: fields.criticalFiles?.length ?? 0 }
}
