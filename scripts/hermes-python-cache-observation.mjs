import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const defaults = Object.freeze({ maxFiles: 20000, maxDirectories: 4000, maxEntries: 30000, maxDurationMs: 2000, maxCacheTags: 32 })
const ceilings = Object.freeze({ maxFiles: 100000, maxDirectories: 10000, maxEntries: 120000, maxDurationMs: 5000, maxCacheTags: 32 })

class StopObservation extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason }
}

function within(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function absoluteLocal(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return false
  // 只接受本地物理路径，不把 UNC/设备命名空间或未规范化的 .. 交给元数据扫描。
  if (value.startsWith('\\\\') || value.startsWith('//') || value.split(/[\\/]+/).some(p => p === '..' || p === '.')) return false
  return value.split(/[\\/]+/).length <= 128
}

/**
 * 调用方须先核实受管 HOME 和 privatecompletion 中的真实模块文件；本函数不做 VM/proof 认证。
 * 仅同步读取目录项/lstat/realpath，不打开 Python、pyc、配置或凭据内容，不执行任何程序。
 * 要求调用时安装目录静止：元数据观察不是原子快照或 OS 权限沙箱；发现变化即 incomplete。
 * 时间预算在每个元数据操作前后检查，不能中断正在内核中阻塞的单次 I/O；因此拒绝 UNC。
 * complete 只指预算内扫描到 EOF，永远不是资格 PASS；tag 仅为有限文件名模式的观察值。
 */
export function observeHermesPythonCache(input) {
  const started = performance.now()
  const counts = { files: 0, directories: 0, entries: 0, py: 0, pyc: 0 }
  const tags = new Set()
  let limits = { ...defaults }, rootsObserved = 0, phase = 'validation'
  const stop = (status, reason) => { throw new StopObservation(status, reason) }
  const time = () => {
    if (performance.now() - started >= limits.maxDurationMs) stop('incomplete', 'time-budget')
  }
  const metadata = action => {
    time()
    try { const result = action(); time(); return result }
    catch (error) {
      if (error instanceof StopObservation) throw error
      stop(phase === 'validation' ? 'rejected' : 'incomplete', 'metadata-unavailable')
    }
  }
  const report = (status, reason = null) => ({
    status, reason, counts, rootsObserved, cacheTags: [...tags].sort(),
    cacheTagsSource: 'filenames-only-not-interpreter-cache-tag',
    interpreterCacheTagVerified: false, pythonExecuted: false, qualificationPassed: false,
    elapsedMs: Math.round((performance.now() - started) * 1000) / 1000, limits,
  })
  try {
    if (!input || !absoluteLocal(input.home) || !Array.isArray(input.modulePaths)
      || input.modulePaths.length === 0 || input.modulePaths.length > 16 || !input.modulePaths.every(absoluteLocal)) stop('rejected', 'invalid-input')
    const home = path.resolve(input.home)
    if (home === path.parse(home).root) stop('rejected', 'invalid-input')
    if (input.limits !== undefined) {
      if (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits)) stop('rejected', 'invalid-limits')
      for (const [key, value] of Object.entries(input.limits)) {
        if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) || value < 0 || value > ceilings[key]) stop('rejected', 'invalid-limits')
        limits[key] = value
      }
    }
    // 先查链接本身，链接存在时不 realpath/打开它的外部目标；HOME 的祖先别名由最终物理路径比较拒绝。
    const plain = file => {
      const stat = metadata(() => fs.lstatSync(file))
      if (stat.isSymbolicLink()) stop('rejected', 'linked-path')
      const real = metadata(() => fs.realpathSync.native(file))
      if (path.relative(real, file) !== '' || !within(home, real)) stop('rejected', 'linked-path')
      return stat
    }
    if (!plain(home).isDirectory()) stop('rejected', 'home-not-directory')
    const physical = file => {
      if (!within(home, file)) stop('rejected', 'module-outside-home')
      let current = home, stat = plain(home)
      for (const part of path.relative(home, file).split(path.sep).filter(Boolean)) {
        if (!stat.isDirectory()) stop('rejected', 'metadata-unavailable')
        current = path.join(current, part)
        stat = plain(current)
      }
      return stat
    }
    const candidates = new Set()
    for (const selected of input.modulePaths) {
      const modulePath = path.resolve(selected)
      if (!within(home, modulePath)) stop('rejected', 'module-outside-home')
      if (!physical(modulePath).isFile()) stop('rejected', 'module-not-file')
      let directory = path.dirname(modulePath), found = false
      while (within(home, directory)) {
        const name = path.basename(directory)
        if ((process.platform === 'win32' ? name.toLowerCase() : name) === 'site-packages') {
          candidates.add(directory); found = true; break
        }
        if (directory === home) break
        directory = path.dirname(directory)
      }
      if (!found) stop('rejected', 'site-packages-not-found')
    }
    const roots = []
    for (const candidate of [...candidates].sort((a, b) => a.length - b.length)) {
      if (!roots.some(root => within(root, candidate))) roots.push(candidate)
    }
    rootsObserved = roots.length
    phase = 'scan'
    const queue = []
    const addDirectory = directory => {
      if (counts.directories >= limits.maxDirectories) stop('incomplete', 'directory-budget')
      counts.directories++; queue.push(directory)
    }
    for (const root of roots) addDirectory(root)
    const unchanged = (before, after) => {
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) stop('incomplete', 'metadata-changed')
    }
    while (queue.length) {
      const directory = queue.pop(), before = physical(directory)
      let handle
      try {
        // 资源先交给 finally，再做操作后时间检查，避免慢 opendir 导致尚未赋值就抛出而泄漏句柄。
        time()
        handle = fs.opendirSync(directory, { bufferSize: 1 })
        time()
        // opendir 与校验之间出现替换时，在读取第一条目录项前停止，不沿链接继续递归。
        unchanged(before, physical(directory))
        for (;;) {
          const entry = metadata(() => handle.readSync())
          if (!entry) break
          if (counts.entries >= limits.maxEntries) stop('incomplete', 'entry-budget')
          counts.entries++
          const child = path.join(directory, entry.name)
          const direct = metadata(() => fs.lstatSync(child))
          if (direct.isSymbolicLink()) stop('rejected', 'linked-entry')
          const stat = physical(child)
          if (stat.isDirectory()) addDirectory(child)
          else if (stat.isFile()) {
            if (counts.files >= limits.maxFiles) stop('incomplete', 'file-budget')
            counts.files++
            if (entry.name.endsWith('.py')) counts.py++
            if (entry.name.endsWith('.pyc')) {
              counts.pyc++
              // 只认有限缓存命名模式，普通文件名/自定义敏感词不会被当作 tag 回传。
              const match = path.basename(directory) === '__pycache__'
                && entry.name.match(/\.(cpython-\d{2,4}[a-z]?|pypy\d{2,4}(?:_pp\d{1,4})?)(?:\.opt-\d{1,2})?\.pyc$/)
              if (match && !tags.has(match[1])) {
                if (tags.size >= limits.maxCacheTags) stop('incomplete', 'cache-tag-budget')
                tags.add(match[1])
              }
            }
          } else stop('rejected', 'special-entry')
        }
        unchanged(before, physical(directory))
      } finally {
        // 即使预算/链接检查失败也关闭本次目录句柄；关闭失败不假称完整。
        if (handle) {
          try { handle.closeSync() } catch { stop('incomplete', 'metadata-unavailable') }
        }
      }
    }
    time()
    return report('complete')
  } catch (error) {
    return error instanceof StopObservation ? report(error.status, error.reason) : report('incomplete', 'metadata-unavailable')
  }
}
