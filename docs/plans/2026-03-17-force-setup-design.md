# 强制初始化（forceSetup）设计

日期: 2026-03-17

## 目标
构建版首次启动可强制进入 /setup，不受已存在配置影响。

## 方案
- 采用方案 A：在 clawpanel.json 增加 forceSetup 字段

## 设计细节
### 1) 配置字段
- `clawpanel.json` 新增：`forceSetup: true/false`

### 2) 启动逻辑
- 启动时读取 panel config
- 若 `forceSetup === true`，即使 isOpenclawReady 为 true 也强制跳转 /setup

### 3) 初始化完成后
- setup 流程成功完成时写入 `forceSetup=false`

## 影响范围
- src/main.js
- src/lib/tauri-api.js
- src/pages/setup.js
- src-tauri/src/commands/config.rs

## 测试要点
- forceSetup=true 时进入 /setup
- 完成初始化后 forceSetup 自动清零
- forceSetup=false 时恢复原有判断逻辑
