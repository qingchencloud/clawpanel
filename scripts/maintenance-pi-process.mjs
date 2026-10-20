/** Pi 会重写 Linux argv 标题；仅在四项进程归属证据同时吻合时接受该受管子进程。 */
export function isManagedRenamedPiProcess(value, expected) {
  return Number.isSafeInteger(value?.pid) && value.pid > 0
    && Number.isSafeInteger(expected?.parentPid) && expected.parentPid > 0
    && value.parentPid === expected.parentPid
    && typeof value.command === 'string' && value.command.replaceAll('\0', ' ').trim() === 'pi'
    && ['nodePath', 'workspace', 'agentPath'].every(key => typeof expected[key] === 'string' && expected[key].startsWith('/'))
    && value.executable === expected.nodePath
    && value.workspace === expected.workspace
    && value.agentPath === expected.agentPath
}
