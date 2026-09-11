import { safeStorage } from 'electron'

export interface SecretCodec {
  encode(value: string): string
  decode(value: string): string
}

export const identitySecretCodec: SecretCodec = {
  encode: (value) => value,
  decode: (value) => value
}

export class ElectronSecretCodec implements SecretCodec {
  encode(value: string): string {
    if (!value) return ''
    if (safeStorage.isEncryptionAvailable()) {
      return `encrypted:v1:${safeStorage.encryptString(value).toString('base64')}`
    }
    throw new Error('系统安全存储当前不可用，代理密码未保存')
  }

  decode(value: string): string {
    if (!value) return ''
    if (value.startsWith('encrypted:v1:')) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据存储当前不可用，无法读取代理密码')
      return safeStorage.decryptString(Buffer.from(value.slice('encrypted:v1:'.length), 'base64'))
    }
    if (value.startsWith('fallback:v1:')) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，旧版代理密码需要重新输入')
      return Buffer.from(value.slice('fallback:v1:'.length), 'base64').toString('utf8')
    }
    return value
  }
}
