/**
 * npm install / upgrade 常见错误诊断
 * 解析 npm 错误信息，返回用户友好的提示和修复建议
 */

const NPM_CMD = 'npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com'

/**
 * @param {string} errStr - npm 错误输出（可含流式日志）
 * @returns {{ title: string, hint?: string, command?: string }}
 */
export function diagnoseInstallError(errStr) {
  const s = errStr.toLowerCase()

  // ===== 1. Git 相关 =====

  // git SSH 权限问题（有 git 但没配 SSH Key）
  if (s.includes('permission denied (publickey)') || s.includes('ssh://git@github')) {
    return {
      title: '安装失败 — Git SSH 权限',
      hint: '依赖包用了 SSH 协议拉取代码，但你没配 GitHub SSH Key。运行以下命令改用 HTTPS：',
      command: 'git config --global url."https://github.com/".insteadOf ssh://git@github.com/',
    }
  }

  // git 未安装（exit 128 + access rights）
  if (s.includes('code 128') || s.includes('exit 128') || s.includes('access rights')) {
    return {
      title: '安装失败 — 需要安装 Git',
      hint: '部分依赖需要通过 Git 下载。请先安装 Git 后重试。',
      command: '下载 Git: https://git-scm.com/downloads',
    }
  }

  // ===== 2. 文件 / 权限 =====

  // EPERM（文件被占用/权限问题）— 放在 ENOENT 前面，优先匹配
  if (s.includes('eperm') || s.includes('operation not permitted')) {
    return {
      title: '安装失败 — 文件被占用或权限不足',
      hint: '常见原因：杀毒软件拦截、Gateway 进程未关闭、或终端缺少管理员权限。\n请先关闭 Gateway，再以管理员身份打开终端手动安装：',
      command: NPM_CMD,
    }
  }

  // ENOENT（文件找不到 / -4058）
  if (s.includes('enoent') || s.includes('-4058') || s.includes('code -4058')) {
    // 尝试从日志中提取具体缺失的路径
    const pathMatch = errStr.match(/enoent[^']*'([^']+)'/i) || errStr.match(/path\s+'([^']+)'/i)
    const missingPath = pathMatch?.[1] || ''

    if (missingPath.includes('node_modules') || missingPath.includes('npm')) {
      return {
        title: '安装失败 — npm 全局目录异常',
        hint: `npm 全局安装目录可能不存在或损坏（${missingPath}）。\n请先修复 npm 目录，再重试安装：`,
        command: 'npm config set prefix "%APPDATA%\\npm" && ' + NPM_CMD,
      }
    }
    return {
      title: '安装失败 — 文件或目录不存在',
      hint: '常见原因：npm 全局目录未创建、杀毒软件隔离了文件、或磁盘权限问题。\n建议步骤：\n1. 关闭杀毒软件的实时防护\n2. 以管理员身份打开 PowerShell\n3. 手动运行安装命令：',
      command: NPM_CMD,
    }
  }

  // EACCES（权限不足）
  if (s.includes('eacces') || s.includes('permission denied')) {
    const isMac = navigator.platform?.includes('Mac') || navigator.userAgent?.includes('Mac')
    return {
      title: '安装失败 — 权限不足',
      hint: isMac ? '请在终端使用 sudo 安装：' : '请以管理员身份打开 PowerShell 安装：',
      command: isMac ? 'sudo ' + NPM_CMD : NPM_CMD,
    }
  }

  // MODULE_NOT_FOUND（安装不完整）
  if (s.includes('module_not_found') || s.includes('cannot find module')) {
    return {
      title: '安装不完整',
      hint: '上次安装可能中断了。先清理残留再重装：',
      command: 'npm cache clean --force && ' + NPM_CMD,
    }
  }

  // ===== 3. 网络 =====

  if (s.includes('etimedout') || s.includes('econnrefused') || s.includes('enotfound')
    || s.includes('fetch failed') || s.includes('socket hang up')
    || s.includes('econnreset') || s.includes('unable to get local issuer')) {
    const isProxy = s.includes('proxy') || s.includes('unable to get local issuer')
    return {
      title: '安装失败 — 网络连接错误',
      hint: isProxy
        ? '检测到代理/证书问题。如果你使用了 VPN 或公司代理，请尝试关闭后重试，或设置 npm 信任证书：'
        : '无法连接到 npm 仓库。请检查网络连接，或尝试使用国内镜像源：',
      command: isProxy
        ? 'npm config set strict-ssl false && ' + NPM_CMD
        : NPM_CMD,
    }
  }

  // ===== 4. npm 自身问题 =====

  // npm 缓存损坏
  if (s.includes('integrity') || s.includes('sha512') || s.includes('cache')) {
    return {
      title: '安装失败 — npm 缓存异常',
      hint: '本地缓存可能损坏。清理缓存后重试：',
      command: 'npm cache clean --force && ' + NPM_CMD,
    }
  }

  // Node.js 版本过低
  if (s.includes('engine') || s.includes('unsupported') || s.includes('required:')) {
    return {
      title: '安装失败 — Node.js 版本不兼容',
      hint: '当前 Node.js 版本过低，OpenClaw 需要 Node.js 18 或更高版本。\n请升级 Node.js：',
      command: '下载最新版: https://nodejs.org/',
    }
  }

  // npm 版本过低或损坏
  if (s.includes('npm err') && (s.includes('cb() never called') || s.includes('code 1'))) {
    return {
      title: '安装失败 — npm 异常',
      hint: 'npm 自身可能异常。尝试更新 npm 后重试：',
      command: 'npm install -g npm@latest && ' + NPM_CMD,
    }
  }

  // ===== 5. 磁盘空间 =====
  if (s.includes('enospc') || s.includes('no space')) {
    return {
      title: '安装失败 — 磁盘空间不足',
      hint: '磁盘空间不足，请清理磁盘后重试。',
    }
  }

  // ===== fallback =====
  return {
    title: '安装失败',
    hint: '请在终端手动尝试安装，查看完整错误信息：',
    command: NPM_CMD,
  }
}
