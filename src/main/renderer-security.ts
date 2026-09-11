import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface RendererUrlOptions {
  developmentUrl?: string
  productionPath?: string
}

function sameOrigin(first: URL, second: URL): boolean {
  return first.protocol === second.protocol && first.origin === second.origin
}

export function isTrustedRendererUrl(value: string, options: RendererUrlOptions = {}): boolean {
  const developmentUrl = !app.isPackaged ? options.developmentUrl ?? process.env.ELECTRON_RENDERER_URL : undefined
  try {
    const actual = new URL(value)
    if (developmentUrl) {
      const expected = new URL(developmentUrl)
      return ['http:', 'https:'].includes(expected.protocol) && sameOrigin(actual, expected)
    }
    const productionPath = options.productionPath ?? join(__dirname, '../renderer/index.html')
    return actual.href === pathToFileURL(productionPath).href
  } catch {
    return false
  }
}

export function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()
    || event.senderFrame !== event.sender.mainFrame
    || !isTrustedRendererUrl(event.senderFrame.url)) {
    throw new Error('IPC 调用来源未授权')
  }
}
