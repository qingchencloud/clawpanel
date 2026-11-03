# OpenCode 浏览器存储桥：实现前的失败场景

- opaque sandbox 下 localStorage 和 IndexedDB 可用；不增加 allow-same-origin 或公开监听端口。
- 真实 IndexedDB 持久化文本、Unicode、Blob；刷新 iframe/父页后恢复；双 store 事务原子提交、abort 不留下写入。
- get/getKey/getAll/openKeyCursor 与请求/事务完成事件顺序；回调内继续写入仍在同一事务。
- 仅当前 opaque iframe 可请求，其他 iframe、父页自发消息和错误 origin 不被信任；拒绝未知 DB/store/op 和原型键。
- localStorage 仅属于 OpenCode 的独立命名空间，不读取面板密码、会话、其他引擎存储；配额失败明确报错，不静默丢数据。
- 限制单值、事务数、消息数与事务时长；离开页面中止事务并释放监听；不因桥接制造无限 CPU 循环。
- 前后新旧真实 OpenCode UI 均须模型切换、聊天、刷新历史、草稿与停止/卸载验收。模拟浏览器桥测试不代替真实内核。
- 独立复查红灯：父源 WebStorage 总配额已满时，不让乐观镜像冒充已保存；回滚未持久化的偏好并在实际界面显示持续错误，IDB 草稿不被清除。
- 独立复查红灯：同一能力 URL 的 iframe reload 也必须更换文档 instance，立即中止旧事务；旧回复/旧请求不能混入新文档，不等待 5 秒 lease 才恢复。
- 顶层打开能力 HTML 同样由响应级 CSP sandbox 保持 opaque，不读取面板存储。
