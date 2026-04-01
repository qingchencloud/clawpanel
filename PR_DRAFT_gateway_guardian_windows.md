# PR 标题
fix: 修复 Windows 下 Gateway 运行态误判导致重复拉起

## 问题描述
在 Windows 环境中，`check_service_status` 的判定依赖两步：
1. 端口连通（TCP）
2. 通过 `netstat + 进程命令行` 识别到合法 Gateway PID

当前逻辑在「端口已通，但命令行读取失败/受限」时会返回 `(false, None)`，被上层守护误判为 Gateway 未运行，进而触发自动拉起。结果是：
- 重复启动日志（`Hidden-start Gateway on Windows`）
- 端口冲突（18789 已占用）
- 会话链路抖动，表现为“任务做一下停一下”

## 修复方案
修改 `src-tauri/src/commands/service.rs` 中 Windows 平台 `check_service_status`：
- **端口可达即判定 `running=true`**
- PID 识别仅作为增强信息（可为空）
- 保留端口不通时清理 `LAST_KNOWN_GATEWAY_PID` 的逻辑

核心改动：
- 旧逻辑：端口通但 PID 识别失败 => `(false, None)`
- 新逻辑：端口通但 PID 识别失败 => `(true, None)`

## 影响范围
- 平台：Windows
- 模块：Gateway 服务状态检测 / 守护自动拉起
- 受影响功能：
  - Gateway 状态显示
  - 自动重启策略触发频率
  - 长任务连续执行稳定性

## 测试建议
1. **基础稳定性**
   - 启动 Gateway 后观察 `~/.openclaw/logs/gateway.log` 5 分钟
   - 不应再出现周期性重复 `Hidden-start Gateway on Windows`
2. **状态检测回归**
   - 服务页应稳定显示运行，不在运行/停止之间抖动
3. **任务连续执行**
   - 触发一个需要多轮执行的 Agent 任务，确认不会中途“停一下”
4. **手动停止验证**
   - 手动 stop 后应能正确识别为停止，不会误判运行

## 风险评估
当 18789 被“非 Gateway 进程”占用时，也会被识别为 running。该风险在现有启动流程中已有端口占用检查兜底（启动前拒绝占用端口），本次改动优先解决 Windows 下误判导致的重复拉起主问题。
