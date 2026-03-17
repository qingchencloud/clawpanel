# Cloudflared 公网访问与 OpenClaw 兼容导入设计

日期：2026-03-16

## 目标
- 在 ClawPanel 设置页新增“公网访问（Cloudflared）”Tab
- 支持快速隧道与命名隧道，进入页面后由用户选择
- 一键认证登录（允许弹出浏览器完成 cloudflared login）
- 默认暴露 OpenClaw Gateway（18789）
- 读取用户已安装 OpenClaw 的 `C:\Users\<user>\.openclaw\openclaw.json`，只读导入并做兼容或升级

## 约束与偏好
- 不要求用户输入隧道 Token
- cloudflared.exe 优先 PATH 检测，其次 `~/.openclaw/bin`，不存在则复用 label-printer 的加速域名检测与下载逻辑
- 不覆盖原始 openclaw.json，仅生成 ClawPanel 本地配置副本

## 方案对比
### 方案 A（推荐）
- 内置 Cloudflared 管理器 + 一键登录 + 快速/命名双模式
- 优点：体验一致，符合“一键认证登录”
- 风险：需要完整接入本地进程管理与状态监控

### 方案 B
- 仅提供外部 cloudflared 路径配置
- 优点：实现快
- 缺点：不满足“一键认证登录”

### 方案 C
- A 为主，保留手动路径作为兜底
- 优点：兼容性强
- 代价：UI 复杂度增加

推荐：方案 A，保留手动路径兜底入口

## 设计 Section 1：架构与入口
- 入口：设置页新增“公网访问（Cloudflared）”Tab
- 核心模块：
  1) Cloudflared 管理器（检测、下载、启动、停止、状态）
  2) 隧道管理（快速隧道/命名隧道）
  3) OpenClaw 配置导入（读取并兼容升级）
- 数据流：UI → IPC → cloudflared → 状态回传 → UI

## 设计 Section 2：获取与一键认证
- 检测顺序：PATH → `~/.openclaw/bin/cloudflared.exe` → 下载
- 下载策略：加速域名检测失败则回退官方下载
- 一键认证：执行 `cloudflared tunnel login`，浏览器授权完成后保存凭据
- 失败提示与重试

## 设计 Section 3：隧道类型与运行流程
- 快速隧道：临时访问
- 命名隧道：固定域名与服务
- 流程：选择类型 → 选择服务（默认 18789）→ 启动 → 展示地址/状态
- 错误处理：启动失败、登录失效、端口占用

## 设计 Section 4：OpenClaw 配置导入
- 默认读取：`C:\Users\<user>\.openclaw\openclaw.json`
- 兼容升级：缺失字段补全、旧字段映射
- 只读导入，不覆盖原配置
- 失败回退为只读展示
