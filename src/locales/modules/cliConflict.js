/**
 * CLI 冲突横幅 (cli-conflict-banner) 文案
 * 用于 OpenClaw 仪表盘提示用户存在非 ClawPanel 管理的 CLI 冲突项
 */
import { _ } from '../helper.js'

export default {
  title: _(
    '检测到 {count} 处可能冲突的 OpenClaw 安装',
    'Detected {count} possibly conflicting OpenClaw installation(s)',
    '偵測到 {count} 處可能衝突的 OpenClaw 安裝',
  ),
  desc: _(
    '系统 PATH 中存在非 ClawPanel 管理的 OpenClaw（如 Cherry Studio 内嵌、旧 npm 全局），可能导致终端命令拿到老版本，引发 schema 不兼容、doctor --fix 卡死等问题。',
    'Your PATH has OpenClaw installations not managed by ClawPanel (e.g. Cherry Studio bundled, legacy npm global). They can cause terminal commands to pick up old versions, triggering schema mismatches and doctor --fix hangs.',
    '系統 PATH 中存在非 ClawPanel 管理的 OpenClaw（如 Cherry Studio 內嵌、舊 npm 全域），可能導致終端指令取得舊版本，引發 schema 不相容、doctor --fix 卡住等問題。',
  ),
  viewDetails: _('查看详情', 'View details', '查看詳情'),
  hideDetails: _('收起详情', 'Hide details', '收起詳情'),
  quarantineAll: _('一键隔离', 'Quarantine all', '一鍵隔離'),
  quarantining: _('正在隔离…', 'Quarantining…', '正在隔離…'),
  quarantineOne: _('隔离', 'Quarantine', '隔離'),
  dismiss: _('暂时忽略', 'Dismiss', '暫時忽略'),
  dismissedHint: _(
    '已忽略本次检测。下次启动会重新扫描。',
    'Dismissed for this session. Next launch will scan again.',
    '已忽略本次偵測。下次啟動會重新掃描。',
  ),
  quarantineOk: _(
    '已隔离 {count} 个冲突项',
    'Quarantined {count} item(s)',
    '已隔離 {count} 個衝突項',
  ),
  quarantinePartial: _(
    '另有 {count} 个未隔离',
    '{count} item(s) failed',
    '另有 {count} 個未隔離',
  ),
  quarantineFail: _(
    '隔离失败：{error}',
    'Quarantine failed: {error}',
    '隔離失敗：{error}',
  ),
  quarantineOneOk: _('已隔离', 'Quarantined', '已隔離'),
  footnote: _(
    '隔离 = 重命名为 .disabled-by-clawpanel-<时间>.bak（不会删除）。如需恢复，到原目录把 .bak 文件改回原名即可。',
    'Quarantine = rename to .disabled-by-clawpanel-<timestamp>.bak (not deleted). To restore, rename the .bak back to its original name in the same directory.',
    '隔離 = 重新命名為 .disabled-by-clawpanel-<時間>.bak（不會刪除）。如需恢復，到原目錄把 .bak 檔案改回原名即可。',
  ),
}
