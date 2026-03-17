# SkillHub 动态探测与系统环境变量继承 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ClawPanel 通过动态探测识别 SkillHub CLI，并让所有 Tauri 命令继承完整系统环境变量（用户 + 系统）。

**Architecture:** 在 Tauri 后端新增统一“系统环境构建函数”，所有命令执行时统一注入 envs；SkillHub 检测失败时走 where 探测并返回命中路径。

**Tech Stack:** Rust (Tauri), Windows Registry, tokio::process::Command

---

## Chunk 1: 环境变量合并工具函数

### Task 1: 新增系统环境合并函数
**Files:**
- Modify: `src-tauri/src/utils.rs`
- Modify: `src-tauri/src/commands/mod.rs`（如已有 enhanced_path 需更新）
- Test: （无自动测试，手工验证）

- [ ] **Step 1: 设计合并逻辑并落地函数**
  
新增 `build_system_env()`，返回 `Vec<(String, String)>`，包含：
- 当前进程 env
- 用户 env（HKCU\Environment）
- 系统 env（HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment）

PATH 处理：系统 + 用户 + 进程，去重拼接。

示例（伪代码）：
```rust
pub fn build_system_env() -> Vec<(String, String)> {
    let mut env_map = HashMap::new();
    // 1) 读取系统 + 用户 env 并写入
    // 2) 读取进程 env 覆盖
    // 3) PATH 合并去重
    env_map.into_iter().collect()
}
```

- [ ] **Step 2: 在 commands 统一使用 build_system_env**
  
将 `enhanced_path()` 替换或改为使用 `build_system_env()`，确保所有命令执行时统一 `cmd.envs(build_system_env())`。

- [ ] **Step 3: 提交**
```bash
git add src-tauri/src/utils.rs src-tauri/src/commands/mod.rs
git commit -m "feat: inherit full system env for commands"
```

---

## Chunk 2: SkillHub 动态探测与返回路径

### Task 2: SkillHub 检测增强
**Files:**
- Modify: `src-tauri/src/commands/skills.rs`
- Modify: `src/lib/tauri-api.js`（若返回字段变化）
- Modify: `src/pages/skills.js`

- [ ] **Step 1: 更新 skills_skillhub_check**
  
流程：
1) `skillhub --version`  
2) 若失败，执行 `where skillhub`  
3) 取第一条路径，执行 `<path> --version`  
4) 返回 `{ installed: true, version, path }`

- [ ] **Step 2: 更新前端展示**
  
Skills 页面展示 path（若存在）：
- `#skillhub-status` 增加 “路径: xxx”
- 仍显示版本号

- [ ] **Step 3: 提交**
```bash
git add src-tauri/src/commands/skills.rs src/lib/tauri-api.js src/pages/skills.js
git commit -m "feat: detect skillhub by path and show location"
```

---

## Chunk 3: 手工验证与构建

### Task 3: 验证与构建
**Files:**
- 无

- [ ] **Step 1: 前端构建**
```bash
npm run build
```

- [ ] **Step 2: 手工验证要点**
- SkillHub CLI 安装后，未重启 ClawPanel 仍能识别 installed=true
- UI 能显示 version + path
- 晴辰助手执行命令时继承系统变量（如 PATH / HTTP_PROXY）

- [ ] **Step 3: 代码汇总与推送**
```bash
git push
```
