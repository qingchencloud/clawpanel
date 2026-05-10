import { navigate } from '../router.js'
import { t } from '../lib/i18n.js'
import { applyEngineSelection } from '../lib/engine-manager.js'
import { toast } from '../components/toast.js'

const OPTIONS = [
  {
    id: 'openclaw',
    key: 'Openclaw',
    icon: 'layers',
    activeEngineId: 'openclaw',
    enabledEngineIds: ['openclaw'],
    targetRoute: '/setup',
  },
  {
    id: 'hermes',
    key: 'Hermes',
    icon: 'bolt',
    activeEngineId: 'hermes',
    enabledEngineIds: ['hermes'],
    targetRoute: '/h/setup',
  },
  {
    id: 'both',
    key: 'Both',
    icon: 'spark',
    activeEngineId: 'openclaw',
    enabledEngineIds: ['openclaw', 'hermes'],
    engineMode: 'both',
    targetRoute: '/setup',
  },
  {
    id: 'later',
    key: 'Later',
    icon: 'clock',
    activeEngineId: 'openclaw',
    enabledEngineIds: [],
    deferred: true,
    targetRoute: '/engine-select',
  },
]

const ICONS = {
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page engine-select-page'
  page.innerHTML = `
    <section class="engine-select-hero">
      <div class="engine-select-kicker">${esc(t('engine.choiceKicker'))}</div>
      <h1>${esc(t('engine.choiceTitle'))}</h1>
      <p>${esc(t('engine.choiceSubtitle'))}</p>
    </section>
    <section class="engine-choice-grid">
      ${OPTIONS.map(renderOption).join('')}
    </section>
    <section class="engine-choice-note">
      <div class="engine-choice-note-title">${esc(t('engine.choiceNoteTitle'))}</div>
      <div>${esc(t('engine.choiceNoteDesc'))}</div>
    </section>
  `

  page.addEventListener('click', async (event) => {
    const card = event.target.closest('.engine-choice-card')
    if (!card) return
    const option = OPTIONS.find(item => item.id === card.dataset.choice)
    if (!option || card.classList.contains('loading')) return
    await chooseOption(page, card, option)
  })

  return page
}

function renderOption(option) {
  const badge = t(`engine.choice${option.key}Badge`)
  return `
    <button class="engine-choice-card" data-choice="${option.id}">
      <span class="engine-choice-icon">${ICONS[option.icon] || ''}</span>
      <span class="engine-choice-content">
        <span class="engine-choice-title-row">
          <span class="engine-choice-title">${esc(t(`engine.choice${option.key}Title`))}</span>
          ${badge && badge !== `engine.choice${option.key}Badge` ? `<span class="engine-choice-badge">${esc(badge)}</span>` : ''}
        </span>
        <span class="engine-choice-desc">${esc(t(`engine.choice${option.key}Desc`))}</span>
        <span class="engine-choice-meta">${esc(t(`engine.choice${option.key}Meta`))}</span>
      </span>
      <span class="engine-choice-arrow">→</span>
    </button>
  `
}

async function chooseOption(page, card, option) {
  setBusy(page, card, true)
  try {
    await applyEngineSelection({
      activeEngineId: option.activeEngineId,
      enabledEngineIds: option.enabledEngineIds,
      deferred: !!option.deferred,
      choice: option.id,
      engineMode: option.engineMode || '',
    })
    toast(t('engine.choiceSaved'), 'success')
    navigate(option.targetRoute)
  } catch (error) {
    console.error('[engine-select] choose failed:', error)
    toast(t('engine.choiceSaveFailed'), 'error')
    setBusy(page, card, false)
  }
}

function setBusy(page, activeCard, busy) {
  page.querySelectorAll('.engine-choice-card').forEach(card => {
    card.disabled = busy
    card.classList.toggle('loading', busy && card === activeCard)
  })
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
