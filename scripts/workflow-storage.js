/**
 * Workflow storage module
 * JSON file-based storage for workflow templates and execution runs
 */
import { homedir } from 'os'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const WORKFLOWS_DIR = join(process.env.OPENCLAW_DIR || join(homedir(), '.openclaw'), 'workflows')
const TEMPLATES_FILE = join(WORKFLOWS_DIR, 'templates.json')
const RUNS_FILE = join(WORKFLOWS_DIR, 'runs.json')

function ensureDir() {
  if (!existsSync(WORKFLOWS_DIR)) {
    mkdirSync(WORKFLOWS_DIR, { recursive: true })
  }
}

function readJSON(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJSON(filePath, data) {
  ensureDir()
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

// === Template CRUD ===

export function loadTemplates() {
  return readJSON(TEMPLATES_FILE, [])
}

export function saveTemplate(template) {
  const templates = loadTemplates()
  if (template.id) {
    const idx = templates.findIndex(t => t.id === template.id)
    if (idx >= 0) {
      templates[idx] = { ...templates[idx], ...template, updatedAt: new Date().toISOString() }
    } else {
      templates.push(template)
    }
  } else {
    template.id = 'wf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    template.createdAt = new Date().toISOString()
    template.updatedAt = template.createdAt
    templates.push(template)
  }
  writeJSON(TEMPLATES_FILE, templates)
  return template
}

export function deleteTemplate(id) {
  const templates = loadTemplates()
  const filtered = templates.filter(t => t.id !== id)
  if (filtered.length === templates.length) return false
  writeJSON(TEMPLATES_FILE, filtered)
  return true
}

export function getTemplate(id) {
  return loadTemplates().find(t => t.id === id)
}

// === Workflow Runs ===

export function loadRuns(templateId) {
  const runs = readJSON(RUNS_FILE, [])
  return templateId ? runs.filter(r => r.templateId === templateId) : runs
}

export function saveRun(run) {
  const runs = readJSON(RUNS_FILE, [])
  if (run.id) {
    const idx = runs.findIndex(r => r.id === run.id)
    if (idx >= 0) {
      runs[idx] = { ...runs[idx], ...run }
    } else {
      runs.push(run)
    }
  } else {
    run.id = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    run.status = 'pending'
    run.createdAt = new Date().toISOString()
    runs.push(run)
  }
  writeJSON(RUNS_FILE, runs)
  return run
}

export function deleteRun(id) {
  const runs = readJSON(RUNS_FILE, [])
  const filtered = runs.filter(r => r.id !== id)
  if (filtered.length === runs.length) return false
  writeJSON(RUNS_FILE, filtered)
  return true
}

export function getRun(id) {
  return readJSON(RUNS_FILE, []).find(r => r.id === id)
}
