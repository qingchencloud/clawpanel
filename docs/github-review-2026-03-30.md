# ClawPanel GitHub Issues & PRs 待处理清单

> 生成时间：2026-03-30 | 范围：2026-03-25 ~ 2026-03-30 | 仓库：qingchencloud/clawpanel

---

## 📊 概览

| 类别 | 数量 |
|------|------|
| 新 Issues（5天内创建） | 22 个 |
| 其中 OPEN | 19 个 |
| 其中 CLOSED | 3 个 |
| 活跃 PRs（5天内创建） | 3 个 |
| 有冲突的老 PRs | 4 个 |

---

## 🔴 P0 紧急 — 服务阻塞/无法使用

### Issue #160 — [Bug] 恶性Bug：特定操作导致服务器必定阻塞
- **状态**: OPEN 🔥 | **标签**: `bug`, `openclaw-processing`
- **提交者**: yushu200403 | **创建**: 03-27
- **问题**: 点击"实时聊天"页面的自动修复 Origin 按钮后，ClawPanel 进入无限循环持续尝试访问 Gateway，导致 2C4G 服务器完全阻塞，只能强制重启
- **环境**: Ubuntu 22.04, v0.10.0
- **根因推测**: 配置更改后进入无延迟死循环
- **修复建议**: 检查 Gateway 连接重试逻辑，加退避/上限
- **链接**: https://github.com/qingchencloud/clawpanel/issues/160

### Issue #151 — [Bug] Gateway 检测错误导致与系统 OpenClaw 冲突不断重启
- **状态**: OPEN 🔥 | **标签**: `bug`, `openclaw-processing`
- **提交者**: fakers777 | **创建**: 03-26
- **问题**: Gateway 检测逻辑错误，ClawPanel 与系统已运行的 OpenClaw 冲突，造成不断重启
- **环境**: Ubuntu, v0.10.0
- **链接**: https://github.com/qingchencloud/clawpanel/issues/151

---

## 🟠 P1 高优 — 核心功能故障

### Issue #150 — [Bug] 升级到 0.99 版本后完全打不开 ClawPanel
- **状态**: OPEN | **标签**: `bug`
- **提交者**: carlyle168 | **创建**: 03-25
- **问题**: 从 0.97 一路升级到 0.98/0.99 后 ClawPanel 无法打开，反复安装无效
- **环境**: Windows 10
- **链接**: https://github.com/qingchencloud/clawpanel/issues/150

### Issue #165 — fix: Agent 绑定消息渠道保存失败 (readConfig is not defined)
- **状态**: OPEN | **标签**: `openclaw-processing`
- **提交者**: jx270417948 | **创建**: 03-28
- **问题**: Agent 绑定飞书消息渠道时点保存报错 `readConfig is not defined`
- **环境**: Linux (Ubuntu), v0.10.0, openclaw-lark 2026.3.26
- **根因**: 代码中引用了未定义的 `readConfig` 函数
- **链接**: https://github.com/qingchencloud/clawpanel/issues/165

### Issue #159 — [Bug] Docker 双容器找不到 openclaw，单容器把系统搞死
- **状态**: OPEN | **标签**: `bug`, `openclaw-processing`
- **提交者**: wanababy | **创建**: 03-27
- **问题**: Docker 双容器部署时 ClawPanel 找不到 OpenClaw CLI；单容器模式下 ClawPanel 自动拉起 Gateway 与已有进程冲突导致系统崩溃
- **修复建议**: 需要添加 `DISABLE_LOCAL_GATEWAY_SPAWN` 环境变量开关，或支持纯远程 Gateway 模式
- **链接**: https://github.com/qingchencloud/clawpanel/issues/159

### Issue #157 — [Bug] 版本问题太多
- **状态**: OPEN | **标签**: `bug`, `openclaw-processing`
- **提交者**: lwsg1987 | **创建**: 03-27
- **问题**: 多个问题集合（综合反馈）：
  1. 版本过高提示降级，降级后版本号不变
  2. 安装 skill(summarize) 提示缺依赖，安完后继续提示
  3. 安装微信插件卡住，手动 CLI 安装后可用但无法识别微信图片
- **环境**: Ubuntu 24.02, v0.10.0
- **链接**: https://github.com/qingchencloud/clawpanel/issues/157

### Issue #152 — 无法切换 OpenClaw 版本
- **状态**: OPEN
- **提交者**: SEVENTEEN-TAN | **创建**: 03-26
- **问题**: 版本切换操作失败或无响应
- **环境**: Windows x86_64, Node.js v22.22.1, OpenClaw 2026.3.24
- **链接**: https://github.com/qingchencloud/clawpanel/issues/152

---

## 🟡 P2 中等 — 功能缺陷/兼容性

### Issue #166 — 未检测到任何 Skills
- **状态**: OPEN | **创建**: 03-30 (今天)
- **提交者**: penghaiqiu1988
- **问题**: Skills 页面显示"CLI 可用，但返回结果解析失败"，"未检测到任何 Skills"
- **环境**: v0.10.0, OpenClaw 汉化版 2026.3.24-zh.1
- **链接**: https://github.com/qingchencloud/clawpanel/issues/166

### Issue #156 — [Bug] Linux Web 模式下 CLI 检测失败（systemd 缺少 PATH）
- **状态**: OPEN | **创建**: 03-26
- **提交者**: XIAzhenglin
- **问题**: `linux-deploy.sh` 部署后面板显示"OpenClaw CLI 未安装"，但终端 `which openclaw` 正常
- **根因**: systemd 服务配置缺少 PATH 环境变量，npm 全局路径未包含
- **修复方案已给出**: 
  - 方案 1: systemd 服务添加 PATH 环境变量
  - 方案 2: `dev-api.js` 中 `findOpenclawBin()` 补充 npm 全局路径扫描
- **链接**: https://github.com/qingchencloud/clawpanel/issues/156

### Issue #155 — [Bug] (无标题描述)
- **状态**: OPEN | **标签**: `bug` | **创建**: 03-26
- **提交者**: xiaochengshiguduo
- **链接**: https://github.com/qingchencloud/clawpanel/issues/155

### Issue #154 — [Bug] (无标题描述)
- **状态**: OPEN | **标签**: `bug` | **创建**: 03-26
- **提交者**: friendfish
- **链接**: https://github.com/qingchencloud/clawpanel/issues/154

### Issue #153 — 执行 openclaw devices list 命令失败
- **状态**: OPEN | **创建**: 03-26
- **提交者**: caofakun
- **问题**: 执行 `openclaw devices list` 报错 gateway connect failed (1000 normal closure)，设备配对批准按钮无反应
- **环境**: Windows, OpenClaw 中文版 2026.3.13
- **链接**: https://github.com/qingchencloud/clawpanel/issues/153

### Issue #149 — [Bug] Models configured via OAuth not being pulled
- **状态**: OPEN | **创建**: 03-25
- **提交者**: adam479
- **问题**: 通过 OAuth 配置的模型不被 ClawPanel 拉取/显示
- **根因推测**: OAuth token 未在模型发现接口的请求头中传递
- **链接**: https://github.com/qingchencloud/clawpanel/issues/149

### Issue #148 — [Bug] AI 助手读取 OpenClaw 配置测试无法联通
- **状态**: OPEN | **标签**: `bug` | **创建**: 03-25
- **提交者**: WHHGR
- **问题**: AI 助手 API 设置中导入 OpenClaw 配置后测试 Failed to fetch，但在 OpenClaw 中可正常使用
- **环境**: Ubuntu 20.04, v0.9.9
- **链接**: https://github.com/qingchencloud/clawpanel/issues/148

### Issue #146 — 升级 OpenClaw 后触发重复升级检测
- **状态**: OPEN | **创建**: 03-25
- **提交者**: z1a2q3wolf
- **问题**: 升级完成后每次打开 ClawPanel 仍弹出升级提示
- **根因**: 版本检测逻辑有误，升级后未正确更新本地缓存版本号
- **链接**: https://github.com/qingchencloud/clawpanel/issues/146

### Issue #144 — 黑苹果 OpenClaw 未检测到
- **状态**: OPEN | **标签**: `openclaw-processing` | **创建**: 03-25
- **提交者**: kof8855
- **问题**: Hackintosh 环境下 OpenClaw 检测失败
- **链接**: https://github.com/qingchencloud/clawpanel/issues/144

### Issue #143 — [Bug] Mac 电脑的多版本 Node 选择
- **状态**: OPEN | **标签**: `bug` | **创建**: 03-25
- **提交者**: zshaxy
- **问题**: macOS 多版本 Node.js 环境兼容问题
- **链接**: https://github.com/qingchencloud/clawpanel/issues/143

### Issue #158 — [Bug] Channel 插件包无法在面板安装
- **状态**: OPEN | **标签**: `bug` | **创建**: 03-27
- **提交者**: joeshen2021
- **问题**: 在 ClawPanel 上安装 channel 插件始终失败，请求支持手动 CLI 安装方式
- **链接**: https://github.com/qingchencloud/clawpanel/issues/158

---

## 🟢 P3 功能请求

### Issue #147 — feat: 定时器支持自然时间格式输入
- **状态**: OPEN | **创建**: 03-25
- **提交者**: z1a2q3wolf
- **问题**: 希望定时器支持自然语言时间格式（如"每天 8 点"），而非只能用 cron 表达式
- **链接**: https://github.com/qingchencloud/clawpanel/issues/147

---

## ✅ 已关闭 Issues

| # | 标题 | 关闭原因 |
|---|------|----------|
| #145 | 切换项目后仪表盘偶发显示"版本信息未获取" | 已修复 |
| #142 | Agent 模型配置问题 | 已修复 |

---

## 🔀 待处理 Pull Requests

### PR #163 — feat: upgrade MiniMax provider preset and add model presets ✅可合并
- **作者**: octo-patch | **创建**: 03-28
- **分支**: `feature/add-minimax-provider`
- **状态**: MERGEABLE
- **变更**: +113/-2 | 4 文件
- **内容**:
  - 修复 MiniMax API 地址从弃用的 `api.minimax.chat` 更新为 `api.minimax.io`
  - 添加 M2.7, M2.7-highspeed (1M上下文), M2.5, M2.5-highspeed 模型预设
  - 更新 README 中英文版本
  - 12 个单测覆盖
- **评估**: 质量良好，有测试，建议合并 ✅
- **链接**: https://github.com/qingchencloud/clawpanel/pull/163

### PR #162 — 修复记忆文件菜单显示问题 ⚠️需审查
- **作者**: roc-xie | **创建**: 03-28
- **分支**: `develop`
- **状态**: MERGEABLE
- **变更**: +141/-93 | 1 文件 (`scripts/dev-api.js`)
- **内容**:
  - 修复工作记忆/记忆归档/核心文件创建后不显示
  - 对齐 Tab 目录路径
  - 递归搜索子目录并支持更多文件扩展名
  - 修复 Agent 工作区路径
- **评估**: 功能修复有价值，但需检查文件路径变更是否影响其他功能 ⚠️
- **链接**: https://github.com/qingchencloud/clawpanel/pull/162

### PR #161 — fix: 重构版本源检测逻辑 + standalone 目录集中化 + Linux 平台检测补全 ⚠️需审查
- **作者**: SEVENTEEN-TAN | **创建**: 03-28
- **分支**: `fix/version-detection-and-standalone`
- **状态**: MERGEABLE
- **变更**: +252/-80 | 8 文件 (Rust + JS)
- **内容**:
  - 新增 Windows `.cmd` shim 文件检测判断 npm 包归属
  - `all_standalone_dirs()` 集中化消除 6 处硬编码
  - Linux 平台检测补全至与 macOS/Windows 同等完整
  - 前端三源显示（官方/汉化/未知来源）
  - 跨源切换时清理 standalone 残留
- **评估**: 改动较大，直接解决 #146 #150 #152 等版本检测问题，需仔细 Review ⚠️
- **链接**: https://github.com/qingchencloud/clawpanel/pull/161

### 有冲突的老 PRs（需决策处理）

| # | 标题 | 作者 | 状态 |
|---|------|------|------|
| #130 | docs: add Japanese README | eltociear | CONFLICTING — 已有 README.ja.md，可关闭 |
| #129 | feat: 消息渠道多账号支持与 Agent 绑定展示 | 0xsline | CONFLICTING — 功能有价值，需 rebase |
| #115 | feat: improve dashboard, skills, sidebar, cloudflared | kiss-kedaya | CONFLICTING — 大改动，需确认是否还需要 |
| #101 | feat: chat virtual scroll | kiss-kedaya | CONFLICTING — 虚拟滚动，需确认 |

---

## 📋 建议处理优先级

### 🎯 立即处理
1. **PR #163** → Review 后合并（MiniMax 修复，质量好）
2. **PR #161** → 重点 Review（解决一大批版本检测 bug: #146 #150 #152）
3. **Issue #160** → P0 修复 Gateway 连接死循环导致服务器阻塞

### ⏳ 本周处理
4. **PR #162** → Review 记忆文件显示修复
5. **Issue #165** → 修复 `readConfig is not defined` 错误
6. **Issue #156** → systemd PATH 问题修复
7. **Issue #159/#151** → Docker 部署模式 + Gateway 冲突，考虑加环境变量开关
8. **Issue #166** → Skills 检测失败（今天新报的）

### 📝 待排期
9. **Issue #149** → OAuth 模型拉取
10. **Issue #148** → AI 助手 API 联通
11. **Issue #147** → 自然时间格式（功能需求）
12. 关闭/整理冲突 PRs (#130 #129 #115 #101)

---

## 🔢 按模块归类

| 模块 | 相关 Issues |
|------|------------|
| **版本检测/升级** | #150 #152 #146 #157 |
| **Gateway/服务管理** | #160 #151 #159 |
| **Skills 管理** | #166 #157 |
| **Docker 部署** | #159 |
| **Linux 部署** | #156 |
| **消息渠道/插件** | #165 #158 |
| **AI 助手** | #148 |
| **设备管理** | #153 |
| **OAuth/模型** | #149 |
| **Mac 兼容性** | #144 #143 |
