/**
 * 模型配置页面
 * 服务商管理 + 模型增删改查 + 主模型选择
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal, showConfirm } from '../components/modal.js'
import { icon, statusIcon } from '../lib/icons.js'
import { API_TYPES, PROVIDER_PRESETS, QTCOOL, MODEL_PRESETS, fetchQtcoolModels } from '../lib/model-presets.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">模型配置</h1>
      <p class="page-desc">添加 AI 模型服务商，配置可用模型</p>
    </div>
    <div class="config-actions">
      <button class="btn btn-primary btn-sm" id="btn-add-provider">+ 添加服务商</button>
      <button class="btn btn-secondary btn-sm" id="btn-undo" disabled>↩ 撤销</button>
    </div>
    <div class="form-hint" style="margin-bottom:var(--space-md)">
      服务商是模型的来源（如 OpenAI、DeepSeek 等）。每个服务商下可添加多个模型。
      标记为「主模型」的将优先使用，其余作为备选自动切换。配置修改后自动保存。
    </div>
    <div id="qtcool-promo" style="margin-bottom:var(--space-md);border-radius:var(--radius-lg);background:var(--bg-secondary);border:1px solid var(--border-primary);padding:14px 18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          ${icon('zap', 16)}
          <span style="font-weight:600;font-size:var(--font-size-sm)">晴辰云</span>
          <span style="font-size:10px;background:var(--primary);color:#fff;padding:1px 6px;border-radius:8px">推荐</span>
        </div>
        <div style="font-size:var(--font-size-xs);color:var(--text-secondary);line-height:1.5">
          面板用户免费使用部分模型，付费用户享全系列顶级模型支持，全部模型低至 2-3 折
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        <button class="btn btn-primary btn-sm" id="btn-qtcool-oneclick">${icon('plus', 14)} 获取模型列表</button>
        <a href="${QTCOOL.site}" target="_blank" class="btn btn-secondary btn-sm">${icon('external-link', 12)} 了解更多</a>
      </div>
    </div>
    <div id="default-model-bar"></div>
    <div style="margin-bottom:var(--space-md)">
      <input class="form-input" id="model-search" placeholder="搜索模型（按 ID 或名称过滤）" style="max-width:360px">
    </div>
    <div id="providers-list">
      <div class="config-section"><div class="stat-card loading-placeholder" style="height:120px"></div></div>
      <div class="config-section"><div class="stat-card loading-placeholder" style="height:120px"></div></div>
    </div>
  `

  const state = { config: null, search: '', undoStack: [] }
  // 非阻塞：先返回 DOM，后台加载数据
  loadConfig(page, state)
  bindTopActions(page, state)

  // 搜索框实时过滤
  page.querySelector('#model-search').oninput = (e) => {
    state.search = e.target.value.trim().toLowerCase()
    renderProviders(page, state)
  }

  return page
}

async function loadConfig(page, state) {
  const listEl = page.querySelector('#providers-list')
  try {
    state.config = await api.readOpenclawConfig()
    // 自动修复现有配置中的 baseUrl（如 Ollama 缺少 /v1），一次性迁移
    const before = JSON.stringify(state.config?.models?.providers || {})
    normalizeProviderUrls(state.config)
    const after = JSON.stringify(state.config?.models?.providers || {})
    if (before !== after) {
      console.log('[models] 自动修复了服务商 baseUrl，正在保存...')
      await api.writeOpenclawConfig(state.config)
      toast('已自动修复模型接口地址（如 Ollama /v1）', 'info')
    }
    renderDefaultBar(page, state)
    renderProviders(page, state)
  } catch (e) {
    listEl.innerHTML = '<div style="color:var(--error);padding:20px">加载配置失败: ' + e + '</div>'
    toast('加载配置失败: ' + e, 'error')
  }
}

function getCurrentPrimary(config) {
  return config?.agents?.defaults?.model?.primary || ''
}

function collectAllModels(config) {
  const result = []
  const providers = config?.models?.providers || {}
  for (const [pk, pv] of Object.entries(providers)) {
    for (const m of (pv.models || [])) {
      const id = typeof m === 'string' ? m : m.id
      if (id) result.push({ provider: pk, modelId: id, full: `${pk}/${id}` })
    }
  }
  return result
}

function getApiTypeLabel(apiType) {
  return API_TYPES.find(t => t.value === apiType)?.label || apiType || '未知'
}

// 渲染当前主模型状态栏
function renderDefaultBar(page, state) {
  const bar = page.querySelector('#default-model-bar')
  const primary = getCurrentPrimary(state.config)
  const allModels = collectAllModels(state.config)
  const fallbacks = allModels.filter(m => m.full !== primary).map(m => m.full)

  bar.innerHTML = `
    <div class="config-section" style="margin-bottom:var(--space-lg)">
      <div class="config-section-title">当前生效配置</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <span style="font-size:var(--font-size-sm);color:var(--text-tertiary)">主模型：</span>
          <span style="font-family:var(--font-mono);font-size:var(--font-size-sm);color:${primary ? 'var(--success)' : 'var(--error)'}">${primary || '未配置'}</span>
        </div>
        <div>
          <span style="font-size:var(--font-size-sm);color:var(--text-tertiary)">备选模型：</span>
          <span style="font-size:var(--font-size-sm);color:var(--text-secondary)">${fallbacks.length ? fallbacks.join(', ') : '无'}</span>
        </div>
      </div>
      <div class="form-hint" style="margin-top:6px">主模型不可用时，系统会自动切换到备选模型</div>
    </div>
  `
}

// 排序模型列表
function sortModels(models, sortBy) {
  if (!sortBy || sortBy === 'default') return models

  const sorted = [...models]
  switch (sortBy) {
    case 'name-asc':
      sorted.sort((a, b) => {
        const nameA = (a.name || a.id || '').toLowerCase()
        const nameB = (b.name || b.id || '').toLowerCase()
        return nameA.localeCompare(nameB)
      })
      break
    case 'name-desc':
      sorted.sort((a, b) => {
        const nameA = (a.name || a.id || '').toLowerCase()
        const nameB = (b.name || b.id || '').toLowerCase()
        return nameB.localeCompare(nameA)
      })
      break
    case 'latency-asc':
      sorted.sort((a, b) => {
        const latA = a.latency ?? Infinity
        const latB = b.latency ?? Infinity
        return latA - latB
      })
      break
    case 'latency-desc':
      sorted.sort((a, b) => {
        const latA = a.latency ?? -1
        const latB = b.latency ?? -1
        return latB - latA
      })
      break
    case 'context-asc':
      sorted.sort((a, b) => {
        const ctxA = a.contextWindow ?? 0
        const ctxB = b.contextWindow ?? 0
        return ctxA - ctxB
      })
      break
    case 'context-desc':
      sorted.sort((a, b) => {
        const ctxA = a.contextWindow ?? 0
        const ctxB = b.contextWindow ?? 0
        return ctxB - ctxA
      })
      break
  }
  return sorted
}

// 渲染服务商列表（渲染完后直接绑定事件）
function renderProviders(page, state) {
  const listEl = page.querySelector('#providers-list')
  const providers = state.config?.models?.providers || {}
  const keys = Object.keys(providers)
  const primary = getCurrentPrimary(state.config)
  const search = state.search || ''
  const sortBy = state.sortBy || 'default'

  if (!keys.length) {
    listEl.innerHTML = `
      <div style="color:var(--text-tertiary);padding:20px;text-align:center">
        暂无服务商，点击「+ 添加服务商」开始配置
      </div>`
    return
  }

  listEl.innerHTML = keys.map(key => {
    const p = providers[key]
    const models = p.models || []
    const filtered = search
      ? models.filter((m) => {
          const id = (typeof m === 'string' ? m : m.id).toLowerCase()
          const name = (m.name || '').toLowerCase()
          return id.includes(search) || name.includes(search)
        })
      : models
    const sorted = sortModels(filtered, sortBy)
    const hiddenCount = models.length - sorted.length
    return `
      <div class="config-section" data-provider="${key}">
        <div class="config-section-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>${key} <span style="font-size:var(--font-size-xs);color:var(--text-tertiary);font-weight:400">${getApiTypeLabel(p.api)} · ${models.length} 个模型</span></span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-secondary" data-action="edit-provider">编辑</button>
            <button class="btn btn-sm btn-secondary" data-action="add-model">+ 模型</button>
            <button class="btn btn-sm btn-secondary" data-action="fetch-models">获取列表</button>
            <button class="btn btn-sm btn-danger" data-action="delete-provider">删除</button>
          </div>
        </div>
        ${models.length >= 2 ? `
        <div style="display:flex;gap:6px;margin-bottom:var(--space-sm);align-items:center">
          <button class="btn btn-sm btn-secondary" data-action="batch-test">批量测试</button>
          <button class="btn btn-sm btn-secondary" data-action="select-all">全选</button>
          <button class="btn btn-sm btn-danger" data-action="batch-delete">批量删除</button>
          <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <span style="font-size:var(--font-size-xs);color:var(--text-tertiary)">排序:</span>
            <select class="form-input" data-action="sort-models" style="padding:4px 8px;font-size:var(--font-size-xs);width:auto">
              <option value="default">默认顺序 (拖拽调整)</option>
              <option value="name-asc">名称 A-Z (固化到底层)</option>
              <option value="name-desc">名称 Z-A (固化到底层)</option>
              <option value="latency-asc">延迟 低→高 (固化到底层)</option>
              <option value="latency-desc">延迟 高→低 (固化到底层)</option>
              <option value="context-asc">上下文 小→大 (固化到底层)</option>
              <option value="context-desc">上下文 大→小 (固化到底层)</option>
            </select>
            <button class="btn btn-sm btn-secondary" data-action="apply-sort" style="display:none">保存当前排序</button>
          </div>
        </div>` : ''}
        <div class="provider-models">
          ${renderModelCards(key, sorted, primary, search)}
          ${hiddenCount > 0 ? `<div style="font-size:var(--font-size-xs);color:var(--text-tertiary);padding:4px 0">已隐藏 ${hiddenCount} 个不匹配的模型</div>` : ''}
        </div>
      </div>
    `
  }).join('')

  // innerHTML 完成后，直接给每个按钮绑定 onclick
  bindProviderButtons(listEl, page, state)
}

// 渲染模型卡片（支持搜索高亮和批量选择 checkbox）
function renderModelCards(providerKey, models, primary, search) {
  if (!models.length) {
    return '<div style="color:var(--text-tertiary);font-size:var(--font-size-sm);padding:8px 0">暂无模型，点击「+ 模型」添加</div>'
  }
  return models.map((m) => {
    const id = typeof m === 'string' ? m : m.id
    const name = m.name || id
    const full = `${providerKey}/${id}`
    const isPrimary = full === primary
    const borderColor = isPrimary ? 'var(--success)' : 'var(--border-primary)'
    const bgColor = isPrimary ? 'var(--success-muted)' : 'var(--bg-tertiary)'
    const meta = []
    if (name !== id) meta.push(name)
    if (m.contextWindow) meta.push((m.contextWindow / 1000) + 'K 上下文')
    // 测试状态标签：成功显示耗时，失败显示不可用
    let latencyTag = ''
    if (m.testStatus === 'fail') {
      latencyTag = `<span style="font-size:var(--font-size-xs);padding:1px 6px;border-radius:var(--radius-sm);background:var(--error-muted, #fee2e2);color:var(--error)" title="${(m.testError || '').replace(/"/g, '&quot;')}">不可用</span>`
    } else if (m.latency != null) {
      const color = m.latency < 3000 ? 'success' : m.latency < 8000 ? 'warning' : 'error'
      const bg = color === 'success' ? 'var(--success-muted)' : color === 'warning' ? 'var(--warning-muted, #fef3c7)' : 'var(--error-muted, #fee2e2)'
      const fg = color === 'success' ? 'var(--success)' : color === 'warning' ? 'var(--warning, #d97706)' : 'var(--error)'
      latencyTag = `<span style="font-size:var(--font-size-xs);padding:1px 6px;border-radius:var(--radius-sm);background:${bg};color:${fg}">${(m.latency / 1000).toFixed(1)}s</span>`
    }
    const testTime = m.lastTestAt ? formatTestTime(m.lastTestAt) : ''
    if (testTime) meta.push(testTime)
    return `
      <div class="model-card" data-model-id="${id}" data-full="${full}"
           style="background:${bgColor};border:1px solid ${borderColor};padding:10px 14px;border-radius:var(--radius-md);margin-bottom:8px;display:flex;align-items:center;gap:10px">
        <span class="drag-handle" style="color:var(--text-tertiary);cursor:grab;user-select:none;font-size:16px;padding:4px;touch-action:none">⋮⋮</span>
        <input type="checkbox" class="model-checkbox" data-model-id="${id}" style="flex-shrink:0;cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-family:var(--font-mono);font-size:var(--font-size-sm)">${id}</span>
            ${isPrimary ? '<span style="font-size:var(--font-size-xs);background:var(--success);color:var(--text-inverse);padding:1px 6px;border-radius:var(--radius-sm)">主模型</span>' : ''}
            ${m.reasoning ? '<span style="font-size:var(--font-size-xs);background:var(--accent-muted);color:var(--accent);padding:1px 6px;border-radius:var(--radius-sm)">推理</span>' : ''}
            ${latencyTag}
          </div>
          <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-top:2px">${meta.join(' · ') || ''}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-sm btn-secondary" data-action="test-model">测试</button>
          ${!isPrimary ? '<button class="btn btn-sm btn-secondary" data-action="set-primary">设为主模型</button>' : ''}
          <button class="btn btn-sm btn-secondary" data-action="edit-model">编辑</button>
          <button class="btn btn-sm btn-danger" data-action="delete-model">删除</button>
        </div>
      </div>
    `
  }).join('')
}

// 格式化测试时间为相对时间
function formatTestTime(ts) {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚测试'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前测试`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前测试`
  return `${Math.floor(diff / 86400000)} 天前测试`
}

// 根据 model-id 找到原始 index
function findModelIdx(provider, modelId) {
  return (provider.models || []).findIndex(m => (typeof m === 'string' ? m : m.id) === modelId)
}

// ===== 自动保存 + 撤销机制 =====

// 保存快照到撤销栈（变更前调用）
function pushUndo(state) {
  state.undoStack.push(JSON.parse(JSON.stringify(state.config)))
  if (state.undoStack.length > 20) state.undoStack.shift()
}

// 撤销上一步
async function undo(page, state) {
  if (!state.undoStack.length) return
  state.config = state.undoStack.pop()
  renderProviders(page, state)
  renderDefaultBar(page, state)
  updateUndoBtn(page, state)
  await doAutoSave(state)
  toast('已撤销', 'info')
}

// 自动保存（防抖 300ms）
let _saveTimer = null
let _batchTestAbort = null // 批量测试终止控制器

export function cleanup() {
  clearTimeout(_saveTimer)
  _saveTimer = null
  if (_batchTestAbort) { _batchTestAbort.abort = true; _batchTestAbort = null }
}
function autoSave(state) {
  clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => doAutoSave(state), 300)
}

/** 保存前规范化所有服务商的 baseUrl，确保 Gateway 能正确调用 */
function normalizeProviderUrls(config) {
  const providers = config?.models?.providers
  if (!providers) return
  for (const [, p] of Object.entries(providers)) {
    if (!p.baseUrl) continue
    let url = p.baseUrl.replace(/\/+$/, '')
    // 去掉尾部的已知端点路径（用户可能粘贴了完整 URL）
    for (const suffix of ['/api/chat', '/api/generate', '/api/tags', '/api', '/chat/completions', '/completions', '/responses', '/messages', '/models']) {
      if (url.endsWith(suffix)) { url = url.slice(0, -suffix.length); break }
    }
    url = url.replace(/\/+$/, '')
    const apiType = (p.api || 'openai-completions').toLowerCase()
    if (apiType === 'anthropic-messages') {
      if (!url.endsWith('/v1')) url += '/v1'
    } else if (apiType !== 'google-gemini') {
      // Ollama 端口检测：11434 默认需要加 /v1
      if (/:11434$/.test(url) && !url.endsWith('/v1')) url += '/v1'
      // 不再强制追加 /v1，尊重用户填写的 URL（火山引擎等第三方用 /v3 等路径）
    }
    p.baseUrl = url
  }
}

// 仅保存配置，不重启 Gateway（用于测试结果等元数据持久化）
async function saveConfigOnly(state) {
  try {
    const primary = getCurrentPrimary(state.config)
    if (primary) applyDefaultModel(state)
    normalizeProviderUrls(state.config)
    await api.writeOpenclawConfig(state.config)
  } catch (e) {
    toast('保存失败: ' + e, 'error')
  }
}

async function doAutoSave(state) {
  try {
    const primary = getCurrentPrimary(state.config)
    if (primary) applyDefaultModel(state)
    normalizeProviderUrls(state.config)
    await api.writeOpenclawConfig(state.config)

    // 重启 Gateway 使配置生效（Gateway 不支持 SIGHUP 热重载）
    toast('配置已保存，正在重启 Gateway...', 'info')
    try {
      await api.restartGateway()
      toast('配置已生效，Gateway 已重启', 'success')
    } catch (e) {
      // 重启失败时提供手动重试按钮
      const restartBtn = document.createElement('button')
      restartBtn.className = 'btn btn-sm btn-primary'
      restartBtn.textContent = '重试'
      restartBtn.style.marginLeft = '8px'
      restartBtn.onclick = async () => {
        try {
          toast('正在重启 Gateway...', 'info')
          await api.restartGateway()
          toast('Gateway 重启成功', 'success')
        } catch (e2) {
          toast('重启失败: ' + e2.message, 'error')
        }
      }
      toast('配置已保存，但 Gateway 重启失败: ' + e.message, 'warning', { action: restartBtn })
    }
  } catch (e) {
    toast('自动保存失败: ' + e, 'error')
  }
}

// 更新撤销按钮状态
function updateUndoBtn(page, state) {
  const btn = page.querySelector('#btn-undo')
  if (!btn) return
  const n = state.undoStack.length
  btn.disabled = !n
  btn.textContent = n ? `↩ 撤销 (${n})` : '↩ 撤销'
}

// 渲染完成后，直接给每个 [data-action] 按钮绑定 onclick
function bindProviderButtons(listEl, page, state) {
  // 绑定排序下拉框
  listEl.querySelectorAll('select[data-action="sort-models"]').forEach(select => {
    select.onchange = (e) => {
      const val = e.target.value
      const section = select.closest('[data-provider]')
      if (!section) return
      const providerKey = section.dataset.provider
      const provider = state.config.models.providers[providerKey]

      if (val === 'default') {
        state.sortBy = 'default'
        renderProviders(page, state)
      } else {
        // 将排序固化到底层数据并保存
        pushUndo(state)
        provider.models = sortModels(provider.models, val)
        // 恢复下拉框显示 "默认顺序"，因为新顺序已经变成了默认顺序
        state.sortBy = 'default'
        renderProviders(page, state)
        autoSave(state)
        toast('排序已保存', 'success')
      }
    }
  })

  // 绑定拖拽排序（Pointer 事件实现，兼容 Tauri WebView2/WKWebView）
  listEl.querySelectorAll('.provider-models').forEach(container => {
    let dragged = null
    let placeholder = null
    let startY = 0

    // 仅从拖拽手柄启动
    container.addEventListener('pointerdown', e => {
      const handle = e.target.closest('.drag-handle')
      if (!handle) return
      const card = handle.closest('.model-card')
      if (!card) return

      e.preventDefault()
      dragged = card
      startY = e.clientY

      // 创建占位符
      placeholder = document.createElement('div')
      placeholder.style.cssText = `height:${card.offsetHeight}px;border:2px dashed var(--border);border-radius:var(--radius-md);margin-bottom:8px;background:var(--bg-secondary)`
      card.after(placeholder)

      // 浮动拖拽元素
      const rect = card.getBoundingClientRect()
      card.style.position = 'fixed'
      card.style.left = rect.left + 'px'
      card.style.top = rect.top + 'px'
      card.style.width = rect.width + 'px'
      card.style.zIndex = '9999'
      card.style.opacity = '0.85'
      card.style.boxShadow = '0 8px 24px rgba(0,0,0,0.2)'
      card.style.pointerEvents = 'none'
      card.setPointerCapture(e.pointerId)
    })

    container.addEventListener('pointermove', e => {
      if (!dragged || !placeholder) return
      e.preventDefault()

      // 移动浮动元素
      const dy = e.clientY - startY
      const origTop = parseFloat(dragged.style.top)
      dragged.style.top = (origTop + dy) + 'px'
      startY = e.clientY

      // 查找目标位置
      const siblings = [...container.querySelectorAll('.model-card:not([style*="position: fixed"])')].filter(c => c !== dragged)
      for (const sibling of siblings) {
        const rect = sibling.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (e.clientY < midY) {
          sibling.before(placeholder)
          return
        }
      }
      // 放到最后
      if (siblings.length) siblings[siblings.length - 1].after(placeholder)
    })

    container.addEventListener('pointerup', e => {
      if (!dragged || !placeholder) return

      // 恢复样式
      dragged.style.position = ''
      dragged.style.left = ''
      dragged.style.top = ''
      dragged.style.width = ''
      dragged.style.zIndex = ''
      dragged.style.opacity = ''
      dragged.style.boxShadow = ''
      dragged.style.pointerEvents = ''

      // 把卡片放到占位符位置
      placeholder.before(dragged)
      placeholder.remove()

      // 保存新顺序
      const section = container.closest('[data-provider]')
      if (section) {
        const providerKey = section.dataset.provider
        const provider = state.config.models.providers[providerKey]
        if (provider) {
          const newOrderIds = [...container.querySelectorAll('.model-card')].map(c => c.dataset.modelId)
          pushUndo(state)
          const oldModels = [...provider.models]
          provider.models = newOrderIds.map(id => oldModels.find(m => (typeof m === 'string' ? m : m.id) === id))
          autoSave(state)
        }
      }

      dragged = null
      placeholder = null
    })
  })

  // 绑定按钮
  listEl.querySelectorAll('button[data-action], input[data-action]').forEach(btn => {
    const action = btn.dataset.action
    const section = btn.closest('[data-provider]')
    if (!section) return
    const providerKey = section.dataset.provider
    const provider = state.config.models.providers[providerKey]
    if (!provider) return
    const card = btn.closest('.model-card')

        // checkbox 改变时不需要阻止冒泡，由 handleAction 内部处理
    if (btn.type === 'checkbox') {
      btn.onchange = (e) => {
        handleAction(action, btn, card, section, providerKey, provider, page, state)
      }
    } else {
      btn.onclick = (e) => {
        e.stopPropagation()
        handleAction(action, btn, card, section, providerKey, provider, page, state)
      }
    }
  })
}

// 统一处理按钮动作
async function handleAction(action, btn, card, section, providerKey, provider, page, state) {
  switch (action) {
    case 'edit-provider':
      editProvider(page, state, providerKey)
      break
    case 'add-model':
      addModel(page, state, providerKey)
      break
    case 'fetch-models':
      fetchRemoteModels(btn, page, state, providerKey)
      break
    case 'delete-provider': {
      const yes = await showConfirm(`确定删除「${providerKey}」及其所有模型？`)
      if (!yes) return
      pushUndo(state)
      delete state.config.models.providers[providerKey]
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast(`已删除 ${providerKey}`, 'info')
      break
    }
    case 'select-all':
      handleSelectAll(section)
      break
    case 'batch-delete':
      handleBatchDelete(section, page, state, providerKey)
      break
    case 'batch-test':
      handleBatchTest(section, state, providerKey)
      break
    case 'delete-model': {
      if (!card) return
      const modelId = card.dataset.modelId
      const yes = await showConfirm(`确定删除模型「${modelId}」？`)
      if (!yes) return
      pushUndo(state)
      const idx = findModelIdx(provider, modelId)
      if (idx >= 0) provider.models.splice(idx, 1)
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast(`已删除 ${modelId}`, 'info')
      break
    }
    case 'edit-model': {
      if (!card) return
      const idx = findModelIdx(provider, card.dataset.modelId)
      if (idx >= 0) editModel(page, state, providerKey, idx)
      break
    }
    case 'set-primary': {
      if (!card) return
      pushUndo(state)
      setPrimary(state, card.dataset.full)
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast('已设为主模型', 'success')
      break
    }
    case 'test-model': {
      if (!card) return
      const idx = findModelIdx(provider, card.dataset.modelId)
      if (idx >= 0) testModel(btn, state, providerKey, idx)
      break
    }
  }
}

// 设置主模型（仅修改 state，不写入文件）
function setPrimary(state, full) {
  if (!state.config.agents) state.config.agents = {}
  if (!state.config.agents.defaults) state.config.agents.defaults = {}
  if (!state.config.agents.defaults.model) state.config.agents.defaults.model = {}
  state.config.agents.defaults.model.primary = full
}

// 应用默认模型：primary + 其余自动成为备选
// 确保 primary 指向的模型仍然存在，不存在则自动切到第一个可用模型
function ensureValidPrimary(state) {
  const primary = getCurrentPrimary(state.config)
  const allModels = collectAllModels(state.config)
  if (allModels.length === 0) {
    // 所有模型都没了，清空 primary
    if (state.config.agents?.defaults?.model) {
      state.config.agents.defaults.model.primary = ''
    }
    return
  }
  const exists = allModels.some(m => m.full === primary)
  if (!exists) {
    // primary 指向已删除的模型，自动切到第一个
    const newPrimary = allModels[0].full
    setPrimary(state, newPrimary)
    toast(`主模型已自动切换为 ${newPrimary}`, 'info')
  }
}

function applyDefaultModel(state) {
  ensureValidPrimary(state)
  const primary = getCurrentPrimary(state.config)
  const allModels = collectAllModels(state.config)
  const fallbacks = allModels.filter(m => m.full !== primary).map(m => m.full)

  const defaults = state.config.agents.defaults
  defaults.model.primary = primary
  defaults.model.fallbacks = fallbacks

  const modelsMap = {}
  modelsMap[primary] = {}
  for (const fb of fallbacks) modelsMap[fb] = {}
  defaults.models = modelsMap

  // 同步到各 agent 的模型覆盖配置，避免 agent 级别的旧值覆盖全局默认
  const list = state.config.agents?.list
  if (Array.isArray(list)) {
    for (const agent of list) {
      if (agent.model && typeof agent.model === 'object' && agent.model.primary) {
        agent.model.primary = primary
      }
    }
  }
}

// 顶部按钮事件
function bindTopActions(page, state) {
  page.querySelector('#btn-add-provider').onclick = () => addProvider(page, state)
  page.querySelector('#btn-undo').onclick = () => undo(page, state)

  // 晴辰云：获取模型列表 → 弹窗让用户选择要添加的模型
  page.querySelector('#btn-qtcool-oneclick').onclick = async () => {
    if (!state.config) { toast('配置未加载完成，请稍候', 'warning'); return }

    const btn = page.querySelector('#btn-qtcool-oneclick')
    btn.textContent = '获取中...'
    btn.disabled = true

    const models = await fetchQtcoolModels()

    btn.innerHTML = `${icon('plus', 14)} 获取模型列表`
    btn.disabled = false

    if (!models.length) {
      toast('无法获取模型列表，请检查网络或稍后重试', 'error')
      return
    }

    // 已有的模型 ID
    const existingProvider = (state.config.models?.providers || {})[QTCOOL.providerKey]
    const existingIds = new Set((existingProvider?.models || []).map(m => typeof m === 'string' ? m : m.id))

    // 弹窗让用户勾选要添加的模型
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-height:80vh;overflow-y:auto">
        <div class="modal-title">选择要添加的模型</div>
        <div class="form-hint" style="margin-bottom:12px">从晴辰云获取到 ${models.length} 个可用模型，勾选需要的模型后点击添加。</div>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <button class="btn btn-sm btn-secondary" id="qtsel-all">全选</button>
          <button class="btn btn-sm btn-secondary" id="qtsel-none">全不选</button>
        </div>
        <div id="qtmodel-list" style="display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow-y:auto;padding-right:4px">
          ${models.map(m => {
            const already = existingIds.has(m.id)
            return `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-md);cursor:pointer;background:var(--bg-tertiary);opacity:${already ? '0.5' : '1'}">
              <input type="checkbox" value="${m.id}" ${already ? 'disabled title="已添加"' : 'checked'} style="accent-color:var(--primary)">
              <span style="font-size:var(--font-size-sm);flex:1">${m.id}</span>
              ${already ? '<span style="font-size:10px;color:var(--text-tertiary)">已有</span>' : ''}
            </label>`
          }).join('')}
        </div>
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn btn-primary" id="qtsel-confirm">${icon('plus', 14)} 添加选中模型</button>
          <button class="btn btn-secondary" id="qtsel-cancel">取消</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    overlay.querySelector('#qtsel-cancel').onclick = () => overlay.remove()
    overlay.querySelector('#qtsel-all').onclick = () => {
      overlay.querySelectorAll('#qtmodel-list input:not(:disabled)').forEach(cb => cb.checked = true)
    }
    overlay.querySelector('#qtsel-none').onclick = () => {
      overlay.querySelectorAll('#qtmodel-list input:not(:disabled)').forEach(cb => cb.checked = false)
    }
    overlay.querySelector('#qtsel-confirm').onclick = () => {
      const selected = [...overlay.querySelectorAll('#qtmodel-list input:checked:not(:disabled)')].map(cb => cb.value)
      overlay.remove()
      if (!selected.length) { toast('未选择任何模型', 'info'); return }

      pushUndo(state)
      if (!state.config.models) state.config.models = {}
      if (!state.config.models.providers) state.config.models.providers = {}

      const selectedModels = models.filter(m => selected.includes(m.id))
      if (existingProvider) {
        let added = 0
        for (const m of selectedModels) {
          if (!existingIds.has(m.id)) { existingProvider.models.push({ ...m }); added++ }
        }
        toast(added ? `已添加 ${added} 个模型` : '所选模型均已存在', added ? 'success' : 'info')
      } else {
        state.config.models.providers[QTCOOL.providerKey] = {
          baseUrl: QTCOOL.baseUrl,
          apiKey: QTCOOL.defaultKey,
          api: QTCOOL.api,
          models: selectedModels.map(m => ({ ...m })),
        }
        if (!getCurrentPrimary(state.config) && selectedModels.length) {
          if (!state.config.agents) state.config.agents = {}
          if (!state.config.agents.defaults) state.config.agents.defaults = {}
          if (!state.config.agents.defaults.model) state.config.agents.defaults.model = {}
          state.config.agents.defaults.model.primary = QTCOOL.providerKey + '/' + selectedModels[0].id
        }
        toast(`已添加晴辰云（${selectedModels.length} 个模型）`, 'success')
      }
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
    }
  }
}

// 添加服务商（带预设快捷选择）
function addProvider(page, state) {
  // 构建预设按钮 HTML
  const presetsHtml = PROVIDER_PRESETS.filter(p => !p.hidden).map(p =>
    `<button class="btn btn-sm btn-secondary preset-btn" data-preset="${p.key}" style="margin:0 6px 6px 0">${p.label}${p.badge ? ' <span style="font-size:9px;background:var(--accent);color:#fff;padding:1px 5px;border-radius:8px;margin-left:4px">' + p.badge + '</span>' : ''}</button>`
  ).join('')

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-height:85vh;overflow-y:auto">
      <div class="modal-title">添加服务商</div>
      <div class="form-group">
        <label class="form-label">快捷选择</label>
        <div style="display:flex;flex-wrap:wrap">${presetsHtml}</div>
        <div class="form-hint">选择常用服务商自动填充，或手动填写下方信息</div>
        <div id="preset-detail" style="display:none;margin-top:8px;padding:10px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md);font-size:var(--font-size-sm)"></div>
      </div>
      <div class="form-group">
        <label class="form-label">服务商名称</label>
        <input class="form-input" data-name="key" placeholder="如 openai, newapi">
        <div class="form-hint">自定义标识名，用于区分不同来源</div>
      </div>
      <div class="form-group">
        <label class="form-label">接口地址</label>
        <input class="form-input" data-name="baseUrl" placeholder="https://api.openai.com/v1">
        <div class="form-hint">模型服务的 API 地址，通常以 /v1 结尾；Ollama 可直接填 http://127.0.0.1:11434</div>
      </div>
      <div class="form-group">
        <label class="form-label">密钥 (API Key)</label>
        <input class="form-input" data-name="apiKey" placeholder="sk-...">
        <div class="form-hint">访问服务所需的密钥，留空表示无需认证</div>
      </div>
      <div class="form-group">
        <label class="form-label">接口类型</label>
        <select class="form-input" data-name="api">
          ${API_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
        </select>
        <div class="form-hint">大多数中转站和 Ollama 选「OpenAI 兼容」即可</div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
        <button class="btn btn-primary btn-sm" data-action="confirm">确定</button>
      </div>
    </div>
  `

  document.body.appendChild(overlay)

  // 预设按钮点击自动填充
  overlay.querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => {
      const preset = PROVIDER_PRESETS.find(p => p.key === btn.dataset.preset)
      if (!preset) return
      overlay.querySelector('[data-name="key"]').value = preset.key
      overlay.querySelector('[data-name="baseUrl"]').value = preset.baseUrl
      overlay.querySelector('[data-name="api"]').value = preset.api
      // 高亮选中的预设
      overlay.querySelectorAll('.preset-btn').forEach(b => b.style.opacity = '0.5')
      btn.style.opacity = '1'
      // 显示服务商详情（官网、描述）
      const detailEl = overlay.querySelector('#preset-detail')
      if (detailEl) {
        if (preset.desc || preset.site) {
          let html = preset.desc ? `<div style="color:var(--text-secondary);line-height:1.6">${preset.desc}</div>` : ''
          if (preset.site) html += `<a href="${preset.site}" target="_blank" style="color:var(--accent);text-decoration:none;font-size:12px;margin-top:4px;display:inline-block">→ 访问 ${preset.label}官网</a>`
          detailEl.innerHTML = html
          detailEl.style.display = 'block'
        } else {
          detailEl.style.display = 'none'
        }
      }
    }
  })

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()

  overlay.querySelector('[data-action="confirm"]').onclick = () => {
    const key = overlay.querySelector('[data-name="key"]').value.trim()
    const baseUrl = overlay.querySelector('[data-name="baseUrl"]').value.trim()
    const apiKey = overlay.querySelector('[data-name="apiKey"]').value.trim()
    const apiType = overlay.querySelector('[data-name="api"]').value
    if (!key) { toast('请填写服务商名称', 'warning'); return }
    pushUndo(state)
    if (!state.config.models) state.config.models = { mode: 'replace', providers: {} }
    if (!state.config.models.providers) state.config.models.providers = {}
    state.config.models.providers[key] = {
      baseUrl: baseUrl || '',
      apiKey: apiKey || '',
      api: apiType,
      models: [],
    }
    overlay.remove()
    renderProviders(page, state)
    updateUndoBtn(page, state)
    autoSave(state)
    toast(`已添加服务商: ${key}`, 'success')
  }

  overlay.querySelector('[data-name="key"]')?.focus()
}

// 编辑服务商
function editProvider(page, state, providerKey) {
  const p = state.config.models.providers[providerKey]
  showModal({
    title: `编辑服务商: ${providerKey}`,
    fields: [
      { name: 'baseUrl', label: '接口地址', value: p.baseUrl || '', hint: '模型服务的 API 地址，通常以 /v1 结尾；Ollama 可直接填 http://127.0.0.1:11434' },
      { name: 'apiKey', label: '密钥 (API Key)', value: p.apiKey || '', hint: '修改后自动保存生效' },
      {
        name: 'api', label: '接口类型', type: 'select', value: p.api || 'openai-completions',
        options: API_TYPES,
        hint: '大多数中转站和 Ollama 选「OpenAI 兼容」即可',
      },
    ],
    onConfirm: ({ baseUrl, apiKey, api: apiType }) => {
      pushUndo(state)
      p.baseUrl = baseUrl
      p.apiKey = apiKey
      p.api = apiType
      renderProviders(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast('服务商已更新', 'success')
    },
  })
}

// 添加模型（带预设快捷选择）
function addModel(page, state, providerKey) {
  const presets = MODEL_PRESETS[providerKey] || []
  const existingIds = (state.config.models.providers[providerKey].models || [])
    .map(m => typeof m === 'string' ? m : m.id)

  // 过滤掉已添加的模型
  const available = presets.filter(p => !existingIds.includes(p.id))

  const fields = [
    { name: 'id', label: '模型 ID', placeholder: '如 gpt-4o', hint: '必须与服务商支持的模型名一致' },
    { name: 'name', label: '显示名称（选填）', placeholder: '如 GPT-4o', hint: '方便识别的友好名称' },
    { name: 'contextWindow', label: '上下文长度（选填）', placeholder: '如 128000', hint: '模型支持的最大 Token 数' },
    { name: 'reasoning', label: '这是推理模型（如 o3、R1、QwQ 等）', type: 'checkbox', value: false, hint: '推理模型会使用特殊的调用方式' },
  ]

  if (available.length) {
    // 有预设可用，构建自定义弹窗
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'

    const presetBtns = available.map(p =>
      `<button class="btn btn-sm btn-secondary preset-btn" data-mid="${p.id}" style="margin:0 6px 6px 0">${p.name}${p.reasoning ? ' (推理)' : ''}</button>`
    ).join('')

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">添加模型到 ${providerKey}</div>
        <div class="form-group">
          <label class="form-label">快捷添加</label>
          <div style="display:flex;flex-wrap:wrap">${presetBtns}</div>
          <div class="form-hint">点击直接添加常用模型，或手动填写下方信息</div>
        </div>
        <hr style="border:none;border-top:1px solid var(--border-primary);margin:var(--space-sm) 0">
        <div class="form-group">
          <label class="form-label">手动添加</label>
        </div>
        ${buildFieldsHtml(fields)}
        <div class="modal-actions">
          <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
          <button class="btn btn-primary btn-sm" data-action="confirm">确定</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)
    bindModalEvents(overlay, fields, (vals) => {
      pushUndo(state)
      doAddModel(state, providerKey, vals)
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
    })

    // 预设按钮：点击直接添加
    overlay.querySelectorAll('.preset-btn').forEach(btn => {
      btn.onclick = () => {
        const preset = available.find(p => p.id === btn.dataset.mid)
        if (!preset) return
        pushUndo(state)
        const model = { ...preset, input: ['text', 'image'] }
        state.config.models.providers[providerKey].models.push(model)
        overlay.remove()
        renderProviders(page, state)
        renderDefaultBar(page, state)
        updateUndoBtn(page, state)
        autoSave(state)
        toast(`已添加模型: ${preset.name}`, 'success')
      }
    })
  } else {
    // 无预设，直接弹普通 modal
    showModal({
      title: `添加模型到 ${providerKey}`,
      fields,
      onConfirm: (vals) => {
        pushUndo(state)
        doAddModel(state, providerKey, vals)
        renderProviders(page, state)
        renderDefaultBar(page, state)
        updateUndoBtn(page, state)
        autoSave(state)
      },
    })
  }
}

// 构建表单字段 HTML（用于自定义弹窗）
function buildFieldsHtml(fields) {
  return fields.map(f => {
    if (f.type === 'checkbox') {
      return `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" data-name="${f.name}" ${f.value ? 'checked' : ''}>
            <span class="form-label" style="margin:0">${f.label}</span>
          </label>
          ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
        </div>`
    }
    return `
      <div class="form-group">
        <label class="form-label">${f.label}</label>
        <input class="form-input" data-name="${f.name}" value="${f.value || ''}" placeholder="${f.placeholder || ''}">
        ${f.hint ? `<div class="form-hint">${f.hint}</div>` : ''}
      </div>`
  }).join('')
}

// 绑定自定义弹窗的通用事件
function bindModalEvents(overlay, fields, onConfirm) {
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
  overlay.querySelector('[data-action="confirm"]').onclick = () => {
    const result = {}
    overlay.querySelectorAll('[data-name]').forEach(el => {
      result[el.dataset.name] = el.type === 'checkbox' ? el.checked : el.value
    })
    overlay.remove()
    onConfirm(result)
  }
}

// 实际添加模型到 state
function doAddModel(state, providerKey, vals) {
  if (!vals.id) { toast('请填写模型 ID', 'warning'); return }
  const model = {
    id: vals.id.trim(),
    name: vals.name?.trim() || vals.id.trim(),
    reasoning: !!vals.reasoning,
    input: ['text', 'image'],
  }
  if (vals.contextWindow) model.contextWindow = parseInt(vals.contextWindow) || 0
  state.config.models.providers[providerKey].models.push(model)
  toast(`已添加模型: ${model.name}`, 'success')
}

// 编辑模型
function editModel(page, state, providerKey, idx) {
  const m = state.config.models.providers[providerKey].models[idx]
  showModal({
    title: `编辑模型: ${m.id}`,
    fields: [
      { name: 'id', label: '模型 ID', value: m.id || '', hint: '必须与服务商支持的模型名一致' },
      { name: 'name', label: '显示名称', value: m.name || '', hint: '方便识别的友好名称' },
      { name: 'contextWindow', label: '上下文长度', value: String(m.contextWindow || ''), hint: '模型支持的最大 Token 数' },
      { name: 'reasoning', label: '这是推理模型', type: 'checkbox', value: !!m.reasoning, hint: '推理模型会使用特殊的调用方式' },
    ],
    onConfirm: (vals) => {
      if (!vals.id) return
      pushUndo(state)
      m.id = vals.id.trim()
      m.name = vals.name?.trim() || vals.id.trim()
      m.reasoning = !!vals.reasoning
      if (vals.contextWindow) m.contextWindow = parseInt(vals.contextWindow) || 0
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast('模型已更新', 'success')
    },
  })
}

// 全选/取消全选
function handleSelectAll(section) {
  const boxes = section.querySelectorAll('.model-checkbox')
  const allChecked = [...boxes].every(cb => cb.checked)
  boxes.forEach(cb => { cb.checked = !allChecked })
  // 更新批量删除按钮状态
  const batchDelBtn = section.querySelector('[data-action="batch-delete"]')
  if (batchDelBtn) batchDelBtn.disabled = allChecked
}

// 批量删除选中的模型
async function handleBatchDelete(section, page, state, providerKey) {
  const checked = [...section.querySelectorAll('.model-checkbox:checked')]
  if (!checked.length) { toast('请先勾选要删除的模型', 'warning'); return }
  const ids = checked.map(cb => cb.dataset.modelId)
  const yes = await showConfirm(`确定删除选中的 ${ids.length} 个模型？\n${ids.join(', ')}`)
  if (!yes) return
  pushUndo(state)
  const provider = state.config.models.providers[providerKey]
  provider.models = (provider.models || []).filter(m => {
    const mid = typeof m === 'string' ? m : m.id
    return !ids.includes(mid)
  })
  renderProviders(page, state)
  renderDefaultBar(page, state)
  updateUndoBtn(page, state)
  autoSave(state)
  toast(`已删除 ${ids.length} 个模型`, 'info')
}

// 批量测试：勾选的模型，没勾选则测试全部（记录耗时和状态）
async function handleBatchTest(section, state, providerKey) {
  // 如果正在测试，点击则终止
  if (_batchTestAbort) {
    _batchTestAbort.abort = true
    toast('正在终止批量测试...', 'warning')
    return
  }

  const provider = state.config.models.providers[providerKey]
  const checked = [...section.querySelectorAll('.model-checkbox:checked')]
  const ids = checked.length
    ? checked.map(cb => cb.dataset.modelId)
    : (provider.models || []).map(m => typeof m === 'string' ? m : m.id)

  if (!ids.length) { toast('没有可测试的模型', 'warning'); return }

  const batchBtn = section.querySelector('[data-action="batch-test"]')
  const ctrl = { abort: false }
  _batchTestAbort = ctrl
  if (batchBtn) {
    batchBtn.textContent = '终止测试'
    batchBtn.classList.remove('btn-secondary')
    batchBtn.classList.add('btn-danger')
  }

  const page = section.closest('.page')
  let ok = 0, fail = 0
  for (const modelId of ids) {
    if (ctrl.abort) break

    const model = (provider.models || []).find(m => (typeof m === 'string' ? m : m.id) === modelId)
    // 标记当前正在测试的卡片
    const card = section.querySelector(`.model-card[data-model-id="${modelId}"]`)
    if (card) card.style.outline = '2px solid var(--accent)'

    const start = Date.now()
    try {
      await api.testModel(provider.baseUrl, provider.apiKey || '', modelId, provider.api || 'openai-completions')
      const elapsed = Date.now() - start
      if (model && typeof model === 'object') {
        model.latency = elapsed
        model.lastTestAt = Date.now()
        model.testStatus = 'ok'
        delete model.testError
      }
      ok++
    } catch (e) {
      const elapsed = Date.now() - start
      if (model && typeof model === 'object') {
        model.latency = null
        model.lastTestAt = Date.now()
        model.testStatus = 'fail'
        model.testError = String(e).slice(0, 100)
      }
      fail++
    }

    // 每测完一个实时刷新卡片
    if (page) {
      renderProviders(page, state)
      renderDefaultBar(page, state)
    }
    // 进度 toast
    const status = model?.testStatus === 'ok' ? '\u2713' : '\u2717'
    const latStr = model?.latency != null ? ` ${(model.latency / 1000).toFixed(1)}s` : ''
    toast(`${status} ${modelId}${latStr} (${ok + fail}/${ids.length})`, model?.testStatus === 'ok' ? 'success' : 'error')
  }

  // 恢复按钮
  _batchTestAbort = null
  // 重新查找按钮（renderProviders 后 DOM 已更新）
  const newSection = page?.querySelector(`[data-provider="${providerKey}"]`)
  const newBtn = newSection?.querySelector('[data-action="batch-test"]')
  if (newBtn) {
    newBtn.textContent = '批量测试'
    newBtn.classList.remove('btn-danger')
    newBtn.classList.add('btn-secondary')
  }

  const aborted = ctrl.abort
  autoSave(state)
  if (aborted) {
    toast(`批量测试已终止：${ok} 成功，${fail} 失败，${ids.length - ok - fail} 跳过`, 'warning')
  } else {
    toast(`批量测试完成：${ok} 成功，${fail} 失败`, ok === ids.length ? 'success' : 'warning')
  }
}

// 从服务商远程获取模型列表
async function fetchRemoteModels(btn, page, state, providerKey) {
  const provider = state.config.models.providers[providerKey]
  btn.disabled = true
  btn.textContent = '获取中...'

  try {
    const remoteIds = await api.listRemoteModels(provider.baseUrl, provider.apiKey || '', provider.api || 'openai-completions')
    btn.disabled = false
    btn.textContent = '获取列表'

    // 标记已添加的模型
    const existingIds = (provider.models || []).map(m => typeof m === 'string' ? m : m.id)

    // 弹窗展示可选模型列表
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" style="max-height:80vh;display:flex;flex-direction:column">
        <div class="modal-title">远程模型列表 — ${providerKey} (${remoteIds.length} 个)</div>
        <div style="margin-bottom:var(--space-sm);display:flex;gap:8px;align-items:center">
          <input class="form-input" id="remote-filter" placeholder="搜索模型..." style="flex:1">
          <button class="btn btn-sm btn-secondary" id="remote-toggle-all">全选</button>
        </div>
        <div id="remote-model-list" style="flex:1;overflow-y:auto;max-height:50vh"></div>
        <div class="modal-actions" style="margin-top:var(--space-sm)">
          <span id="remote-selected-count" style="font-size:var(--font-size-xs);color:var(--text-tertiary);flex:1">已选 0 个</span>
          <button class="btn btn-secondary btn-sm" data-action="cancel">取消</button>
          <button class="btn btn-primary btn-sm" data-action="confirm">添加选中</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const listEl = overlay.querySelector('#remote-model-list')
    const filterInput = overlay.querySelector('#remote-filter')
    const countEl = overlay.querySelector('#remote-selected-count')

    function renderRemoteList(filter) {
      const filtered = filter
        ? remoteIds.filter(id => id.toLowerCase().includes(filter.toLowerCase()))
        : remoteIds
      listEl.innerHTML = filtered.map(id => {
        const exists = existingIds.includes(id)
        return `
          <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-sm);cursor:pointer;${exists ? 'opacity:0.5' : ''}">
            <input type="checkbox" class="remote-cb" data-id="${id}" ${exists ? 'disabled' : ''}>
            <span style="font-family:var(--font-mono);font-size:var(--font-size-sm)">${id}</span>
            ${exists ? '<span style="font-size:var(--font-size-xs);color:var(--text-tertiary)">(已添加)</span>' : ''}
          </label>`
      }).join('')
      updateCount()
    }

    function updateCount() {
      const n = listEl.querySelectorAll('.remote-cb:checked').length
      countEl.textContent = `已选 ${n} 个`
    }

    renderRemoteList('')
    filterInput.oninput = () => renderRemoteList(filterInput.value.trim())
    listEl.addEventListener('change', updateCount)

    overlay.querySelector('#remote-toggle-all').onclick = () => {
      const cbs = listEl.querySelectorAll('.remote-cb:not(:disabled)')
      const allChecked = [...cbs].every(cb => cb.checked)
      cbs.forEach(cb => { cb.checked = !allChecked })
      updateCount()
    }

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
    overlay.querySelector('[data-action="cancel"]').onclick = () => overlay.remove()
    overlay.querySelector('[data-action="confirm"]').onclick = () => {
      const selected = [...listEl.querySelectorAll('.remote-cb:checked')].map(cb => cb.dataset.id)
      if (!selected.length) { toast('请至少选择一个模型', 'warning'); return }
      pushUndo(state)
      for (const id of selected) {
        provider.models.push({ id, input: ['text', 'image'] })
      }
      overlay.remove()
      renderProviders(page, state)
      renderDefaultBar(page, state)
      updateUndoBtn(page, state)
      autoSave(state)
      toast(`已添加 ${selected.length} 个模型`, 'success')
    }

    filterInput.focus()
  } catch (e) {
    btn.disabled = false
    btn.textContent = '获取列表'
    toast(`获取模型列表失败: ${e}`, 'error')
  }
}

// 测试模型连通性（记录耗时和状态）
async function testModel(btn, state, providerKey, idx) {
  const provider = state.config.models.providers[providerKey]
  const model = provider.models[idx]
  const modelId = typeof model === 'string' ? model : model.id

  btn.disabled = true
  const origText = btn.textContent
  btn.textContent = '测试中...'

  const start = Date.now()
  try {
    const reply = await api.testModel(provider.baseUrl, provider.apiKey || '', modelId, provider.api || 'openai-completions')
    const elapsed = Date.now() - start
    // 记录到模型对象
    if (typeof model === 'object') {
      model.latency = elapsed
      model.lastTestAt = Date.now()
      model.testStatus = 'ok'
      delete model.testError
    }
    toast(`${modelId} 连通正常 (${(elapsed / 1000).toFixed(1)}s): "${reply.slice(0, 50)}"`, 'success')
  } catch (e) {
    const elapsed = Date.now() - start
    if (typeof model === 'object') {
      model.latency = null
      model.lastTestAt = Date.now()
      model.testStatus = 'fail'
      model.testError = String(e).slice(0, 100)
    }
    toast(`${modelId} 不可用 (${(elapsed / 1000).toFixed(1)}s): ${e}`, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = origText
    // 刷新卡片显示最新状态
    const page = btn.closest('.page')
    if (page) {
      renderProviders(page, state)
      renderDefaultBar(page, state)
    }
    // 持久化测试结果（仅保存，不重启 Gateway）
    saveConfigOnly(state)
  }
}
