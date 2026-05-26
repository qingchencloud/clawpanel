import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHermesTerminalConfigValues,
  mergeHermesTerminalConfig,
} from '../scripts/dev-api.js'

test('Hermes 终端执行配置读取会提供上游默认值', () => {
  const values = buildHermesTerminalConfigValues({})

  assert.deepEqual(values, {
    terminalBackend: 'local',
    terminalCwd: '.',
    terminalTimeout: 180,
    terminalLifetimeSeconds: 300,
    terminalShellInitFiles: '',
    terminalAutoSourceBashrc: true,
    terminalPersistentShell: true,
    terminalEnvPassthrough: '',
    terminalDockerMountCwdToWorkspace: false,
    terminalDockerRunAsHostUser: false,
    terminalContainerCpu: 1,
    terminalContainerMemory: 5120,
    terminalContainerDisk: 51200,
    terminalContainerPersistent: true,
    terminalDockerImage: '',
    terminalSingularityImage: '',
    terminalModalImage: '',
    terminalModalMode: 'auto',
    terminalVercelRuntime: 'node24',
    terminalDaytonaImage: '',
    terminalDockerForwardEnv: '',
    terminalDockerEnvJson: '{}',
    terminalDockerVolumes: '',
    terminalDockerExtraArgs: '',
    terminalSshHost: '',
    terminalSshUser: '',
    terminalSshPort: 22,
    terminalSshKey: '',
  })
})

test('Hermes 终端执行配置读取会回显 YAML 字段', () => {
  const values = buildHermesTerminalConfigValues({
    terminal: {
      backend: 'docker',
      cwd: '/workspace',
      timeout: 600,
      lifetime_seconds: 1800,
      shell_init_files: ['~/.zshrc', '${HOME}/.config/hermes/env.sh'],
      auto_source_bashrc: false,
      persistent_shell: false,
      env_passthrough: ['OPENROUTER_API_KEY', 'GITHUB_TOKEN'],
      docker_mount_cwd_to_workspace: true,
      docker_run_as_host_user: true,
      docker_image: 'nikolaik/python-nodejs:python3.11-nodejs20',
      docker_forward_env: ['GITHUB_TOKEN', 'NPM_TOKEN'],
      docker_env: {
        PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
        PIP_CACHE_DIR: '/workspace/.cache/pip',
      },
      docker_volumes: ['/data/projects:/workspace/projects', '/data/cache:/cache'],
      docker_extra_args: ['--network=host', '--add-host=host.docker.internal:host-gateway'],
      singularity_image: 'docker://nikolaik/python-nodejs:python3.11-nodejs20',
      modal_image: 'python:3.12',
      modal_mode: 'managed',
      vercel_runtime: 'python3.13',
      daytona_image: 'ubuntu:24.04',
      ssh_host: 'build.example.com',
      ssh_user: 'deploy',
      ssh_port: 2222,
      ssh_key: '~/.ssh/hermes_ed25519',
      container_cpu: 4,
      container_memory: 8192,
      container_disk: 102400,
      container_persistent: false,
    },
  })

  assert.equal(values.terminalBackend, 'docker')
  assert.equal(values.terminalCwd, '/workspace')
  assert.equal(values.terminalTimeout, 600)
  assert.equal(values.terminalLifetimeSeconds, 1800)
  assert.equal(values.terminalShellInitFiles, '~/.zshrc\n${HOME}/.config/hermes/env.sh')
  assert.equal(values.terminalAutoSourceBashrc, false)
  assert.equal(values.terminalPersistentShell, false)
  assert.equal(values.terminalEnvPassthrough, 'OPENROUTER_API_KEY\nGITHUB_TOKEN')
  assert.equal(values.terminalDockerMountCwdToWorkspace, true)
  assert.equal(values.terminalDockerRunAsHostUser, true)
  assert.equal(values.terminalDockerImage, 'nikolaik/python-nodejs:python3.11-nodejs20')
  assert.equal(values.terminalDockerForwardEnv, 'GITHUB_TOKEN\nNPM_TOKEN')
  assert.equal(values.terminalDockerEnvJson, '{\n  "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",\n  "PIP_CACHE_DIR": "/workspace/.cache/pip"\n}')
  assert.equal(values.terminalDockerVolumes, '/data/projects:/workspace/projects\n/data/cache:/cache')
  assert.equal(values.terminalDockerExtraArgs, '--network=host\n--add-host=host.docker.internal:host-gateway')
  assert.equal(values.terminalSingularityImage, 'docker://nikolaik/python-nodejs:python3.11-nodejs20')
  assert.equal(values.terminalModalImage, 'python:3.12')
  assert.equal(values.terminalModalMode, 'managed')
  assert.equal(values.terminalVercelRuntime, 'python3.13')
  assert.equal(values.terminalDaytonaImage, 'ubuntu:24.04')
  assert.equal(values.terminalSshHost, 'build.example.com')
  assert.equal(values.terminalSshUser, 'deploy')
  assert.equal(values.terminalSshPort, 2222)
  assert.equal(values.terminalSshKey, '~/.ssh/hermes_ed25519')
  assert.equal(values.terminalContainerCpu, 4)
  assert.equal(values.terminalContainerMemory, 8192)
  assert.equal(values.terminalContainerDisk, 102400)
  assert.equal(values.terminalContainerPersistent, false)
})

test('Hermes 终端执行配置保存会保留未知字段并写入上游结构', () => {
  const next = mergeHermesTerminalConfig({
    model: { provider: 'anthropic' },
    terminal: {
      backend: 'local',
      shell_init_files: ['~/.profile'],
      env_passthrough: ['OLD_TOKEN'],
      docker_image: 'custom/python-node',
      docker_forward_env: ['OLD_TOKEN'],
      docker_env: { OLD_FLAG: 'keep-old' },
      docker_volumes: ['/old:/old'],
      docker_extra_args: ['--old'],
      custom_flag: 'keep-terminal',
    },
    streaming: { enabled: true },
  }, {
    terminalBackend: 'docker',
    terminalCwd: '/workspace',
    terminalTimeout: '900',
    terminalLifetimeSeconds: '1200',
    terminalShellInitFiles: '~/.zshrc\n${HOME}/.config/hermes/env.sh\n~/.zshrc',
    terminalAutoSourceBashrc: false,
    terminalPersistentShell: false,
    terminalEnvPassthrough: 'OPENROUTER_API_KEY\nGITHUB_TOKEN\nOPENROUTER_API_KEY',
    terminalDockerMountCwdToWorkspace: true,
    terminalDockerRunAsHostUser: true,
    terminalDockerImage: 'nikolaik/python-nodejs:python3.12-nodejs22',
    terminalDockerForwardEnv: 'GITHUB_TOKEN\nNPM_TOKEN\nGITHUB_TOKEN',
    terminalDockerEnvJson: '{ "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "PIP_CACHE_DIR": "/workspace/.cache/pip" }',
    terminalDockerVolumes: '/data/projects:/workspace/projects\n/data/cache:/cache\n/data/projects:/workspace/projects',
    terminalDockerExtraArgs: '--network=host\n--add-host=host.docker.internal:host-gateway\n--network=host',
    terminalSingularityImage: 'docker://ubuntu:24.04',
    terminalModalImage: 'debian:bookworm',
    terminalModalMode: 'direct',
    terminalVercelRuntime: 'node22',
    terminalDaytonaImage: 'ubuntu:22.04',
    terminalSshHost: 'ssh.example.com',
    terminalSshUser: 'hermes',
    terminalSshPort: '2200',
    terminalSshKey: '~/.ssh/id_ed25519',
    terminalContainerCpu: '2',
    terminalContainerMemory: '6144',
    terminalContainerDisk: '20480',
    terminalContainerPersistent: false,
  })

  assert.deepEqual(next.model, { provider: 'anthropic' })
  assert.deepEqual(next.streaming, { enabled: true })
  assert.equal(next.terminal.backend, 'docker')
  assert.equal(next.terminal.cwd, '/workspace')
  assert.equal(next.terminal.timeout, 900)
  assert.equal(next.terminal.lifetime_seconds, 1200)
  assert.deepEqual(next.terminal.shell_init_files, ['~/.zshrc', '${HOME}/.config/hermes/env.sh'])
  assert.equal(next.terminal.auto_source_bashrc, false)
  assert.equal(next.terminal.persistent_shell, false)
  assert.deepEqual(next.terminal.env_passthrough, ['OPENROUTER_API_KEY', 'GITHUB_TOKEN'])
  assert.equal(next.terminal.docker_mount_cwd_to_workspace, true)
  assert.equal(next.terminal.docker_run_as_host_user, true)
  assert.equal(next.terminal.docker_image, 'nikolaik/python-nodejs:python3.12-nodejs22')
  assert.equal(next.terminal.singularity_image, 'docker://ubuntu:24.04')
  assert.equal(next.terminal.modal_image, 'debian:bookworm')
  assert.equal(next.terminal.modal_mode, 'direct')
  assert.equal(next.terminal.vercel_runtime, 'node22')
  assert.equal(next.terminal.daytona_image, 'ubuntu:22.04')
  assert.equal(next.terminal.ssh_host, 'ssh.example.com')
  assert.equal(next.terminal.ssh_user, 'hermes')
  assert.equal(next.terminal.ssh_port, 2200)
  assert.equal(next.terminal.ssh_key, '~/.ssh/id_ed25519')
  assert.equal(next.terminal.container_cpu, 2)
  assert.equal(next.terminal.container_memory, 6144)
  assert.equal(next.terminal.container_disk, 20480)
  assert.equal(next.terminal.container_persistent, false)
  assert.deepEqual(next.terminal.docker_forward_env, ['GITHUB_TOKEN', 'NPM_TOKEN'])
  assert.deepEqual(next.terminal.docker_env, {
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    PIP_CACHE_DIR: '/workspace/.cache/pip',
  })
  assert.deepEqual(next.terminal.docker_volumes, ['/data/projects:/workspace/projects', '/data/cache:/cache'])
  assert.deepEqual(next.terminal.docker_extra_args, ['--network=host', '--add-host=host.docker.internal:host-gateway'])
  assert.equal(next.terminal.custom_flag, 'keep-terminal')
})

test('Hermes 终端执行配置保存空 Docker 高级字段会删除对应字段', () => {
  const next = mergeHermesTerminalConfig({
    terminal: {
      docker_env: { OLD_FLAG: '1' },
      docker_volumes: ['/old:/old'],
      docker_extra_args: ['--old'],
      custom_flag: 'keep-terminal',
    },
  }, {
    terminalDockerEnvJson: '{}',
    terminalDockerVolumes: '  \n',
    terminalDockerExtraArgs: '  \n',
  })

  assert.equal(Object.hasOwn(next.terminal, 'docker_env'), false)
  assert.equal(Object.hasOwn(next.terminal, 'docker_volumes'), false)
  assert.equal(Object.hasOwn(next.terminal, 'docker_extra_args'), false)
  assert.equal(next.terminal.custom_flag, 'keep-terminal')
})

test('Hermes 终端执行配置保存空 Docker 环境变量转发会删除对应字段', () => {
  const next = mergeHermesTerminalConfig({
    terminal: {
      docker_forward_env: ['GITHUB_TOKEN'],
      custom_flag: 'keep-terminal',
    },
  }, {
    terminalDockerForwardEnv: '  \n',
  })

  assert.equal(Object.hasOwn(next.terminal, 'docker_forward_env'), false)
  assert.equal(next.terminal.custom_flag, 'keep-terminal')
})

test('Hermes 终端执行配置保存空 Shell 初始化文件会删除对应字段', () => {
  const next = mergeHermesTerminalConfig({
    terminal: {
      shell_init_files: ['~/.bashrc'],
      custom_flag: 'keep-terminal',
    },
  }, {
    terminalShellInitFiles: '  \n',
  })

  assert.equal(Object.hasOwn(next.terminal, 'shell_init_files'), false)
  assert.equal(next.terminal.custom_flag, 'keep-terminal')
})

test('Hermes 终端执行配置保存空环境变量透传会删除对应字段', () => {
  const next = mergeHermesTerminalConfig({
    terminal: {
      env_passthrough: ['OPENROUTER_API_KEY'],
      custom_flag: 'keep-terminal',
    },
  }, {
    terminalEnvPassthrough: '  \n',
  })

  assert.equal(Object.hasOwn(next.terminal, 'env_passthrough'), false)
  assert.equal(next.terminal.custom_flag, 'keep-terminal')
})

test('Hermes 终端执行配置保存空镜像会删除对应字段', () => {
  const next = mergeHermesTerminalConfig({
    terminal: {
      docker_image: 'old-docker',
      singularity_image: 'old-singularity',
      modal_image: 'old-modal',
      daytona_image: 'old-daytona',
      custom_flag: 'keep-terminal',
    },
  }, {
    terminalDockerImage: '',
    terminalSingularityImage: '  ',
    terminalModalImage: '',
    terminalDaytonaImage: ' ',
  })

  assert.equal(Object.hasOwn(next.terminal, 'docker_image'), false)
  assert.equal(Object.hasOwn(next.terminal, 'singularity_image'), false)
  assert.equal(Object.hasOwn(next.terminal, 'modal_image'), false)
  assert.equal(Object.hasOwn(next.terminal, 'daytona_image'), false)
  assert.equal(next.terminal.custom_flag, 'keep-terminal')
})

test('Hermes 终端执行配置保存空 SSH 字段会删除对应字段', () => {
  const next = mergeHermesTerminalConfig({
    terminal: {
      ssh_host: 'old-host',
      ssh_user: 'old-user',
      ssh_port: 2200,
      ssh_key: '~/.ssh/old',
      custom_flag: 'keep-terminal',
    },
  }, {
    terminalSshHost: '',
    terminalSshUser: '  ',
    terminalSshPort: '22',
    terminalSshKey: '',
  })

  assert.equal(Object.hasOwn(next.terminal, 'ssh_host'), false)
  assert.equal(Object.hasOwn(next.terminal, 'ssh_user'), false)
  assert.equal(Object.hasOwn(next.terminal, 'ssh_key'), false)
  assert.equal(next.terminal.ssh_port, 22)
  assert.equal(next.terminal.custom_flag, 'keep-terminal')
})

test('Hermes 终端执行配置保存会拒绝非法后端和越界值', () => {
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalBackend: 'unsafe' }),
    /terminal\.backend/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalModalMode: 'unsafe' }),
    /terminal\.modal_mode/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalVercelRuntime: 'ruby' }),
    /terminal\.vercel_runtime/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalTimeout: '0' }),
    /terminal\.timeout/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalLifetimeSeconds: '-1' }),
    /terminal\.lifetime_seconds/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalContainerCpu: '0' }),
    /terminal\.container_cpu/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalContainerMemory: '127' }),
    /terminal\.container_memory/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalSshPort: '0' }),
    /terminal\.ssh_port/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalSshPort: '65536' }),
    /terminal\.ssh_port/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalDockerForwardEnv: 'GOOD_TOKEN\nBAD TOKEN' }),
    /terminal\.docker_forward_env/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalShellInitFiles: 'valid.sh\nbad path.sh' }),
    /terminal\.shell_init_files/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalEnvPassthrough: 'GOOD_TOKEN\nBAD TOKEN' }),
    /terminal\.env_passthrough/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalDockerEnvJson: '[]' }),
    /terminal\.docker_env/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalDockerEnvJson: '{ "BAD KEY": "value" }' }),
    /terminal\.docker_env/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalDockerVolumes: '/host only' }),
    /terminal\.docker_volumes/,
  )
  assert.throws(
    () => mergeHermesTerminalConfig({}, { terminalDockerExtraArgs: 'bad arg' }),
    /terminal\.docker_extra_args/,
  )
})
