import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { parseProfileConfig, safeProfileFileName, serializeProfileConfig } from './profile-transfer'
import { validateProfileDraft } from '../shared/validation'

describe('profile-transfer', () => {
  it('serializes and parses a standard profile config', () => {
    const draft = defaultProfileDraft()
    const profile = {
      ...draft,
      id: 'profile-1',
      serialNumber: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      favorite: false,
      status: 'closed' as const
    }
    const serialized = serializeProfileConfig(profile)
    const parsed = parseProfileConfig(serialized)
    expect(parsed.name).toBe(`${draft.name}（导入）`)
    expect(() => validateProfileDraft(parsed)).not.toThrow()
  })

  it('safely handles profiles whose name is at the maximum 60 character limit', () => {
    const longName = 'B'.repeat(60)
    const draft = { ...defaultProfileDraft(), name: longName }
    const profile = {
      ...draft,
      id: 'profile-long',
      serialNumber: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      favorite: false,
      status: 'closed' as const
    }
    const serialized = serializeProfileConfig(profile)
    const parsed = parseProfileConfig(serialized)
    expect(parsed.name.length).toBeLessThanOrEqual(60)
    expect(parsed.name).toBe(`${'B'.repeat(56)}（导入）`)
    expect(() => validateProfileDraft(parsed)).not.toThrow()
  })

  it('generates a safe profile file name', () => {
    expect(safeProfileFileName('My/Profile:Name*?')).toBe('My-Profile-Name--.prism-profile.json')
  })
})
