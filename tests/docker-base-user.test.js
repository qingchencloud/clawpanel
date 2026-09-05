import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
const dockerignore = fs.readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8')
const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')

test('Docker 生产镜像复用官方 node 用户，避免 Alpine UID/GID 1000 冲突', () => {
  assert.doesNotMatch(dockerfile, /addgroup\s+-g\s+1000/)
  assert.match(dockerfile, /--chown=node:node/)
  assert.match(dockerfile, /chown -R node:node \/app/)
})

test('Docker 构建上下文和生产镜像包含 Web API 运行时依赖', () => {
  assert.match(dockerignore, /!public\/\*\*/)
  assert.match(dockerfile, /COPY public\/ \.\/public\//)
  assert.match(dockerignore, /!scripts\/dev-api\.js/)
  assert.match(dockerignore, /!scripts\/media-background-queue\.js/)
  assert.match(dockerignore, /!scripts\/lib\/\*\*/)
  assert.match(dockerfile, /\/build\/src\/lib\/model-presets\.js/)
})

test('Docker 健康检查跟随 Web 自定义端口', () => {
  assert.match(dockerfile, /ENV PORT=1420/)
  assert.match(dockerfile, /localhost:\$\{PORT:-1420\}\/__api\/health/)
  assert.match(compose, /PORT=\$\{CLAWPANEL_PORT:-1420\}/)
  assert.match(compose, /localhost:\$\$\{PORT:-1420\}\/__api\/health/)
})
