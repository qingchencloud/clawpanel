# Hosted Agent Enhancements Design

日期: 2026-03-18

## 目标与范围
- system 提示词：支持全局默认 + 会话覆盖
- 暂停保留历史与计数；停止清空历史与计数
- 指引角色：轻度建议（不强制模板）
- 上下文压缩：按 token 上限裁剪最旧消息
- 前端提示：暂停与停止行为清晰提示用户

## 数据结构
- 全局默认：panel.hostedAgent.default.systemPrompt
- 会话覆盖：hostedSessionConfig.systemPrompt
- 运行状态新增：contextTokens、lastTrimAt

## 行为流程
1) 构建托管上下文
- systemPrompt = sessionPrompt || globalPrompt || ''
- buildHostedMessages 时插入 system 消息

2) 暂停/停止
- 暂停：status=PAUSED，保留 history 与 stepCount，前端提示
- 停止：清空 history、stepCount、lastError，status=IDLE，前端提示

3) 上下文压缩
- 估算 token（简单字数/4 近似）
- 超过阈值时裁剪最旧非 system 消息
- 记录 lastTrimAt 与 contextTokens

4) 指引角色输出
- 输出保持建议式语气，不强制模板
- 仍保留基本前缀与状态摘要

## 风险与回归
- token 估算误差导致裁剪偏差
- 暂停/停止提示需与状态一致

## 验证
- 运行托管 Agent：systemPrompt 生效
- 暂停后恢复：历史仍在
- 停止后：历史清空
- 长上下文自动裁剪
