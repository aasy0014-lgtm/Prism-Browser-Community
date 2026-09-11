import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProfileDraft } from '../shared/types'
import type { KernelManager } from './kernel-manager'
import { listBundledBrowsers, locateBrowser, locateBundledBrowser, normalizeBrowserSelection } from './browser-locator'
import { mergeKernelCatalog } from './kernel-catalog'
import type { BrowserLauncher } from './browser-launcher'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import { testProxy } from './proxy-tester'
import { validateProxyConfig } from '../shared/validation'
import type { AppLogger } from './app-logger'
import { parseProfileConfig, safeProfileFileName, serializeProfileConfig } from './profile-transfer'
import { clearProfileCache, profileStorageInfo, storageOverview } from './profile-data'
import type { ExtensionStore } from './extension-store'
import type { CookieManager } from './cookie-manager'
import { parseCookieFile, serializeCookieFile } from './cookie-file'
import { parseBatchProfileCsv, serializeBatchProfileTemplate } from './profile-batch-csv'
import { proxyForTest, publicProfile, sameProxyIdentity } from './profile-secrets'
import type { ProfileBackupManager } from './profile-backup'
import type { AppSessionTracker } from './app-session'
import type { UpdateManager } from './update-manager'
import type { LicenseManager } from './license-manager'
import type { WorkspaceMigrationManager } from './workspace-migration'
import type { ProAgentManager } from './pro-agent-manager'
import type { SchedulerManager } from './scheduler-manager'
import type { McpControlManager } from './mcp-control-manager'
import type { AnnouncementManager } from './announcement-manager'
import { assertTrustedIpcSender } from './renderer-security'
import { readStableText, writeAtomicText } from './atomic-file'

export const PRO_PURCHASE_URL = 'https://pay.ldxp.cn/item/q23itv'

interface IpcDependencies {
  profiles: ProfileStore
  settings: SettingsStore
  launcher: BrowserLauncher
  kernels: KernelManager
  extensions: ExtensionStore
  cookies: CookieManager
  logger: AppLogger
  backups: ProfileBackupManager
  workspaceMigration: WorkspaceMigrationManager
  appSession: AppSessionTracker
  updater: UpdateManager
  licensing: LicenseManager
  automation: ProAgentManager
  scheduler: SchedulerManager
  mcp: McpControlManager
  announcements: AnnouncementManager
}

export function registerIpc({ profiles, settings, launcher, kernels, extensions, cookies, logger, backups, workspaceMigration, appSession, updater, licensing, automation, scheduler, mcp, announcements }: IpcDependencies): void {
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpcSender(event)
      return listener(event, ...args)
    })
  }

  handle('profiles:list', () => profiles.list().map(publicProfile))
  handle('profiles:storage-health', () => profiles.storageHealth())
  handle('profiles:create', async (_event, draft: ProfileDraft) => publicProfile(await profiles.create(draft)))
  handle('profiles:update', async (_event, id: string, draft: ProfileDraft) => {
    if (launcher.isRunning(id)) throw new Error('请先关闭运行中的浏览器环境再修改配置')
    return publicProfile(await profiles.update(id, draft))
  })
  handle('profiles:duplicate', async (_event, id: string) => publicProfile(await profiles.duplicate(id)))
  handle('profiles:export-config', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭环境再导出配置')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: '导出环境配置',
      defaultPath: safeProfileFileName(profile.name),
      filters: [{ name: 'Prism Browser 环境配置', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeAtomicText(result.filePath, serializeProfileConfig(profile))
    logger.info('环境配置已导出', { profileId: id })
    return result.filePath
  })
  handle('profiles:import-config', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入环境配置',
      properties: ['openFile'],
      filters: [{ name: 'Prism Browser 环境配置', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const profile = await profiles.create(parseProfileConfig(await readStableText(path, 1024 * 1024)))
    logger.info('环境配置已导入', { profileId: profile.id })
    return publicProfile(profile)
  })
  handle('profiles:import-batch-csv', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '批量导入浏览器环境',
      properties: ['openFile'],
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const drafts = parseBatchProfileCsv(await readStableText(path, 2 * 1024 * 1024), profiles.list().length + 1)
    const created = await profiles.createMany(drafts)
    logger.info('已通过 CSV 批量导入浏览器环境', { count: created.length })
    return created.map(publicProfile)
  })
  handle('profiles:export-batch-template', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: '保存批量导入 CSV 模板',
      defaultPath: 'prism-browser-batch-template.csv',
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeAtomicText(result.filePath, serializeBatchProfileTemplate())
    return result.filePath
  })
  handle('profiles:storage-info', async (_event, id: string) => {
    profiles.get(id)
    await profiles.assertProfileDataIdentity(id)
    return profileStorageInfo(profiles.profileDataPath(id))
  })
  handle('profiles:storage-overview', () => storageOverview(profiles.vaultPath))
  handle('profiles:open-data-folder', async (_event, id: string) => {
    profiles.get(id)
    await profiles.assertProfileDataIdentity(id)
    const error = await shell.openPath(profiles.profileDataPath(id))
    if (error) throw new Error(`无法打开环境数据目录：${error}`)
  })
  handle('profiles:clear-cache', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id) || (profile.status !== 'closed' && profile.status !== 'error')) {
      throw new Error('请先关闭浏览器环境再清理缓存')
    }
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    await profiles.assertProfileDataIdentity(id)
    const result = await clearProfileCache(profiles.profileDataPath(id))
    logger.info('浏览器环境缓存已清理', { profileId: id })
    return result
  })
  handle('profiles:export-backup', async (_event, id: string, password: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id) || (profile.status !== 'closed' && profile.status !== 'error')) throw new Error('请先关闭环境再备份完整数据')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    const processCheck = (await launcher.diagnose(id)).checks.find((check) => check.key === 'process')
    if (processCheck?.status === 'error') throw new Error(`无法安全备份：${processCheck.message}`)
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      title: '保存加密环境数据备份',
      defaultPath: `Prism 环境数据备份 - ${new Date().toISOString().slice(0, 10)}.prism-backup`,
      filters: [{ name: 'Prism 加密备份', extensions: ['prism-backup'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    return backups.export(id, result.filePath, password)
  })
  handle('profiles:import-backup', async (_event, password: string) => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择加密环境数据备份',
      properties: ['openFile'],
      filters: [{ name: 'Prism 加密备份', extensions: ['prism-backup'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const imported = await backups.import(result.filePaths[0], password)
    return { profile: publicProfile(imported.profile), result: imported.result }
  })
  handle('profiles:export-workspace', async (_event, password: string) => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导出迁移包')
    if (profiles.list().some((profile) => cookies.isBusy(profile.id))) throw new Error('Cookie 操作尚未结束，请稍后再试')
    const owner = BrowserWindow.getFocusedWindow()
    const stamp = new Date().toISOString().slice(0, 10)
    const options: Electron.SaveDialogOptions = {
      title: '导出全部环境加密迁移包',
      defaultPath: `Prism 全部环境 ${stamp}.prism-migration`,
      filters: [{ name: 'Prism 加密迁移包', extensions: ['prism-migration'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    return workspaceMigration.exportAll(result.filePath, password)
  })
  handle('profiles:import-workspace', async (_event, password: string, conflictPolicy: 'rename' | 'skip') => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导入迁移包')
    if (profiles.list().some((profile) => cookies.isBusy(profile.id))) throw new Error('Cookie 操作尚未结束，请稍后再试')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入全部环境加密迁移包',
      properties: ['openFile'],
      filters: [{ name: 'Prism 加密迁移包', extensions: ['prism-migration'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return workspaceMigration.importAll(result.filePaths[0], password, conflictPolicy)
  })
  handle('profiles:trash', () => profiles.listTrash())
  handle('profiles:restore', async (_event, trashId: string) => {
    const profile = await profiles.restore(trashId)
    logger.info('浏览器环境已从回收站恢复', { profileId: profile.id })
    return publicProfile(profile)
  })
  handle('profiles:purge-trash', async (_event, trashId: string) => {
    await profiles.purgeTrash(trashId)
    logger.info('回收站环境已永久删除', { trashId })
  })
  handle('profiles:empty-trash', async () => {
    const count = await profiles.emptyTrash()
    logger.info('环境回收站已清空', { count })
    return count
  })
  handle('profiles:recycle-retention', () => settings.get().recycleRetentionDays)
  handle('profiles:set-recycle-retention', async (_event, days: number) => {
    if (days !== 0 && days !== 7 && days !== 30 && days !== 90) throw new Error('回收站保留天数无效')
    await settings.update({ recycleRetentionDays: days })
    logger.info('环境回收站自动清理策略已更新', { days })
    return days
  })
  handle('profiles:export-cookies', async (_event, id: string) => {
    const profile = profiles.get(id)
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导出 Cookie')
    const owner = BrowserWindow.getFocusedWindow()
    const defaultPath = safeProfileFileName(profile.name).replace(/\.prism-profile\.json$/, '.cookies.json')
    const options: Electron.SaveDialogOptions = {
      title: '导出环境 Cookie',
      defaultPath,
      filters: [{ name: 'Cookie JSON', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const exported = await cookies.exportCookies(id)
    await writeAtomicText(result.filePath, serializeCookieFile(profile.name, exported))
    return { count: exported.length, filePath: result.filePath }
  })
  handle('profiles:import-cookies', async (_event, id: string) => {
    profiles.get(id)
    if (launcher.isRunning(id)) throw new Error('请先关闭浏览器环境再导入 Cookie')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入环境 Cookie',
      properties: ['openFile'],
      filters: [{ name: 'Cookie JSON', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const imported = parseCookieFile(await readStableText(path, 10 * 1024 * 1024))
    const count = await cookies.importCookies(id, imported)
    return { count, filePath: path }
  })
  handle('profiles:remove', async (_event, id: string) => {
    if (launcher.isRunning(id)) throw new Error('请先关闭运行中的环境')
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    if (scheduler.profileTasks(id).length) throw new Error('该环境仍被计划任务引用，请先删除对应计划任务')
    await profiles.remove(id)
    await mcp.removeProfile(id)
  })
  handle('profiles:launch', (_event, id: string, options?: { allowGeoConflict?: unknown }) => {
    if (cookies.isBusy(id)) throw new Error('该环境正在执行 Cookie 操作')
    return launcher.launch(id, { allowGeoConflict: options?.allowGeoConflict === true }).then(publicProfile)
  })
  handle('profiles:close', (_event, id: string) => launcher.close(id).then(publicProfile))
  handle('profiles:close-all', () => launcher.closeAll())
  handle('profiles:test-proxy', async (_event, id: string) => {
    const testedProfile = profiles.get(id)
    const result = await testProxy(testedProfile.proxy)
    const current = profiles.get(id)
    if (!sameProxyIdentity(testedProfile.proxy, current.proxy) || testedProfile.proxy.password !== current.proxy.password) {
      throw new Error('检测期间代理配置已变更，本次结果未保存')
    }
    const profile = await profiles.setProxyCheck(id, { ...result, checkedAt: new Date().toISOString() })
    return publicProfile(profile)
  })
  handle('profiles:diagnose', (_event, id: string) => launcher.diagnose(id))
  handle('profiles:crash-history', (_event, id: string) => launcher.crashHistory(id))
  handle('profiles:set-favorite', async (_event, id: string, favorite: boolean) => publicProfile(await profiles.setFavorite(id, favorite)))
  handle('profiles:classify-many', async (_event, ids: string[], patch) => {
    return (await profiles.classifyMany(ids, patch)).map(publicProfile)
  })
  handle('profiles:remove-many', async (_event, ids: string[]) => {
    for (const id of ids) {
      if (launcher.isRunning(id)) throw new Error(`环境“${profiles.get(id).name}”正在运行，不能删除`)
      if (cookies.isBusy(id)) throw new Error(`环境“${profiles.get(id).name}”正在执行 Cookie 操作`)
      if (scheduler.profileTasks(id).length) throw new Error(`环境“${profiles.get(id).name}”仍被计划任务引用，请先删除对应计划任务`)
    }
    await profiles.removeMany(ids)
    await Promise.all(ids.map((id) => mcp.removeProfile(id)))
  })

  handle('engine:status', () => locateBrowser(settings))
  handle('engine:bundled', () => locateBundledBrowser())
  handle('engine:activate-bundled', async () => {
    const bundled = await locateBundledBrowser()
    if (!bundled?.executable) throw new Error('当前安装包没有可用的内置指纹内核')
    return kernels.configure(
      { browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' },
      bundled.executable
    )
  })
  handle('engine:select', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择 Fingerprint Chromium 内核',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '浏览器', extensions: ['exe'] }] : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return locateBrowser(settings)
    const executable = await normalizeBrowserSelection(result.filePaths[0])
    return kernels.configure({ browserExecutable: executable, fingerprintKernel: true, enginePreference: 'auto' })
  })
  handle('engine:import-local', async () => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再导入并切换内核')
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '导入本地 Fingerprint Chromium 构建',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Chromium', extensions: ['exe'] }] : undefined
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return locateBrowser(settings)
    return kernels.importLocal(result.filePaths[0])
  })
  handle('engine:use-system', async () => {
    return kernels.configure({ browserExecutable: '', fingerprintKernel: false, enginePreference: 'system' })
  })
  handle('engine:installed', async () => {
    const [managed, bundled] = await Promise.all([kernels.installed(), listBundledBrowsers()])
    return mergeKernelCatalog(managed, bundled)
  })
  handle('engine:activate', async (_event, version: string) => {
    const bundled = await locateBundledBrowser(process.resourcesPath, version)
    if (!bundled?.executable) return kernels.activate(version)
    const primary = await locateBundledBrowser()
    return kernels.configure(
      primary?.version === version
        ? { browserExecutable: '', fingerprintKernel: true, enginePreference: 'bundled' }
        : { browserExecutable: bundled.executable, fingerprintKernel: true, enginePreference: 'auto' },
      bundled.executable
    )
  })
  handle('engine:rollback-available', () => kernels.rollbackAvailable())
  handle('engine:rollback', () => {
    if (launcher.hasRunning()) throw new Error('请先关闭全部浏览器环境再回滚内核')
    return kernels.rollback()
  })
  handle('engine:remove', (_event, version: string) => kernels.remove(version))
  handle('engine:verify', async (_event, version: string) => {
    const bundled = await locateBundledBrowser(process.resourcesPath, version)
    if (bundled?.executable) {
      return {
        version,
        status: 'healthy',
        message: '随 Prism Browser 发布的内核完整性正常',
        checkedAt: new Date().toISOString()
      }
    }
    return kernels.verify(version)
  })
  handle('updates:status', () => updater.status())
  handle('updates:check', () => updater.check())
  handle('updates:download', () => updater.download())
  handle('updates:open-installer', async () => {
    const error = await shell.openPath(await updater.downloadedPath())
    if (error) throw new Error(`无法打开更新安装程序：${error}`)
  })
  handle('announcements:status', () => announcements.status())
  handle('announcements:check', () => announcements.check())
  handle('announcements:open-action', async () => {
    const status = announcements.status()
    if (status.state !== 'available' || !status.announcement?.action) throw new Error('当前公告没有可打开的链接')
    await shell.openExternal(status.announcement.action.url)
  })
  handle('proxy:test', (_event, config, profileId?: string) => {
    const validated = validateProxyConfig(config)
    const profile = profileId ? profiles.get(profileId) : undefined
    return testProxy(proxyForTest(validated, profile))
  })
  handle('diagnostics:session-health', () => appSession.recoveryStatus())
  if (process.env.PRISM_E2E === '1') {
    handle('diagnostics:e2e-quit', () => app.quit())
  }
  handle('licensing:status', () => licensing.status())
  handle('licensing:sync', () => licensing.synchronize())
  handle('licensing:activate', (_event, activationCode: string) => licensing.activate(activationCode))
  handle('licensing:deactivate', () => licensing.deactivate())
  handle('licensing:open-purchase', async () => {
    await shell.openExternal(PRO_PURCHASE_URL)
  })
  handle('automation:status', () => automation.status())
  handle('automation:start', () => automation.start())
  handle('automation:stop', () => automation.stop(false))
  handle('automation:emergency-stop', () => automation.stop(true))
  handle('scheduler:list', () => scheduler.list())
  handle('scheduler:create', (_event, draft) => scheduler.create(draft))
  handle('scheduler:update', (_event, id: string, draft) => scheduler.update(id, draft))
  handle('scheduler:remove', (_event, id: string) => scheduler.remove(id))
  handle('scheduler:set-enabled', (_event, id: string, enabled: boolean) => scheduler.setEnabled(id, enabled))
  handle('scheduler:run-now', (_event, id: string) => scheduler.runNow(id))
  handle('mcp:status', () => mcp.status(automation.status().state === 'running'))
  handle('mcp:permissions', () => mcp.permissionList())
  handle('mcp:set-permission', (_event, profileId: string, enabled: boolean) => mcp.setPermission(profileId, enabled))
  handle('mcp:start', () => automation.mcpConnection())
  handle('mcp:stop', async () => {
    await automation.stop(false)
    mcp.resetSessions()
    return mcp.status(false)
  })
  handle('mcp:emergency-stop', async () => {
    await mcp.emergencyStop()
    await automation.stop(false)
    return mcp.status(false)
  })
  handle('extensions:list', () => extensions.list())
  handle('extensions:import-directory', async () => {
    const owner = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = { title: '选择未打包的浏览器扩展目录', properties: ['openDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return extensions.importDirectory(result.filePaths[0])
  })
  handle('extensions:open-source-folder', async (_event, id: string) => {
    const path = extensions.sourcePath(id)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('扩展源码目录不存在或不安全')
    const manifestPath = join(path, 'manifest.json')
    const manifestInfo = await lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('扩展源码缺少有效的 manifest.json')
    shell.showItemInFolder(manifestPath)
    logger.info('已打开扩展源码目录', { extensionId: id })
    return path
  })
  handle('extensions:set-global-enabled', (_event, id: string, enabled: boolean) => {
    return extensions.setGlobalEnabled(id, enabled)
  })
  handle('extensions:remove', async (_event, id: string) => {
    if (await profiles.usesExtension(id)) throw new Error('该扩展仍被浏览器环境使用，请先从环境配置中移除')
    await extensions.remove(id)
  })
}
