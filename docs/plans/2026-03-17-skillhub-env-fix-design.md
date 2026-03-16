# SkillHub 动态探测与系统环境变量继承设计

日期: 2026-03-17

## 背景与目标
- 现象: 页面提示已安装 SkillHub CLI，但检查仍显示未安装
- 根因: ClawPanel 进程环境变量未刷新或 PATH 不完整，导致技能检测失败
- 目标:
  1) SkillHub CLI 检测支持动态探测路径并返回版本与命中路径
  2) 所有 Tauri 命令执行时继承完整系统环境变量（用户 + 系统）

## 范围
- 仅修改 ClawPanel Tauri 后端命令执行环境与 SkillHub 检测逻辑
- 前端仅增加路径展示（若返回 path）

## 方案对比
### 方案 A
- 仅在 SkillHub 检测执行 `where skillhub` 进行路径探测
- 其他命令仍使用当前进程环境
- 缺点: 无法解决晴辰助手命令缺少系统环境变量的问题

### 方案 B（推荐）
- 增加统一系统环境构建函数，合并进程 env + Windows 用户/系统 env
- 所有 Tauri 命令使用该环境执行
- SkillHub 检测失败时 `where skillhub` 探测并返回路径
- 优点: 满足所有需求，改动集中

### 方案 C
- 增加 envPolicy 配置项（inherit/system/whitelist）
- 需要新 UI 与配置逻辑
- 超出当前范围

## 设计细节
### 1) 系统环境变量合并
- 新增 `build_system_env()`:
  - 读取当前进程 env
  - 读取注册表:
    - HKCU\Environment
    - HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment
  - 合并优先级: 进程 env 覆盖系统 env
  - PATH 合并去重（用户 + 系统 + 进程）

### 2) SkillHub 动态探测
- `skills_skillhub_check` 流程:
  1) 直接尝试 `skillhub --version`
  2) 失败则执行 `where skillhub`
  3) 若命中路径，使用该路径执行 `--version`
  4) 返回 `{ installed: true, version, path }`

### 3) 统一命令执行环境
- 所有 `tokio::process::Command` 调用统一使用 `cmd.envs(build_system_env())`
- 现有 `enhanced_path()` 可改为调用 `build_system_env()` 或保留但不再使用

### 4) 前端展示
- Skills 页面展示安装路径（若后端返回 path）
- 状态提示保持一致

## 错误处理
- 注册表读取失败时回退到当前进程 env
- `where skillhub` 失败仍返回 `installed: false`

## 测试要点
- PATH 未刷新时: `skills_skillhub_check` 仍能识别已安装
- 晴辰助手执行命令继承系统变量（如 PATH / HTTP_PROXY）
- UI 能展示 path 与版本
