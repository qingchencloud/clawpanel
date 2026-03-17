# Chat Markdown-it 样式解析设计

## 目标
- clawpanel chat 页面支持完整 Markdown 样式：加粗、斜体、删除线、行内代码、代码块、引用、列表、链接、下划线、剧透、@提及
- 解析行为与 GitHub 接近，安全渲染

## 方案
- 将 `src/lib/markdown.js` 切换为 `markdown-it` 作为渲染核心
- 使用插件机制实现：
  - underline：`__text__` 输出 `<u>`
  - spoiler：同时支持 `||spoiler||` 与 `>!spoiler!<`
  - mention：`@用户名` 输出 `<span class="msg-mention">@用户名</span>`
- 代码块高亮沿用现有 `highlightCode`
- 链接白名单 `http/https/mailto`，否则降级为 `#`
- 禁止任意 HTML 注入（html=false）

## 样式
- `.msg-mention` 高亮
- `.msg-spoiler` 遮罩，点击显示（`revealed` 类切换）

## 验收标准
- chat 页面渲染包含 E 方案的全部样式
- `|| ||` 与 `>! !<` 均可正确显示剧透
- @提及高亮，非链接
- 不引入 HTML 注入风险
