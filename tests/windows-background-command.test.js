import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, 'src-tauri/src', p), 'utf8')
const utils = read('utils.rs')

function body(source, name) {
  const at = source.indexOf(`fn ${name}(`)
  assert.ok(at >= 0, `${name}必须存在`)
  // 工厂不含嵌套raw脚本；只提取固定下一项Rust函数前的文本。
  const next = source.indexOf('\npub fn ', at + 3)
  return source.slice(at, next < 0 ? source.length : next)
}

test('后台同步/异步工厂在Windows统一CREATE_NO_WINDOW，不改stdio/参数/env/权限', () => {
  for (const name of ['background_command', 'background_command_async']) {
    const fn = extract(utils, name)
    assert.match(fn, /creation_flags\(0x08000000\)/)
    assert.match(fn, /#\[cfg\(target_os = "windows"\)\]/)
    assert.doesNotMatch(fn, /\.(?:arg|args|env|envs|stdin|stdout|stderr|current_dir|kill_on_drop)\(/)
  }
})

for (const [file, names] of [
  ['commands/deepseek_harness.rs', ['find_command', 'process_alive', 'process_command_line', 'dsh_stop']],
  ['commands/opencode.rs', ['find_command', 'process_alive', 'process_command_line', 'prepare_staging', 'opencode_stop']],
  ['commands/pi.rs', ['spawn_bridge']],
  ['commands/hermes.rs', ['run_silent', 'run_at_path', 'run_venv_python_json']],
  ['utils.rs', ['openclaw_command', 'openclaw_command_async']],
]) test(`${file}五引擎后台构造接入共享工厂`, () => {
  const source = read(file)
  for (const name of names) {
    const at = source.indexOf(`fn ${name}(`)
    assert.ok(at >= 0, name)
    const nextFn = source.slice(at + 3).search(/\n(?:pub(?:\([^)]*\))? )?(?:async )?fn /)
    const fn = source.slice(at, nextFn < 0 ? undefined : at + 3 + nextFn)
    assert.match(fn, /(?:crate::utils::)?background_command(?:_async)?\(/, `${file}:${name}`)
  }
})

test('真正用户GUI重启保留，普通Gateway不创建新控制台且原预算/日志保留', () => {
  assert.match(read('commands/config.rs'), /std::process::Command::new\(&exe\)\s*\.spawn\(\)/)
  const service = read('commands/service.rs')
  assert.match(service, /fn gateway_runner_command\(/)
  const at = service.indexOf('pub async fn start_service_impl', service.indexOf('// ===== Windows'))
  const end = service.indexOf('pub async fn stop_service_impl', at)
  const start = service.slice(at, end)
  assert.doesNotMatch(start, /"start"|CREATE_NEW_CONSOLE|\.status\(\)/)
  assert.match(start, /gateway_runner_command\(/)
  assert.match(start, /\.spawn\(\)/)
  assert.match(start, /Duration::from_secs\(20\)/)
  assert.match(start, /Some\(current_pid\) != before_pid/)
  assert.match(start, /is_process_alive\(current_pid\)/)
  assert.match(start, /try_wait\(\)/)
  assert.match(start, /gateway\.err\.log/)
})

// 仅自有fixture：从实际Rust源提取纯工厂/runner构造，不运行Tauri/任何内核。
const { spawnSync } = await import('node:child_process')
const os = await import('node:os')
function extract(source, name) {
  const at = source.indexOf(`fn ${name}(`)
  assert.ok(at >= 0, name)
  const open = source.indexOf('{', at)
  let depth = 1, i = open + 1
  for (; i < source.length && depth; i++) { if (source[i] === '{') depth++; if (source[i] === '}') depth-- }
  assert.equal(depth, 0)
  const prefix = source.slice(Math.max(0, at - 4), at) === 'pub ' ? at - 4 : at
  return source.slice(prefix, i)
}

test('Windows实际自有Rust子进程+普通Gateway runner：无控制台/Unicode路径参数/非零日志/退出', { skip: process.platform !== 'win32' }, () => {
  assert.match(extract(utils, 'background_command'), /creation_flags\(0x08000000\)/, '不在红灯期创建可见子进程')
  const service = read('commands/service.rs')
  const pieces = ['quote_batch_path', 'gateway_terminal_command', 'write_gateway_terminal_runner', 'gateway_runner_command', 'gateway_start_log_tail'].map(n => extract(service, n)).join('\n')
  const evidence = process.env.WINDOWS_BACKGROUND_EVIDENCE ? path.resolve(process.env.WINDOWS_BACKGROUND_EVIDENCE) : fs.realpathSync.native(os.tmpdir())
  fs.mkdirSync(evidence, { recursive: true })
  const owned = fs.mkdtempSync(path.join(evidence, 'owned 控制台 空格 & fixture-'))
  const source = `use std::{fs,env};\nuse std::path::{Path,PathBuf};\nuse std::process::{Command as StdCommand,Stdio};\nuse std::os::windows::process::CommandExt;\nmod utils { use std::os::windows::process::CommandExt; ${extract(utils, 'background_command')} pub fn decode_text(bytes: &[u8]) -> String { String::from_utf8_lossy(bytes).into_owned() } }\n${pieces}\n` + String.raw`
#[link(name="kernel32")] extern "system" { fn GetConsoleWindow() -> *mut std::ffi::c_void; }
fn main() {
 let args:Vec<String>=env::args().collect();
 if args.get(1).is_some_and(|v| v=="--owned-child" || v=="gateway") {
  let window=unsafe{GetConsoleWindow()} as usize;
  println!("{{\"console_window\":{},\"env_ok\":{},\"arg_ok\":{}}}",window,env::var("FIXTURE_UNICODE").unwrap()=="后台中文🙂",args[1]=="gateway"||args.iter().any(|v|v=="--fixture-arg=含 空格&符号"));
  eprintln!("owned-stderr-中文");
  std::process::exit(env::var("FIXTURE_EXIT").unwrap().parse().unwrap());
 }
 let root=PathBuf::from(&args[1]);let exe=env::current_exe().unwrap();
 let stdio=utils::background_command(&exe).args(["--owned-child","--fixture-arg=含 空格&符号"]).env("FIXTURE_UNICODE","后台中文🙂").env("FIXTURE_EXIT","7").current_dir(&root).output().unwrap();
 assert_eq!(stdio.status.code(),Some(7));let stdout=String::from_utf8(stdio.stdout).unwrap();let stderr=String::from_utf8(stdio.stderr).unwrap();
 assert!(stdout.contains("\"console_window\":0"));assert!(stdout.contains("\"env_ok\":true"));assert!(stdout.contains("\"arg_ok\":true"));assert!(stderr.contains("owned-stderr-中文"));
 fs::copy(&exe,root.join("child.exe")).unwrap();
 for name in ["fake cli.cmd","fake cli.bat","openclaw.cmd"] {fs::write(root.join(name),"@echo off\r\n\"%~dp0child.exe\" %*\r\n").unwrap();}
 let variants=vec![("exe",exe.to_str().unwrap().to_string()),("cmd",root.join("fake cli.cmd").to_str().unwrap().to_string()),("bat",root.join("fake cli.bat").to_str().unwrap().to_string()),("fallback","openclaw".to_string())];
 let mut codes=Vec::new();
 for (kind,cli) in variants { for code in [0,7] {
  let home=root.join(format!("home 中文 {} {}",kind,code));fs::create_dir_all(home.join("logs")).unwrap();
  let runner=write_gateway_terminal_runner(&home,&cli).unwrap();
  assert!(!fs::read_to_string(&runner).unwrap().contains("1>>"));
  assert!(fs::read(&runner).unwrap().is_ascii());
  let mut cmd=gateway_runner_command(&runner,&cli);
  cmd.env("PATH",format!("{};{}",root.display(),env::var("PATH").unwrap()));
  let log_out=fs::OpenOptions::new().create(true).append(true).open(home.join("logs/gateway.log")).unwrap();
  let log_err=fs::OpenOptions::new().create(true).append(true).open(home.join("logs/gateway.err.log")).unwrap();
  let result=cmd.env("FIXTURE_UNICODE","后台中文🙂").env("FIXTURE_EXIT",code.to_string()).current_dir(&home).stdin(Stdio::null()).stdout(Stdio::from(log_out)).stderr(Stdio::from(log_err)).status().unwrap();
  assert_eq!(result.code(),Some(code));codes.push(code);
  let log=fs::read_to_string(home.join("logs/gateway.log")).unwrap();let err=fs::read_to_string(home.join("logs/gateway.err.log")).unwrap();
  assert!(log.contains("\"console_window\":0"),"{}",log);assert!(log.contains("\"env_ok\":true"));assert!(log.contains("\"arg_ok\":true"));assert!(err.contains("owned-stderr-中文"));
  if code!=0 {assert!(err.contains("Gateway exited with code 7"),"{}: {}",kind,err);}
 }}
 let tail_home=root.join("tail case");fs::create_dir_all(tail_home.join("logs")).unwrap();
 let mut tail_failures=Vec::new();
 for invalid in [false,true] {
  let mut data=vec![if invalid {255u8}else{65u8};2*1024*1024];data.extend_from_slice("\nOWN_TAIL_MARKER 中文\n".as_bytes());
  let file=tail_home.join("logs/gateway.err.log");fs::write(&file,&data).unwrap();
  let tail=gateway_start_log_tail(&tail_home);
  if !tail.contains("OWN_TAIL_MARKER 中文") {tail_failures.push(invalid);}
  assert!(tail.chars().count()<=4096);assert_eq!(fs::read(&file).unwrap(),data);
 }
 assert!(tail_failures.is_empty(),"large/invalidUTF8 tail lost (invalid modes): {:?}",tail_failures);
 println!("{{\"stdio_code\":7,\"console_window\":0,\"unicode_args_env\":true,\"runner_codes\":{:?},\"source_carve_only\":true,\"gui\":false,\"actualKernel\":false}}",codes);
}
`
  const rs = path.join(owned, 'probe.rs'), exe = path.join(owned, 'own 后台 fixture.exe')
  fs.writeFileSync(rs, source, { flag: 'wx' })
  const build = spawnSync('rustc', ['--edition=2021', rs, '-o', exe], { windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 })
  fs.writeFileSync(path.join(owned, 'compile.json'), JSON.stringify({ status: build.status, stderr: build.stderr, stdout: build.stdout, error: build.error?.message }, null, 2))
  assert.equal(build.status, 0, build.stderr)
  const run = spawnSync(exe, [owned], { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 })
  fs.writeFileSync(path.join(owned, 'result.json'), JSON.stringify({ status: run.status, stderr: run.stderr, stdout: run.stdout, error: run.error?.message, owned, retained: true }, null, 2))
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
  const report = JSON.parse(run.stdout.trim())
  assert.equal(report.console_window, 0); assert.deepEqual(report.runner_codes, [0, 7, 0, 7, 0, 7, 0, 7]); assert.equal(report.unicode_args_env, true)
})
