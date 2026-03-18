# Toast 夜间样式与 Chat Model Select 设计

## 目标
- Toast 夜间模式可见性提升，风格参考 Vercel 简约风
- Chat 模型选择器不截断，宽度自适应内容

## Toast 夜间样式
### 现状
- Toast 使用统一背景与边框，夜间模式对比不足

### 方案（Vercel 简约风）
- 夜间模式下使用更深背景色与清晰边框
- 保留状态色文字

### 设计细节
- 选择器：`[data-theme="dark"] .toast`
- 背景：更深的卡片色（参考 Vercel 夜间卡片风格）
- 边框：`1px solid var(--border)` 保持一致性
- 阴影：沿用当前中等阴影

## Chat Model Select
### 现状
- `chat-model-select` 文字被截断

### 方案
- 宽度随内容自适应，不做截断

### 设计细节
- 选择器：`.chat-model-select` 或其输入容器
- 移除固定宽度/最大宽度
- 允许内容自然撑开

## 验收标准
- 夜间模式下 toast 清晰可见，风格简约
- chat-model-select 文字不再被截断
- 不影响其他布局与交互
