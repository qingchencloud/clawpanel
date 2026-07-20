import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Hermes MiniMax providers use the regional Anthropic endpoints', async () => {
  const source = await readFile(new URL('../src-tauri/src/commands/hermes_providers.rs', import.meta.url), 'utf8')
  assert.match(source, /id: "minimax",[\s\S]*?base_url: "https:\/\/api\.minimax\.io\/anthropic"/)
  assert.match(source, /id: "minimax-cn",[\s\S]*?base_url: "https:\/\/api\.minimaxi\.com\/anthropic"/)
})
