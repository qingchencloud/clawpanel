# Gateway 一键补丁设计

日期：2026-03-16

## 目标
- 在设置页提供一键补丁入口，自动对全局 npm 安装的 OpenClaw 打补丁
- 支持检测版本、应用补丁、重打补丁、回滚

## 入口与交互
- 位置：设置页「公网访问」区域旁新增“Gateway 补丁”卡片
- 按钮：一键补丁、重打补丁、回滚
- 状态：展示检测到的 OpenClaw 版本、补丁状态、最近操作结果

## 实现流程
1. 定位全局 npm 根目录：`npm root -g`
2. 在 `node_modules` 内查找 `openclaw` 包
3. 自动识别目标文件（reply-*.js / gateway-cli-*.js）
4. 备份文件（.bak）
5. 应用补丁（sessionMessage 支持）
6. 写入 `clawpanel.json` 记录补丁版本与 OpenClaw 版本
7. 版本变更时提示并支持重打补丁
8. 失败自动回滚

## 数据与状态
- `clawpanel.json` 新增：
  - `gatewayPatch`: { version, patchedAt, openclawVersion, files: [] }

## 错误处理
- 未找到 npm 根目录或包：提示错误
- 文件名不匹配：提示错误并终止
- 打补丁失败：回滚并记录错误

## 测试要点
- 正常补丁流程
- 回滚流程
- 版本变化后重打补丁
- 错误路径处理
