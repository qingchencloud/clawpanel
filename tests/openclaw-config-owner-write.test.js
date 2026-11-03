import test from 'node:test'
import assert from 'node:assert/strict'
import {stripUiFields} from '../scripts/dev-api.js'

test('合并后 sanitizer 清除 explicit 退役标记，完整保留独立 surface 和执行权限', () => {
  const config = {agents:{ownership:'explicit',defaults:{systemAgent:{agentId:'beta'},sessionStore:{agentId:'alpha'},authInheritance:{agentId:'alpha'}},entries:{alpha:{default:true,isDefault:true,id:'ui-alpha',tools:{deny:['exec']}},beta:{default:false,sandbox:{mode:'all'}}}},gateway:{auth:{mode:'token',token:'isolated-fixture-no-secret'}},bindings:[{agentId:'alpha',match:{channel:'telegram'}}]}
  const before = structuredClone(config)
  const actual = stripUiFields(config)
  assert.deepEqual(actual.agents.entries.alpha, {tools:{deny:['exec']}})
  assert.deepEqual(actual.agents.entries.beta, {sandbox:{mode:'all'}})
  assert.deepEqual(actual.agents.defaults, before.agents.defaults)
  assert.deepEqual(actual.gateway, before.gateway)
  assert.deepEqual(actual.bindings, before.bindings)
  assert.equal(actual.agents.ownership, 'explicit')
})

test('sanitizer 不偷偷迁移非explicit旧默认或旧list，也不创建注册表', () => {
  for (const config of [
    {agents:{entries:{alpha:{default:true,tools:{deny:['exec']}},beta:{}}}},
    {agents:{list:[{id:'alpha',default:true},{id:'beta'}]}},
    {agents:{defaults:{systemAgent:{agentId:'alpha'}}}},
  ]) assert.deepEqual(stripUiFields(structuredClone(config)), config)
})
