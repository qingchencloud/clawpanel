# 每日维护（第一阶段：观察与候选适配）

## 当前边界

每日检查上游版本和本仓库反馈，整理报告。当前日常自动维护由本地 Codex 会话定时任务执行：自主评估技术风险、隔离复现与适配、测试、推送，并在同一提交的三平台 CI 与相关真实运行验收通过后，按用户授权推送新 tag；无实际改动不空发版。电脑及 Codex 需要保持运行。

2026-10-16 用户将项目范围内的技术维护判断委托给本地 Codex：技术高风险保留原分级、审查具体版本/接口与回滚方案，增加针对性负向验收及新旧版本实测，证据齐全后自主推进，不逐版让用户判断风险。验收缺失或失败就保留旧推荐、暂缓该候选并自行诊断；不得删断言、降低扫描器风险等级或放松认证/沙箱来换绿灯。新增费用、真实业务数据删除/不可逆迁移、扩大生产公网权限、更换真实身份，以及其他项目/官网等业务边界，仍说明具体影响后确认。此委托只适用于本地流程，下面 GitHub 控制器的候选守卫和默认关闭状态保持不变。

**GitHub 维护控制器的自动合并、tag、Release、生产部署和用户机器内核升级仍关闭。** `autoRelease=false` 限定的是该控制器，不是对本地 Codex 已授权发版步骤的替代。控制器没有改一个开关就能发版的路径。

本工作流是仓库维护设施，不是新增的面板前端功能。新增 `.github/workflows/maintenance.yml`；经维护者确认，原有 CI/Release 的测试和构建 job 改为只读、checkout 不保留凭据，仅独立发布 job 保留必要写权限。GitHub 的独立 AI 候选与草稿 PR 流程保留为可选项，默认未开启；日常本地 Codex 维护不要求额外 AI Key/GitHub App。

## 工作流

北京时间每天 09:17，或在 Actions 中手工运行 `Daily Maintenance`。仅当前主仓库的 `main` 执行；没有 `pull_request_target`，外部 PR 不直接触发带凭据的维护任务。

1. **scan**：只读 GitHub/npm，写出 `report.json`、`report.md`、`prompt.md`。
2. **adapt**：仅数据完整且存在普通候选时，在隔离 checkout 运行一轮 AI；没有内容/PR 写入令牌。先复现再改代码，最终生成结构化分级结果和 patch。
3. **verify / runtime-verify**：可信 `guard` 检查补丁后，再用 `pins` 回读候选 JS/Rust/镜像的精确目标版本；三平台运行 Node/Rust 回归和构建。另一个全新 Linux runner 将整个可信 tooling 以**只读挂载**放入非特权容器，不挂 Docker socket 或宿主 HOME，再运行真实内核验收；候选测试无法改写后续可信验收器。没有运行、缺依赖或不支持的场景均失败，不标绿。Linux 容器验收不替代三平台原生 GUI/内核验收。
4. **draft**：仅三平台回归和独立容器运行验收都成功且显式开启候选 PR 功能时，使用仓库限定的 GitHub App 创建草稿；此 job 不执行候选代码、不安装其依赖。复核 `main` SHA，不强推已有分支，不重开人工关闭的候选。分支已创建但 PR 请求失败时，校验候选身份、patch 哈希和基线 parent 及实际 Git tree 后可恢复创建；不接管同名陌生分支。
5. **notify**：高风险、不完整数据、适配/测试/草稿写入异常时，在机器人自有的一个汇总 Issue 通知。相同指纹不重复写入；可以配置明确的维护者账号提及。

每个 job 有超时，同一时间只运行一轮每日维护；维护设施的 main 推送和 PR 均跑三平台控制器黑盒 E2E，PR 不触发线上采集或带凭据的 AI/通知 job。手工运行时启用 `runtime_selftest`，会额外在独立非特权 Linux 容器运行 OpenClaw、Hermes、OpenCode 和 DSH 默认/预览五项实装验收，不依赖 AI 候选或 AI 凭据。发 tag 前须核对具体容器 job 实际执行成功及报告绑定同一 SHA；skipped 和历史绿灯不算通过。暂不自动重试 AI，避免无限消耗。失败/高风险候选身份写入自有汇总 Issue 的 `clawpanel-maintenance-blocked` 标记，后续保留待确认，不重复调用 AI；维护者复核后可删除该候选的 blocked 标记允许重试。定时任务可能延迟，本阶段未实现独立失活 watchdog。

## 版本与反馈策略

`.github/maintenance/policy.json` 集中登记组件、官方数据源、npm 通道、当前源码基线位置和允许修改范围。第一阶段不重构现有运行时读取方式；扫描时核验 JS/Rust/发行镜像基线一致。

- OpenClaw 官方版、汉化版、Hermes、DSH 默认/预览、OpenCode、Pi 与微信插件分别登记。
- npm 按指定 dist-tag 解析**精确版本**并取得包完整性元数据；不按 GitHub 发布时间猜 npm 推荐版本。
- GitHub 用近期 Release 发现通道目标，npm 与官方 tag 不对应时提高风险。对待升级候选另做有界 Release 分页：最多 6 页、每页 100 条，必须读到可信分页终点，不能仅因首屏出现基线和目标就推断中间版本完整；失败或超预算按 high，不宣称审查全部历史源码。
- 风险复核覆盖当前与目标之间的正式发布说明，而非只读最终简述。完整 Changelog 链接仅转换为同一官方仓库、精确目标 tag 的 Contents API；不向材料中的 URL 发请求、不跟随重定向或浮动 main。支持裸链、引用式链接、单文件升级区间及分片索引，验证分片真实版本覆盖，校验 Git blob/UTF-8/字节数；最多 32 个版本、16 次文件请求、1 MiB，失败请求也扣预算并缓存。基线缺失、compare-only、空白或仅标题/注释、缺片、错链、循环、外域、内容错误或超预算均保留缺口并提高为 high，不把链接当作已审查。
- 认证、凭据、权限、PTY origin/ticket、进程执行与受保护网络变化也属于高风险；报告保留范围、精确 ref、材料 hash 及全文指纹。该分级仍不是全部源码安全审计，明确批准的高风险升级由本地流程另作隔离验收，不改成低风险或开启全局自动发布。
- 不自动降级；预览、跨主版本、Node 要求变化、破坏性/安全发布说明和宿主插件兼容变化列为高风险。
- DSH 当前默认本身是 RC，不把它包装成正式版；预览 Alpha 不写入默认推荐。
- 目前自动挑选一个普通**内核版本候选**。Issue/PR 会整理和提供上下文，但未开放对任意反馈自动改代码、合并社区 PR、关闭用户 Issue。

反馈整理包含：

1. 上次正式 Release 发布后更新的 Issue/PR（包含旧问题重开、新评论、PR 评审和评审评论）。
2. 前两次正式 Release 之间的更新时间归档。
3. 历史开放 Issue 积压，避免“没有新增反馈”掩盖未解决问题。普通长正文不会被静默截断或永久卡住巡检：先全文脱敏，超过 8 KiB 的内容保存到完整材料，报告包含摘要、全文/分片 SHA256 及相对引用；中文/emoji 按 UTF-8 码点分片。

反馈状态为**本轮回读状态**，不伪造过去某时刻的状态。首次扫描需要已有正式 Release 基线。GitHub 分页、评论和评审有明确预算；PR 按更新时间倒序跨出时间窗后停止，不遍历全部无关历史。原始全文用于风险扫描，全文指纹覆盖摘要尾部之外的变化。单条反馈限 256 KiB、总量 8 MiB、分片引用 256 片；数据不足、限流、超时、结构错误、超出硬预算或缺片/hash 不符均留下缺口并阻止自动适配。材料路径由可信内容 hash 生成，拒绝输入指定路径和符号链接。报告指纹对集合排序并包含版本及实际评论/评审内容，而非扫描时间；候选身份独立计算，只依赖组件/通道/当前与目标版本/相关源码最近提交和发布说明，无关 Issue 不会重复创建同一升级 PR。机器人自有汇总/候选排除在反馈输入之外，避免自激循环。

反馈、官方发布说明和模型输出均是不可信材料。程序不会执行反馈中的命令，也不把模型自述的“测试通过”当作可信测试步骤。

## 启用配置

### 仅每日巡检

工作流进入 `main` 后即可执行，不需要 AI Key。默认 `MAINTENANCE_ADAPT_ENABLED` / `MAINTENANCE_PR_ENABLED` 均未开启，仍可得到完整巡检与高风险通知。需要 Actions 具备当前仓库的 `contents:read`；通知 job 单独申请 `issues:write`。

可选仓库变量：`MAINTENANCE_NOTIFY_LOGIN`，指定需要确认时提及的 GitHub 用户名。没有该变量时只更新汇总 Issue，用户可订阅该 Issue 或仓库 Actions 通知；这不等同于保证已经送达手机/邮件。

### 可选：开启 GitHub 托管 AI 候选适配和测试

仓库 Secret：`MAINTENANCE_OPENAI_API_KEY`。仓库变量：`MAINTENANCE_ADAPT_ENABLED=true`。

Key 只交给固定提交的官方 Codex Action 保护代理，AI 使用受限 workspace 权限；模型和推理参数沿用 Action 默认值，没有硬编码业务模型。此执行使用独立 API 配额，与本地桌面聊天登录状态分开。缺少 Key 会显式失败并通知。

### 可选：开启 GitHub 托管草稿 PR

使用只安装到当前仓库的 GitHub App，提供：

- 仓库变量 `MAINTENANCE_APP_ID`。
- Secret `MAINTENANCE_APP_PRIVATE_KEY`。
- 仓库变量 `MAINTENANCE_PR_ENABLED=true`。

App 只需要 Contents / Pull requests 写入权限及必要的元数据读取。使用短期安装令牌，让候选 PR 的正常 CI 触发；不使用个人长期 PAT，不授予自动批准/合并/发布能力。即使候选测试通过，本阶段也只创建草稿 PR，后续仍由维护者审核。

公开仓库 artifact 可能对读者可见。本工具只采集公开仓库信息，输出做常见凭据脱敏，仍应避免在公开 Issue 发布真实配置和秘密。若部署到私有仓库或修改采集来源，需重新评估凭据、可见性和脱敏覆盖。

## 本地命令

### Hermes 独立资格验收

`hermes-qualification.yml` 是手工触发、只读的补充验收，不改变每日控制器的 AI/PR/自动发布开关。仅 canonical 仓库的 `main` 执行可信工具，输入必须是完整候选 SHA。Windows 安装仅在 GitHub-hosted 一次性 VM 的真实 runneradmin SID/ProfileList 核验后运行，拒绝本机及 self-hosted；隔离 HOME 不被当作 HKCU 沙箱。记录注册表值与类型、shell、全局 launcher 的前后快照，不自动恢复改动掩盖失败。

Linux 使用原可信 Runtime.Dockerfile、非 root、只读 tooling、无 Docker socket 的容器。实际 fresh11 通过后在原容器同 HOME 启动生产 Web，运行两轮真实 headless Chromium，每轮完整 Send8、210 秒和 42 次健康采样；最后调用生产 STOP 并核验 PID/端口。没有实际运行、缺证据或旧报告均失败。Windows Web 生命周期与原生 Tauri 分开记录；`test-hermes-tauri-qualification.mjs` 使用真实 WebDriver/WebView2/Rust IPC，尚未执行时保持 native 缺口，不能由布尔值回执补绿。

冷启动排障可显式选择 `startup_diagnostic=true`（默认关闭，仅 Windows）。真实 VM/SID 准入和 privatecompletion 核验后，可信工具才对本次 Gateway 启动开启 Python importtime，并只读统计私有依赖目录的 pyc 元数据。PM 原脚本、source/currency/products/stamp/boot 校验、20 秒启动、15 秒 CLI 和 900 秒安装预算保持不变。诊断不执行 native 生命周期、不得作为发布资格；报告固定 `qualificationPass=false`，完整汇总仍拒绝缺失 native/生命周期证据。后置晚就绪只说明诊断观察，不将启动超时转绿。若 importtime 仍未覆盖耗时，可再显式选择 `startup_stack_samples=true`（仅 candidate/Windows/diagnostic），每2秒记录一次无局部变量的 Python 栈，60秒停止，主线程 PID 映射用于区分重执行的解释器；采样开销不作为正常启动成绩。输出为带 `-diagnostic` 后缀的独立脱敏 artifact，正常资格必须另跑。

原始证据保留在一次性 runner，公开 artifact 仅包含另外生成的脱敏副本；不上传 HOME、dotenv、运行时、缓存或真实凭据，trace ZIP 逐成员脱敏。资格验收本身不提交、不升级用户机器、不打 tag。

`weixin-qualification.yml` 是独立的手工 Windows 原生验收：固定官方宿主5.12/9.8/10.4、完整候选SHA，真实VM/SID准入后才进行私有安装、no-bundle构建和WebView2操作。`ui-origin` 只记录已执行的安装确认及来源边界阶段，不构成完整发版资格；`complete` 对缺失负向或清理证据保持失败。报告分别列出真实UI、SDK/配置回读、有效票据的iframe拒绝、上游策略拒绝及窗口覆盖缺口，不用fixture、缺API或框架拒绝创建窗口代替产品来源拒绝。工作流只有读权限，不安装本机运行时、不修改官网或控制器发版开关。

Hermes Windows的生产STOP验收须有新鲜、非空的停止前PID及CreationDate、同一集合的停止后观察和两个配置端口的实际关闭证据。空进程集合、空stdout、旧历史Set和单纯基础设施清理都不构成生产STOP通过。CLI的execFile观察只保留脱敏诊断，不替换原回调、双流、退出码或预算。

在仓库根目录执行（不会改动真实运行时）：

```powershell
npm run maintenance:scan
node scripts/maintenance.mjs scan --output .tmp/maintenance/manual
npm run maintenance:test
```

巡检可以使用进程环境中的 `GH_TOKEN` 或 `GITHUB_TOKEN` 访问 GitHub；只向固定 GitHub API 发送，npm 请求不带 GitHub 凭据。无凭据时受公开 API 额度限制，超限结果为不完整，不会误报“没有更新”。请通过凭据管理器或已有 CI Secret 提供，不写入仓库或报告。

控制器 E2E 使用回环 HTTP 服务和临时 Git 仓库，从真实 CLI 子进程验证完整路径；`--fixture` 只允许回环 HTTP，且不转发任何进程 GitHub 凭据。它证明控制器行为，不证明真实 GitHub 写入或内核兼容。

```powershell
node scripts/test-maintenance.mjs --output .tmp/maintenance-e2e/manual
node scripts/maintenance-runtime-smoke.mjs --engine pi --output .tmp/maintenance-runtime/manual-pi
```

真实运行时验收会下载实际发行包，使用全新 HOME、独立回环端口和本地模拟模型；输出目录须全新。支持情况、失败注入和证据格式见 [运行时验收](maintenance-runtime-cases.md)。运行前应具备相应 Node/npm、Python/uv 或 Docker，缺少依赖不会自动视为通过。配置回读、真实模型请求、停止/清理分别记录；本地模拟模型不是收费模型或真实渠道账号联调证明。

`guard`、`notify`、`propose` 是供工作流使用的内部 CLI。`notify` / `propose` 默认 dry-run，加 `--apply` 才产生其明确范围内的写入；开发测试不要对真实 GitHub 使用 `--apply`。

## 证据和后续门禁

- 本地：`.tmp/maintenance-*`；控制器 E2E 保存输入、命令、期望/实际和报告。
- Actions：`maintenance-scan`、`maintenance-candidate`、三平台 `maintenance-verification-*` 和独立 `maintenance-runtime-verification` artifacts，保留 30 天。
- 候选 patch 限制文件数、改动行数和字节数；禁止工作流、维护器、发布配置、依赖、二进制、符号链接、子模块及路径穿越。认证、权限、签名或执行/网络边界的源码差异要求人工确认。
- 候选分支命名由可信候选身份决定，固定为 `codex/maintenance-<candidateKey前16位>`。已有分支冲突或写入结果不明时不覆盖，只恢复严格匹配的孤立候选，其余保留现场确认。
- GitHub App/AI/真实 GitHub 通知及草稿创建，需要在启用后做一次受控在线验收；本地 HTTP fixture 不替代这一门禁。
- GitHub 控制器自动发版仍未实现、未启用。本地 Codex 的已授权发版须满足同一 SHA 的主分支三平台 CI、具体运行验收、发布前复查及发布全资产回读，正常每日至多一版，异常暂停；保持旧产物与配置备份，结构性迁移不做盲目二进制回退。

参考：[GitHub 工作流触发](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)、[官方 Codex Action](https://github.com/openai/codex-action)、[GitHub 不可信输入](https://docs.github.com/en/actions/concepts/security/script-injections)。
