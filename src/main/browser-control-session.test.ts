import { describe, expect, it, vi } from 'vitest'
import { BrowserControlSession, type CdpTransport } from './browser-control-session'

describe('BrowserControlSession', () => {
  it('reuses its dedicated target for subsequent navigations', async () => {
    let currentUrl = 'about:blank'
    const send = vi.fn(async <T>(method: string, params: Record<string, unknown> = {}, _sessionId?: string): Promise<T> => {
      if (method === 'Target.createTarget') return { targetId: 'target-1' } as T
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: params.targetId } } as T
      if (method === 'Page.navigate') {
        currentUrl = String(params.url)
        return {} as T
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { url: currentUrl, title: 'Test', readyState: 'complete' } } } as T
      }
      return {} as T
    })
    const cdp: CdpTransport = { send: send as CdpTransport['send'], close: vi.fn() }
    const session = new BrowserControlSession(cdp)

    await session.open('https://example.com/first')
    await session.open('https://example.com/second')

    expect(send.mock.calls.filter(([method]) => method === 'Target.createTarget')).toHaveLength(1)
    expect(send.mock.calls.filter(([method]) => method === 'Target.attachToTarget')).toHaveLength(1)
    expect(send.mock.calls.filter(([method]) => method === 'Page.navigate')).toHaveLength(2)
    expect(send.mock.calls.filter(([method]) => method === 'Page.navigate').at(-1)?.[1]).toEqual({
      url: 'https://example.com/second'
    })
  })

  it('does not attach to an unrelated page after its target disappears', async () => {
    let currentUrl = 'about:blank'
    let targetAlive = true
    let createdTargets = 0
    const send = vi.fn(async <T>(method: string, params: Record<string, unknown> = {}, _sessionId?: string): Promise<T> => {
      if (method === 'Target.createTarget') return { targetId: `target-${++createdTargets}` } as T
      if (method === 'Target.attachToTarget') return { sessionId: `session-${params.targetId}` } as T
      if (method === 'Target.getTargetInfo') {
        if (!targetAlive && params.targetId === 'target-1') throw new Error('target closed')
        return { targetInfo: { targetId: params.targetId } } as T
      }
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: 'unrelated', type: 'page', title: 'Other', url: 'https://other.example/' }] } as T
      }
      if (method === 'Page.navigate') {
        currentUrl = String(params.url)
        return {} as T
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { url: currentUrl, title: 'Test', readyState: 'complete' } } } as T
      }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] } as T
      return {} as T
    })
    const cdp: CdpTransport = { send: send as CdpTransport['send'], close: vi.fn() }
    const session = new BrowserControlSession(cdp)

    await session.open('https://example.com/first')
    targetAlive = false
    await session.snapshot()

    expect(send.mock.calls.filter(([method]) => method === 'Target.createTarget')).toHaveLength(2)
    expect(send.mock.calls.filter(([method]) => method === 'Target.getTargets')).toHaveLength(0)
    expect(send.mock.calls.filter(([method]) => method === 'Target.attachToTarget').map(([, params]) => params)).toEqual([
      { targetId: 'target-1', flatten: true },
      { targetId: 'target-2', flatten: true }
    ])
  })
})
