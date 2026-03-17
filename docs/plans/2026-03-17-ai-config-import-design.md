# AI 配置从 openclaw 导入设计

日期: 2026-03-17

## 目标
在 AI 配置页提供“从 openclaw 导入”功能，导入模型参数 + API Key + Base URL。

## 方案
- 采用方案 A：手动按钮触发导入

## 设计细节
### 1) 导入入口
- AI 配置页顶部操作区新增按钮：`从 openclaw 导入`

### 2) 导入内容
- 读取 `openclaw.json`
- 提取字段：
  - model
  - temperature
  - top_p
  - api_key
  - base_url
- 写回当前 AI 配置表单并持久化

### 3) 反馈
- 成功：toast 提示“已导入”
- 失败：toast 提示读取失败或字段缺失

## 影响范围
- src/pages/models.js
- src/lib/tauri-api.js
- src-tauri/src/commands/config.rs

## 测试要点
- openclaw.json 有效 → 导入成功
- 字段缺失 → 失败提示
- 导入后配置可保存并生效
