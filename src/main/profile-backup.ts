import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { BrowserProfile, ProfileBackupResult, ProfileDraft } from '../shared/types'
import { validateProfileDraft } from '../shared/validation'
import type { Logger } from './app-logger'
import type { ProfileStore } from './profile-store'

const MAGIC = Buffer.concat([Buffer.from('PRISM-PROFILE-BACKUP'), Buffer.from([1])])
const AUTH_TAG_BYTES = 16
const MAX_HEADER_BYTES = 64 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_RECORD_HEADER_BYTES = 64 * 1024
const MAX_BACKUP_FILES = 1_000_000
const MAX_BACKUP_BYTES = 500 * 1024 * 1024 * 1024
const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 1

interface ProfileBackupHeader {
  type: 'prism-profile-backup'
  schemaVersion: 1
  createdAt: string
  sourcePlatform: NodeJS.Platform
  sourceAppVersion: string
  cipher: 'aes-256-gcm'
  kdf: { name: 'scrypt'; n: number; r: number; p: number; salt: string }
  nonce: string
  keyCheck: string
}

interface ProfileBackupManifest {
  schemaVersion: 1
  profile: ProfileDraft
}

interface BackupRecord {
  type: 'manifest' | 'file' | 'end'
  size?: number
  path?: string
  fileCount?: number
  totalBytes?: number
  contentSha256?: string
}

function validatePassword(password: string): string {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw new Error('备份密码必须为 10–200 个字符')
  return password.normalize('NFKC')
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(validatePassword(password), salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolvePromise(key as Buffer)
    })
  })
}

function keyCheck(key: Buffer): Buffer {
  return createHmac('sha256', key).update('prism-profile-backup-key-check-v1').digest().subarray(0, 16)
}

function portableDraft(profile: BrowserProfile): ProfileDraft {
  return {
    name: profile.name,
    note: profile.note,
    group: profile.group,
    tags: [...profile.tags],
    extensionIds: [],
    color: profile.color,
    startUrls: [...profile.startUrls],
    kernelVersion: profile.kernelVersion,
    window: { ...profile.window },
    proxy: { ...profile.proxy, password: '', passwordStored: false },
    fingerprint: { ...profile.fingerprint, disabledSpoofing: [...profile.fingerprint.disabledSpoofing] }
  }
}

async function *safeFiles(root: string): AsyncGenerator<{ source: string; archivePath: string; size: number }> {
  const visit = async function *(current: string, currentRelative: string): AsyncGenerator<{ source: string; archivePath: string; size: number }> {
    const info = await lstat(current)
    // Chromium may leave ephemeral singleton links in the profile root. Never follow them.
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) {
      for (const entry of (await readdir(current)).sort()) {
        yield *visit(join(current, entry), join(currentRelative, entry))
      }
      return
    }
    if (!info.isFile()) return
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error(`备份文件大小无效：${currentRelative}`)
    yield { source: current, archivePath: currentRelative.split(sep).join('/'), size: info.size }
  }
  yield *visit(root, '')
}

async function writeChunk(stream: PassThrough, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain')
}

async function writeRecordHeader(stream: PassThrough, record: BackupRecord): Promise<void> {
  const value = Buffer.from(JSON.stringify(record))
  if (value.length <= 0 || value.length > MAX_RECORD_HEADER_BYTES) throw new Error('备份记录头超出安全限制')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(value.length)
  await writeChunk(stream, length)
  await writeChunk(stream, value)
}

function safeArchivePath(root: string, value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':') || part.includes('\u0000'))) {
    throw new Error('备份包含不安全的文件路径')
  }
  const target = resolve(root, ...value.split('/'))
  const normalizedRoot = resolve(root)
  if (!target.startsWith(`${normalizedRoot}${sep}`)) throw new Error('备份文件路径越界')
  return target
}

function insideOrEqual(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function canonicalPathForCreation(input: string): Promise<string> {
  const absolute = resolve(input)
  let existing = absolute
  while (true) {
    try {
      return resolve(await realpath(existing), relative(existing, absolute))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
}

async function assertTargetOutsideSource(source: string, target: string): Promise<void> {
  const canonicalSource = await realpath(source)
  const canonicalTarget = await canonicalPathForCreation(target)
  if (insideOrEqual(canonicalSource, canonicalTarget)) throw new Error('备份文件不能位于当前环境数据目录内部')
}

async function readExactAt(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read({ buffer, offset, length: buffer.length - offset, position: position + offset })
    if (!bytesRead) throw new Error('备份文件数据提前结束')
    offset += bytesRead
  }
}

class DecryptedReader {
  private readonly iterator: AsyncIterator<Buffer | string>
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  constructor(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
    this.iterator = stream[Symbol.asyncIterator]()
  }

  async readExactly(size: number): Promise<Buffer<ArrayBufferLike>> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('备份记录长度无效')
    while (this.buffer.length < size) {
      const next = await this.iterator.next()
      if (next.done) throw new Error('备份文件数据提前结束')
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    }
    const result = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return result
  }

  async copyExactly(size: number, target: string, digest: Hash): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    const output = createWriteStream(target, { flags: 'wx', mode: 0o600 })
    let remaining = size
    try {
      while (remaining > 0) {
        if (!this.buffer.length) {
          const next = await this.iterator.next()
          if (next.done) throw new Error('备份文件数据提前结束')
          this.buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
        }
        const length = Math.min(remaining, this.buffer.length)
        const chunk = this.buffer.subarray(0, length)
        this.buffer = this.buffer.subarray(length)
        digest.update(chunk)
        remaining -= length
        if (!output.write(chunk)) await once(output, 'drain')
      }
      output.end()
      await once(output, 'finish')
    } catch (error) {
      output.destroy()
      await rm(target, { force: true })
      throw error
    }
  }

  async ensureEnd(): Promise<void> {
    if (this.buffer.length) throw new Error('备份结束记录后仍有额外数据')
    const next = await this.iterator.next()
    if (!next.done) throw new Error('备份结束记录后仍有额外数据')
  }
}

function validateHeader(value: unknown): ProfileBackupHeader {
  const header = value as Partial<ProfileBackupHeader>
  if (!header || header.type !== 'prism-profile-backup' || header.schemaVersion !== 1
    || header.cipher !== 'aes-256-gcm' || header.kdf?.name !== 'scrypt'
    || header.kdf.n !== SCRYPT_N || header.kdf.r !== SCRYPT_R || header.kdf.p !== SCRYPT_P
    || typeof header.createdAt !== 'string' || typeof header.sourceAppVersion !== 'string'
    || typeof header.sourcePlatform !== 'string' || typeof header.nonce !== 'string'
    || typeof header.keyCheck !== 'string' || typeof header.kdf.salt !== 'string') {
    throw new Error('备份文件版本或加密参数不受支持')
  }
  return header as ProfileBackupHeader
}

function validateManifest(value: unknown): ProfileBackupManifest {
  const manifest = value as Partial<ProfileBackupManifest>
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.profile) throw new Error('备份清单无效或版本不受支持')
  return { schemaVersion: 1, profile: validateProfileDraft(manifest.profile) }
}

export class ProfileBackupManager {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly appVersion: string,
    private readonly logger?: Logger
  ) {}

  async export(profileId: string, destinationInput: string, passwordInput: string): Promise<ProfileBackupResult> {
    const password = validatePassword(passwordInput)
    const profile = this.profiles.get(profileId)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭浏览器环境再备份完整数据')
    await this.profiles.assertProfileDataIdentity(profileId)
    const source = this.profiles.profileDataPath(profileId)
    const destination = resolve(destinationInput)
    const parentInfo = await stat(dirname(destination))
    if (!parentInfo.isDirectory()) throw new Error('备份目标目录无效')
    await assertTargetOutsideSource(source, destination)
    try {
      await stat(destination)
      throw new Error('目标备份文件已经存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const staging = `${destination}.partial-${randomUUID()}`
    const salt = randomBytes(16)
    const nonce = randomBytes(12)
    const key = await deriveKey(password, salt)
    const header: ProfileBackupHeader = {
      type: 'prism-profile-backup', schemaVersion: 1, createdAt: new Date().toISOString(),
      sourcePlatform: process.platform, sourceAppVersion: this.appVersion, cipher: 'aes-256-gcm',
      kdf: { name: 'scrypt', n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('base64') },
      nonce: nonce.toString('base64'), keyCheck: keyCheck(key).toString('base64')
    }
    const headerBytes = Buffer.from(JSON.stringify(header))
    const headerLength = Buffer.allocUnsafe(4)
    headerLength.writeUInt32BE(headerBytes.length)
    const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, profile: portableDraft(profile) } satisfies ProfileBackupManifest))
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('备份清单过大')

    await writeFile(staging, Buffer.concat([MAGIC, headerLength, headerBytes]), { mode: 0o600, flag: 'wx' })
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(headerBytes)
    const input = new PassThrough()
    const completion = pipeline(input, cipher, createWriteStream(staging, { flags: 'a', mode: 0o600 }))
    const digest = createHash('sha256')
    let fileCount = 0
    let totalBytes = 0
    try {
      await writeRecordHeader(input, { type: 'manifest', size: manifestBytes.length })
      await writeChunk(input, manifestBytes)
      for await (const file of safeFiles(source)) {
        fileCount += 1
        totalBytes += file.size
        if (fileCount > MAX_BACKUP_FILES) throw new Error('备份数据文件数量超过 100 万')
        if (totalBytes > MAX_BACKUP_BYTES) throw new Error('备份数据超过 500 GB')
        await writeRecordHeader(input, { type: 'file', path: file.archivePath, size: file.size })
        digest.update(file.archivePath).update('\0').update(String(file.size)).update('\0')
        let actualSize = 0
        for await (const chunk of createReadStream(file.source)) {
          const data = chunk as Buffer
          actualSize += data.length
          if (actualSize > file.size || actualSize > MAX_BACKUP_BYTES) throw new Error(`备份文件在读取期间发生变化：${file.archivePath}`)
          digest.update(data)
          await writeChunk(input, data)
        }
        if (actualSize !== file.size) throw new Error(`备份文件在读取期间发生变化：${file.archivePath}`)
      }
      await writeRecordHeader(input, { type: 'end', fileCount, totalBytes, contentSha256: digest.digest('hex') })
      input.end()
      await completion
      await appendFile(staging, cipher.getAuthTag())
      await rename(staging, destination)
      this.logger?.info('环境加密完整数据备份已导出', { profileId, bytes: totalBytes, files: fileCount })
      return { path: destination, totalBytes, fileCount }
    } catch (error) {
      input.destroy()
      await completion.catch(() => undefined)
      await rm(staging, { force: true })
      throw error
    } finally {
      key.fill(0)
    }
  }

  async import(sourceInput: string, passwordInput: string): Promise<{ profile: BrowserProfile; result: ProfileBackupResult }> {
    const password = validatePassword(passwordInput)
    const source = resolve(sourceInput)
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < MAGIC.length + 4 + AUTH_TAG_BYTES) {
      throw new Error('加密备份文件无效')
    }

    const handle = await open(source, 'r')
    let headerBytes: Buffer | undefined
    let header: ProfileBackupHeader | undefined
    let payloadOffset = 0
    let authTag: Buffer | undefined
    try {
      const prefix = Buffer.alloc(MAGIC.length + 4)
      await readExactAt(handle, prefix, 0)
      if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是受支持的加密环境备份')
      const headerLength = prefix.readUInt32BE(MAGIC.length)
      if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) throw new Error('备份头长度无效')
      headerBytes = Buffer.alloc(headerLength)
      await readExactAt(handle, headerBytes, MAGIC.length + 4)
      try { header = validateHeader(JSON.parse(headerBytes.toString('utf8'))) } catch (error) {
        if (error instanceof SyntaxError) throw new Error('备份头不是有效 JSON')
        throw error
      }
      payloadOffset = MAGIC.length + 4 + headerLength
      if (sourceInfo.size <= payloadOffset + AUTH_TAG_BYTES) throw new Error('备份文件缺少加密内容')
      authTag = Buffer.alloc(AUTH_TAG_BYTES)
      await readExactAt(handle, authTag, sourceInfo.size - AUTH_TAG_BYTES)
    } finally {
      await handle.close()
    }

    const salt = Buffer.from(header!.kdf.salt, 'base64')
    const nonce = Buffer.from(header!.nonce, 'base64')
    const expectedCheck = Buffer.from(header!.keyCheck, 'base64')
    if (salt.length !== 16 || nonce.length !== 12 || expectedCheck.length !== 16) throw new Error('备份文件加密参数无效')
    const key = await deriveKey(password, salt)
    if (!timingSafeEqual(keyCheck(key), expectedCheck)) {
      key.fill(0)
      throw new Error('备份密码错误')
    }

    const stagingRoot = await mkdtemp(join(this.profiles.vaultPath, '.profile-backup-import-'))
    const staging = join(stagingRoot, 'user-data')
    await mkdir(staging, { recursive: true })
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(headerBytes!)
    decipher.setAuthTag(authTag!)
    const reader = new DecryptedReader(createReadStream(source, {
      start: payloadOffset,
      end: sourceInfo.size - AUTH_TAG_BYTES - 1
    }).pipe(decipher))
    const digest = createHash('sha256')
    let manifest: ProfileBackupManifest | undefined
    let fileCount = 0
    let totalBytes = 0
    const paths = new Set<string>()
    let profile: BrowserProfile | undefined
    try {
      const first = await readRecordHeader(reader)
      if (first.type !== 'manifest' || !Number.isSafeInteger(first.size) || first.size! < 1 || first.size! > MAX_MANIFEST_BYTES) {
        throw new Error('备份缺少有效清单')
      }
      try { manifest = validateManifest(JSON.parse((await reader.readExactly(first.size!)).toString('utf8'))) } catch (error) {
        if (error instanceof SyntaxError) throw new Error('备份清单不是有效 JSON')
        throw error
      }

      while (true) {
        const record = await readRecordHeader(reader)
        if (record.type === 'end') {
          if (record.fileCount !== fileCount || record.totalBytes !== totalBytes || record.contentSha256 !== digest.digest('hex')) {
            throw new Error('备份内容摘要或数量校验失败')
          }
          await reader.ensureEnd()
          break
        }
        const size = record.size
        if (record.type !== 'file' || typeof record.path !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size)
          || size < 0 || size > MAX_BACKUP_BYTES) throw new Error('备份文件记录无效')
        const archivePath = record.path
        if (paths.has(archivePath)) throw new Error('备份包含重复的文件路径')
        paths.add(archivePath)
        fileCount += 1
        totalBytes += size
        if (fileCount > MAX_BACKUP_FILES || totalBytes > MAX_BACKUP_BYTES) throw new Error('备份数据超过安全限制')
        const target = safeArchivePath(staging, archivePath)
        digest.update(archivePath).update('\0').update(String(size)).update('\0')
        await reader.copyExactly(size, target, digest)
      }

      const draft = manifest!.profile
      profile = await this.profiles.create(draft)
      const target = this.profiles.profileDataPath(profile.id)
      const empty = `${target}.empty-${randomUUID()}`
      await rename(target, empty)
      try {
        await rename(staging, target)
        await rm(empty, { recursive: true, force: true })
      } catch (error) {
        await rename(empty, target).catch(() => undefined)
        throw error
      }
      await this.profiles.assertProfileDataIdentity(profile.id)
      this.logger?.info('环境加密完整数据备份已导入', { profileId: profile.id, bytes: totalBytes, files: fileCount })
      return { profile: this.profiles.get(profile.id), result: { path: source, totalBytes, fileCount } }
    } catch (error) {
      if (profile) {
        await this.profiles.remove(profile.id).catch(() => undefined)
        const item = (await this.profiles.listTrash().catch(() => [])).find((candidate) => candidate.profileId === profile!.id)
        if (item) await this.profiles.purgeTrash(item.trashId).catch(() => undefined)
      }
      throw error
    } finally {
      key.fill(0)
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }
}

async function readRecordHeader(reader: DecryptedReader): Promise<BackupRecord> {
  const length = (await reader.readExactly(4)).readUInt32BE()
  if (length <= 0 || length > MAX_RECORD_HEADER_BYTES) throw new Error('备份记录头长度无效')
  let value: unknown
  try { value = JSON.parse((await reader.readExactly(length)).toString('utf8')) } catch { throw new Error('备份记录头不是有效 JSON') }
  if (!value || typeof value !== 'object' || typeof (value as BackupRecord).type !== 'string') throw new Error('备份记录头结构无效')
  return value as BackupRecord
}
