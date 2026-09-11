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

  it('rejects loopback, private, reserved and cloud metadata URLs for MCP operations', async () => {
    const cdp: CdpTransport = { send: vi.fn(), close: vi.fn() }
    const session = new BrowserControlSession(cdp)

    await expect(session.open('http://127.0.0.1:8080/')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
    await expect(session.open('http://localhost:3000/')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
    await expect(session.open('http://2130706433/')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
    await expect(session.open('http://10.0.0.1/')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
    await expect(session.open('http://192.168.1.1/')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
    await expect(session.open('http://[fd00::1]/')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
    await expect(session.open('http://[::ffff:127.0.0.1]/')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
    await expect(session.open('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
  })

  it('rejects a page that redirects to a local or non-web URL before exposing state', async () => {
    const send = vi.fn(async <T>(method: string): Promise<T> => {
      if (method === 'Target.createTarget') return { targetId: 'target-1' } as T
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'target-1' } } as T
      if (method === 'Page.navigate') return {} as T
      if (method === 'Runtime.evaluate') {
        return { result: { value: { url: 'http://192.168.0.1/admin', title: 'internal', readyState: 'complete' } } } as T
      }
      return {} as T
    })
    const session = new BrowserControlSession({ send: send as CdpTransport['send'], close: vi.fn() })

    await expect(session.open('https://example.com/redirect')).rejects.toThrow('MCP 不允许访问本地或元数据服务地址')
  })
})
