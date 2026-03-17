# AI 配置从 openclaw 导入 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AI 配置页增加“从 openclaw 导入”按钮，导入 model/temperature/top_p/api_key/base_url。

**Architecture:** 前端按钮触发调用 Tauri API 读取 openclaw.json 并写回表单配置，完成后持久化保存。

**Tech Stack:** Vanilla JS, Tauri

---

## Chunk 1: 后端读取 openclaw 配置

### Task 1: 新增导入命令
**Files:**
- Modify: `src-tauri/src/commands/config.rs`

- [ ] **Step 1: 新增 Tauri 命令**
  
新增 `import_openclaw_ai_config`：
- 读取 openclaw.json
- 提取字段：model / temperature / top_p / api_key / base_url
- 返回 JSON

- [ ] **Step 2: 注册命令**
  
在 `src-tauri/src/lib.rs` 注册命令。

- [ ] **Step 3: 提交**
```bash
git add src-tauri/src/commands/config.rs src-tauri/src/lib.rs
git commit -m "feat: add ai config import command"
```

---

## Chunk 2: 前端按钮与写回

### Task 2: AI 配置页导入
**Files:**
- Modify: `src/lib/tauri-api.js`
- Modify: `src/pages/models.js`

- [ ] **Step 1: 添加 API 封装**
  
tauri-api.js 增加 `importOpenclawAiConfig`.

- [ ] **Step 2: UI 按钮与写回逻辑**
  
models.js 增加按钮，点击后：
- 调用 API
- 写回表单
- 保存当前配置

- [ ] **Step 3: 提交**
```bash
git add src/lib/tauri-api.js src/pages/models.js
git commit -m "feat: import ai config from openclaw"
```

---

## Chunk 3: 构建与验证

### Task 3: 构建
**Files:** 无

- [ ] **Step 1: 构建**
```bash
npm run build
```

- [ ] **Step 2: 手工验证**
- openclaw.json 存在 → 导入成功  
- 字段缺失 → 提示失败  
- 保存后配置生效  

- [ ] **Step 3: 推送**
```bash
git push
```
