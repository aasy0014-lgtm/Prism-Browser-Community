import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ProAgentManager } from './pro-agent-manager'

class FakeAgentProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly pid = 12_345
  readonly signals: NodeJS.Signals[] = []
  private exited = false

  constructor() {
    super()
    this.stdin.on('data', (chunk) => {
      if (chunk.toString('utf8').includes('"type":"stop"')) queueMicrotask(() => this.exit(0))
    })
  }

  send(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`) }

  exit(code = 1): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, null)
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): boolean {
    this.signals.push(signal)
    queueMicrotask(() => this.exit(0))
    return true
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function profile(id: string, status: 'closed' | 'running' = 'closed') {
  return { id, serialNumber: 1, name: 'Test profile', group: '', tags: [], status, lastOpenedAt: undefined }
}

describe('ProAgentManager', () => {
  it('emergency-cleans MCP and Agent-controlled profiles after an unexpected exit', async () => {
    const child = new FakeAgentProcess()
    const running = new Set<string>()
    const launcher = {
      isRunning: vi.fn((id: string) => running.has(id)),
      launch: vi.fn(async (id: string) => { running.add(id); return profile(id, 'running') }),
      close: vi.fn(async (id: string) => { running.delete(id); return profile(id) })
    }
    const mcpBroker = {
      handleAgentRequest: vi.fn(async () => undefined),
      status: vi.fn(() => ({ state: 'stopped' as const, message: '', enabledProfileIds: [], controlledProfileIds: [] })),
      emergencyStop: vi.fn(async () => ({ state: 'stopped' as const, message: '', enabledProfileIds: [], controlledProfileIds: [] })),
      resetSessions: vi.fn()
    }
    const audit = { record: vi.fn() }
    const manager = new ProAgentManager(
      { list: () => [], get: vi.fn() } as never,
      launcher as never,
      {
        has: vi.fn(() => true),
        proAgentReleasePublicKey: vi.fn(async () => 'test-key'),
        createProAgentHandshake: vi.fn(async () => ({}) as never)
      },
      audit as never,
      '/tmp',
      () => undefined,
      undefined,
      undefined,
      vi.fn(async () => ({
        executablePath: '/tmp/agent',
        manifest: { payload: { version: '1.0.0' } }
      })) as never,
      vi.fn(() => child as unknown as ChildProcessWithoutNullStreams) as never
    )
    manager.attachMcpBroker(mcpBroker)

    const started = manager.start()
    await waitUntil(() => child.listenerCount('data') > 0 || child.stdout.listenerCount('data') > 0)
    child.send({ type: 'challenge', challenge: { agentVersion: '1.0.0' } })
    child.send({
      type: 'ready',
      agentVersion: '1.0.0',
      endpoint: 'http://127.0.0.1:34567/',
      accessToken: 'a'.repeat(43),
      mcpAccessToken: 'b'.repeat(43)
    })
    await started

    child.send({ type: 'request', id: 'launch-1', method: 'profiles.launch', params: { profileId: 'profile-1' } })
    await waitUntil(() => launcher.launch.mock.calls.length === 1)
    child.exit(1)

    await waitUntil(() => mcpBroker.emergencyStop.mock.calls.length === 1
      && launcher.close.mock.calls.length === 1 && mcpBroker.resetSessions.mock.calls.length === 1)
    expect(launcher.close).toHaveBeenCalledWith('profile-1')
    expect(mcpBroker.resetSessions).toHaveBeenCalled()
    expect(manager.status()).toMatchObject({ state: 'error', controlledProfileIds: [] })
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'emergency-stop', outcome: 'success' }))
  })

  it('does not claim a profile that was already running before an Agent launch request', async () => {
    const child = new FakeAgentProcess()
    const launcher = {
      isRunning: vi.fn(() => true),
      launch: vi.fn(async (id: string) => profile(id, 'running')),
      close: vi.fn(async (id: string) => profile(id))
    }
    const manager = new ProAgentManager(
      { list: () => [], get: vi.fn() } as never,
      launcher as never,
      { has: vi.fn(() => true), proAgentReleasePublicKey: vi.fn(async () => 'key'), createProAgentHandshake: vi.fn(async () => ({}) as never) },
      { record: vi.fn() } as never,
      '/tmp',
      () => undefined,
      undefined,
      undefined,
      vi.fn(async () => ({ executablePath: '/tmp/agent', manifest: { payload: { version: '1.0.0' } } })) as never,
      vi.fn(() => child as unknown as ChildProcessWithoutNullStreams) as never
    )

    const started = manager.start()
    await waitUntil(() => child.stdout.listenerCount('data') > 0)
    child.send({ type: 'challenge', challenge: { agentVersion: '1.0.0' } })
    child.send({ type: 'ready', agentVersion: '1.0.0', endpoint: 'http://127.0.0.1:34567/', accessToken: 'a'.repeat(43), mcpAccessToken: 'b'.repeat(43) })
    await started
    child.send({ type: 'request', id: 'launch-2', method: 'profiles.launch', params: { profileId: 'profile-1' } })
    await waitUntil(() => launcher.launch.mock.calls.length === 1)

    expect(manager.status().controlledProfileIds).toEqual([])
    await manager.stop(false)
  })
})
