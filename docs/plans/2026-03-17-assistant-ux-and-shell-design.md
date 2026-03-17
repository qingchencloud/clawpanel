# Assistant UX + Windows Shell 优化设计

日期: 2026-03-17

## 目标
1) Windows shell 优先 pwsh，其次 powershell，最后 cmd
2) 复制按钮样式统一，右上角悬浮显示
3) AI 助手输入区新增“优化/恢复原文”按钮，保留撤销栈

## 方案
- 采用方案 B

## 设计细节
### 1) assistant_exec shell 优先级
- Windows: pwsh -> powershell -> cmd
- 执行前检测可用 shell（where / Get-Command）
- 继续使用 build_system_env() 注入完整系统环境

### 2) 复制按钮错位修复
- 不改 Markdown 解析
- chat.css 与 assistant.css 的 pre / code-copy-btn 统一
- copy 按钮右上角悬浮，hover 显示

### 3) AI 优化按钮
- 位置: AI 助手输入区，与发送按钮并列
- 文本模板: “请在不改变原意和语言的前提下，重写为意思更清晰、更简洁的表达。”
- 点击优化：调用同模型在线重写，替换输入框文本
- 快照：保存原文快照 + 优化结果快照
- 恢复原文：发送前始终可用
- 发送后清空快照
- 替换方式: setRangeText + input 事件，保留 Ctrl+Z

## 影响范围
- src-tauri/src/commands/assistant.rs
- src/style/chat.css
- src/style/assistant.css
- src/pages/assistant.js
- src/lib/tauri-api.js（如需复用 call）

## 测试要点
- Windows 下优先使用 pwsh
- 复制按钮在 chat 与 assistant 页面一致
- 优化/恢复流程与撤销栈可用
