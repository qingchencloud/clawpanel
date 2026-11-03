import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const body = source.match(/function parseHermesDashboardStatus\(output\) \{[^]*?\n\}/)?.[0]
const parse = value => {
  assert.ok(body, '实际生产 parser 缺失')
  return new Function(`${body};return parseHermesDashboardStatus(arguments[0])`)(value)
}

test('原始官方未运行输出与退出0不等于 Dashboard 运行', () => {
  for (const s of ['No hermes dashboard or serve processes running.', 'No hermes dashboard processes running for this profile.', 'No dashboard processes running.', 'Dashboard is not running.', 'Dashboard stopped', 'Inactive', '0 hermes dashboard/serve process(es) running:']) assert.equal(parse(s), false, s)
})

test('只有明确状态为正，帮助文案、URL/端口及未知 JSON 不猜运行', () => {
  for (const s of ['1 hermes dashboard/serve process(es) running:\n PID 123 [dashboard]: hermes dashboard', 'Dashboard is running at http://127.0.0.1:9119', 'Listening on http://127.0.0.1:9119']) assert.equal(parse(s), true, s)
  for (const s of ['', 'Usage: hermes dashboard --status\nManage running dashboards http://docs.example', 'http://127.0.0.1:9119', 'Default port: 9119', '{"running":false}']) assert.equal(parse(s), null, s)
})

test('成功状态只调用一次；仅命令失败回退，未知成功留给 TCP', async () => {
  const method = source.match(/  (?:async )?_hermesDashboardCliStatus\(port\) \{[^]*?\n  \},/)?.[0]
  assert.ok(method)
  for (const first of [{ ok: true, stdout: 'No hermes dashboard or serve processes running.' }, { ok: true, stdout: 'Unknown output 9119' }, { ok: false }]) {
    const calls = []
    const obj = new Function('runHermesSilent', 'parseHermesDashboardStatus', `return {${method}}`)((program, args) => { calls.push([program, ...args]); return calls.length === 1 ? first : { ok: true, stdout: 'Dashboard running at http://127.0.0.1:9119' } }, parse)
    const result = await obj._hermesDashboardCliStatus(9119)
    assert.equal(calls.length, first.ok ? 1 : 2)
    if (first.ok && first.stdout.startsWith('No ')) assert.equal(result.running, false)
    else if (first.ok) assert.equal(result, null)
    else assert.equal(result.running, true)
  }
})

test('其他 HOME/端口的 CLI 正向输出不冒充本实例配置端口在线', async () => {
  const method = source.match(/  async hermes_dashboard_probe\(\) \{[^]*?\n  \},/)?.[0]
  assert.ok(method)
  for (const tcp of [false, true]) {
    const handlers = { _hermesDashboardPort: () => 9119, _hermesDashboardCliStatus: () => ({ running: true, output: '1 hermes dashboard/serve process(es) running:\n PID 123 --port 9120' }) }
    const obj = new Function('handlers', '_tcpProbe', `return {${method}}`)(handlers, async (host, port) => { assert.equal(host, '127.0.0.1'); assert.equal(port, 9119); return tcp })
    assert.equal((await obj.hermes_dashboard_probe()).running, tcp)
  }
})
