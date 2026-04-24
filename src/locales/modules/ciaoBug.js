import { _ } from '../helper.js'

/**
 * @homebridge/ciao Windows cmd 弹窗 bug 的用户提示文案
 * 上游 issue: https://github.com/homebridge/ciao/issues/64
 * 上游 PR:    https://github.com/homebridge/ciao/pull/65
 */
export default {
  toastTitle: _(
    '检测到已知问题：OpenClaw 运行时 Windows 上每 15 秒会弹一次 cmd 窗口',
    'Known issue detected: OpenClaw causes a cmd popup every 15s on Windows',
    '偵測到已知問題：OpenClaw 執行時 Windows 每 15 秒會彈出 cmd 視窗',
    '既知の問題を検出：Windows で OpenClaw 実行時、15 秒ごとに cmd ウィンドウが点滅します',
    '알려진 문제 감지: Windows에서 OpenClaw 실행 시 15초마다 cmd 창이 깜박임',
  ),
  viewDetail: _(
    '查看详情',
    'View details',
    '檢視詳情',
    '詳細を表示',
    '자세히 보기',
  ),
  modalTitle: _(
    'Windows cmd 弹窗问题 — 第三方库 bug',
    'Windows cmd popup — third-party library bug',
    'Windows cmd 彈窗問題 — 第三方函式庫 bug',
    'Windows cmd ポップアップ — サードパーティ製ライブラリの不具合',
    'Windows cmd 팝업 — 서드파티 라이브러리 버그',
  ),
  summary: _(
    '这是 OpenClaw 依赖的 @homebridge/ciao 库的已知 bug，不是 ClawPanel 或 OpenClaw 本身的问题。每 15-30 秒 ciao 会调用 arp -a 刷新网络接口缓存，但未使用 windowsHide 参数，所以 Windows 上会弹出一个短暂的 cmd 窗口。功能本身完全正常，只是视觉干扰。',
    'This is a known bug in @homebridge/ciao, which OpenClaw depends on. It is not a bug of ClawPanel or OpenClaw itself. Every 15–30 seconds ciao calls "arp -a" to refresh the network interface cache, but without the windowsHide option, so a cmd window flashes briefly on Windows. Functionality is unaffected — it is purely a visual annoyance.',
    '這是 OpenClaw 相依的 @homebridge/ciao 函式庫的已知 bug，不是 ClawPanel 或 OpenClaw 本身的問題。每 15–30 秒 ciao 會呼叫 arp -a 重新整理網路介面快取，但沒有使用 windowsHide 參數，所以 Windows 上會彈出短暫的 cmd 視窗。功能本身完全正常，只是視覺干擾。',
    'これは OpenClaw が依存している @homebridge/ciao ライブラリの既知の不具合であり、ClawPanel や OpenClaw 本体の問題ではありません。ciao は 15〜30 秒ごとに "arp -a" を呼び出してネットワークインターフェースのキャッシュを更新しますが、windowsHide オプションが指定されていないため、Windows では cmd ウィンドウが一瞬点滅します。動作自体は正常で、視覚的な煩わしさのみです。',
    '이것은 OpenClaw가 의존하는 @homebridge/ciao 라이브러리의 알려진 버그이며 ClawPanel이나 OpenClaw 자체의 문제가 아닙니다. ciao는 15~30초마다 "arp -a"를 호출하여 네트워크 인터페이스 캐시를 갱신하는데 windowsHide 옵션을 지정하지 않아 Windows에서 cmd 창이 순간적으로 깜박입니다. 기능 자체는 정상이며 시각적 방해일 뿐입니다.',
  ),
  envTitle: _(
    '当前环境',
    'Environment',
    '目前環境',
    '現在の環境',
    '현재 환경',
  ),
  pathLabel: _(
    '源文件路径',
    'Source file',
    '原始檔路徑',
    'ソースファイルパス',
    '소스 파일 경로',
  ),
  fixTitle: _(
    '解决方案',
    'How to fix',
    '解決方式',
    '対処方法',
    '해결 방법',
  ),
  // HTML 允许：可包含超链接。escapeHtml 在这些条目上不启用。
  fixUpstream: _(
    '<b>等待上游合并</b> —— 上游已有 <a href="https://github.com/homebridge/ciao/pull/65" target="_blank" rel="noopener">PR #65</a> 提供修复，未合并。OpenClaw 升级 ciao 后自动消失。',
    '<b>Wait for upstream merge</b> — <a href="https://github.com/homebridge/ciao/pull/65" target="_blank" rel="noopener">PR #65</a> already provides the fix but has not been merged. Will disappear once OpenClaw upgrades its ciao dependency.',
    '<b>等待上游合併</b> —— 上游已有 <a href="https://github.com/homebridge/ciao/pull/65" target="_blank" rel="noopener">PR #65</a> 提供修復，尚未合併。OpenClaw 升級 ciao 後會自動消失。',
    '<b>上流のマージを待つ</b> —— <a href="https://github.com/homebridge/ciao/pull/65" target="_blank" rel="noopener">PR #65</a> で既に修正が提供されていますが、未マージです。OpenClaw が ciao を更新すれば自動的に解消されます。',
    '<b>업스트림 병합 대기</b> —— <a href="https://github.com/homebridge/ciao/pull/65" target="_blank" rel="noopener">PR #65</a>에 이미 수정이 올라와 있지만 병합되지 않았습니다. OpenClaw가 ciao 의존성을 업데이트하면 자동으로 사라집니다.',
  ),
  fixPatchPackage: _(
    '<b>使用 patch-package 给 OpenClaw 打补丁</b>：在 OpenClaw 源码仓库（或 npm 全局安装目录下的 openclaw 包目录）执行 <code>npx patch-package @homebridge/ciao</code>，在 NetworkManager.js 的 exec 调用中加 <code>{ windowsHide: true }</code>。',
    '<b>Apply a patch-package patch to OpenClaw</b>: in the OpenClaw source repo (or the globally installed openclaw directory), run <code>npx patch-package @homebridge/ciao</code> after adding <code>{ windowsHide: true }</code> to the exec calls in NetworkManager.js.',
    '<b>使用 patch-package 為 OpenClaw 套用修補</b>：在 OpenClaw 原始碼倉庫（或 npm 全域安裝目錄的 openclaw 包目錄）執行 <code>npx patch-package @homebridge/ciao</code>，在 NetworkManager.js 的 exec 呼叫中加入 <code>{ windowsHide: true }</code>。',
    '<b>patch-package で OpenClaw にパッチを適用</b>：OpenClaw のソースリポジトリ（または npm グローバル インストール ディレクトリ内の openclaw パッケージ ディレクトリ）で <code>npx patch-package @homebridge/ciao</code> を実行し、NetworkManager.js の exec 呼び出しに <code>{ windowsHide: true }</code> を追加してください。',
    '<b>patch-package로 OpenClaw에 패치 적용</b>: OpenClaw 소스 저장소(또는 npm 전역 설치 디렉터리의 openclaw 패키지 디렉터리)에서 NetworkManager.js의 exec 호출에 <code>{ windowsHide: true }</code>를 추가한 뒤 <code>npx patch-package @homebridge/ciao</code>를 실행하세요.',
  ),
  fixManual: _(
    '<b>手动编辑 NetworkManager.js</b>（最简单，但升级 openclaw 后需重做）：用编辑器打开上面显示的文件路径，找到 6 处 <code>child_process.exec("arp ...")</code> 调用，在 URL 参数和回调之间加 <code>{ windowsHide: true },</code>，保存后重启 Gateway。',
    '<b>Manually edit NetworkManager.js</b> (simplest, but you must redo it after upgrading openclaw): open the file at the path above, find the 6 <code>child_process.exec("arp ...")</code> calls, add <code>{ windowsHide: true },</code> between the first argument and the callback, save and restart Gateway.',
    '<b>手動編輯 NetworkManager.js</b>（最簡單，但升級 openclaw 後需重做）：用編輯器打開上面顯示的檔案路徑，找到 6 處 <code>child_process.exec("arp ...")</code> 呼叫，在 URL 參數和回呼之間加入 <code>{ windowsHide: true },</code>，儲存後重新啟動 Gateway。',
    '<b>NetworkManager.js を手動で編集</b>（最も簡単ですが、openclaw を更新するたびにやり直しが必要）：上記のパスのファイルを開き、<code>child_process.exec("arp ...")</code> の 6 箇所の呼び出しを探して、URL 引数とコールバックの間に <code>{ windowsHide: true },</code> を追加し、保存して Gateway を再起動してください。',
    '<b>NetworkManager.js 수동 편집</b>(가장 간단하지만 openclaw 업그레이드 후 다시 해야 함): 위 경로의 파일을 편집기로 열고 6개의 <code>child_process.exec("arp ...")</code> 호출을 찾아 URL 인수와 콜백 사이에 <code>{ windowsHide: true },</code>를 추가한 후 저장하고 Gateway를 재시작하세요.',
  ),
  linkIssue: _(
    '上游 Issue #64',
    'Upstream issue #64',
    '上游 Issue #64',
    '上流 Issue #64',
    '업스트림 Issue #64',
  ),
  linkPr: _(
    '上游修复 PR #65',
    'Upstream fix PR #65',
    '上游修復 PR #65',
    '上流修正 PR #65',
    '업스트림 수정 PR #65',
  ),
  disclaimer: _(
    '说明：ClawPanel 选择「检测并告知」而不是「自动修改你的 node_modules」—— 我们尊重你对本机软件的控制权。',
    'Note: ClawPanel chose "detect & inform" instead of "silently patch your node_modules" — we respect your control over local software.',
    '說明：ClawPanel 選擇「偵測並告知」而不是「自動修改你的 node_modules」—— 我們尊重你對本機軟體的控制權。',
    '注：ClawPanel は「検出して通知する」ことを選択しました。「node_modules を自動改変する」のではなく、ローカルソフトウェアに対するユーザーのコントロールを尊重しています。',
    '참고: ClawPanel은 node_modules를 자동으로 수정하는 대신 "감지하고 알리는" 방식을 선택했습니다 — 로컬 소프트웨어에 대한 사용자의 통제권을 존중합니다.',
  ),
  dismissForVersion: _(
    '已了解，不再提醒本版本',
    'Got it, don’t remind for this version',
    '已了解，不再提醒本版本',
    '了解しました。このバージョンでは再通知しません',
    '이해했습니다, 이 버전에서는 다시 알리지 마세요',
  ),
  dismissed: _(
    '已忽略此版本的提醒',
    'Reminder dismissed for this version',
    '已忽略此版本的提醒',
    'このバージョンの通知を無視しました',
    '이 버전의 알림을 무시했습니다',
  ),
}
