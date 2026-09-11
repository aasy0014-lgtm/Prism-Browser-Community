import { pathToFileURL } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents: vi.fn() }
}))

vi.mock('electron', () => electron)

import { assertTrustedIpcSender, isTrustedRendererUrl } from './renderer-security'

const originalRendererUrl = process.env.ELECTRON_RENDERER_URL

describe('renderer security', () => {
  beforeEach(() => {
    electron.app.isPackaged = false
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    electron.BrowserWindow.fromWebContents.mockReset()
  })

  afterAll(() => {
    if (originalRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = originalRendererUrl
  })

  it('accepts only the configured development renderer origin', () => {
    const options = { developmentUrl: 'http://localhost:5173/' }
    expect(isTrustedRendererUrl('http://localhost:5173/index.html', options)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/other.html', options)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/index.html', options)).toBe(false)
    expect(isTrustedRendererUrl('https://localhost:5173/index.html', options)).toBe(false)
    expect(isTrustedRendererUrl('file:///tmp/index.html', options)).toBe(false)
  })

  it('accepts only the exact packaged renderer file', () => {
    electron.app.isPackaged = true
    const productionPath = '/opt/prism/out/renderer/index.html'
    expect(isTrustedRendererUrl(pathToFileURL(productionPath).href, { productionPath })).toBe(true)
    expect(isTrustedRendererUrl(`${pathToFileURL(productionPath).href}?tampered=1`, { productionPath })).toBe(false)
    expect(isTrustedRendererUrl(pathToFileURL('/opt/prism/out/renderer/other.html').href, { productionPath })).toBe(false)
  })

  it('rejects IPC from missing, child-frame, or untrusted renderers', () => {
    const mainFrame = { url: 'http://localhost:5173/index.html' }
    const sender = { mainFrame }
    electron.BrowserWindow.fromWebContents.mockReturnValue({ isDestroyed: () => false })
    expect(() => assertTrustedIpcSender({ sender, senderFrame: mainFrame } as never)).not.toThrow()

    expect(() => assertTrustedIpcSender({ sender, senderFrame: { url: mainFrame.url }, } as never)).toThrow('IPC')
    expect(() => assertTrustedIpcSender({ sender, senderFrame: { url: 'http://evil.example/' }, } as never)).toThrow('IPC')
    electron.BrowserWindow.fromWebContents.mockReturnValue(null)
    expect(() => assertTrustedIpcSender({ sender, senderFrame: mainFrame } as never)).toThrow('IPC')
  })
})
