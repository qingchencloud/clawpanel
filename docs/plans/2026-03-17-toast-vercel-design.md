# Toast Vercel 简约风格设计

## 目标
- 去掉液态玻璃/高斯模糊效果
- 使用 Vercel 简约风格：纯色卡片 + 细边框
- 日夜主题自动适配

## 现状
- `.toast` 使用 `backdrop-filter: blur(12px)`
- 背景使用 `--success-muted / --error-muted / --info-muted / --warning-muted`

## 方案
- 移除 `backdrop-filter`
- 背景统一使用 `var(--bg-primary)`
- 边框统一使用 `1px solid var(--border)`
- 文本颜色维持状态色（success/error/info/warning）

## 设计细节
- 选择器：`.toast`
- 状态色：保留 `.toast.success/.error/.info/.warning` 的文字颜色
- 背景色：`var(--bg-primary)`
- 边框：`1px solid var(--border)`

## 验收标准
- 日夜模式下 toast 不卡壳、无毛玻璃效果
- 视觉风格与 Vercel 简约风格一致
- 状态色可辨识
