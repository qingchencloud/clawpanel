/// 扩展工具命令（cftunnel + ClawApp）
use serde_json::{json, Value};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;

/// 按第一个冒号（半角 ':' 或全角 '：'）分割，返回冒号之后的内容（trim 后）
fn split_after_colon(s: &str) -> &str {
    // 半角冒号是 1 字节，全角冒号是 3 字节（UTF-8: \xef\xbc\x9a）
    if let Some(pos) = s.find(':') {
        return s[pos + 1..].trim();
    }
    if let Some(pos) = s.find('：') {
        return s[pos + '：'.len_utf8()..].trim();
    }
    ""
}

/// 解析 cftunnel status 输出
fn parse_cftunnel_status(output: &str) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    for line in output.lines() {
        let line = line.trim();
        if line.starts_with("隧道:") || line.starts_with("隧道：") {
            let rest = split_after_colon(line);
            let name = rest.split('(').next().unwrap_or(rest).trim();
            map.insert("tunnel_name".into(), Value::String(name.to_string()));
        } else if line.starts_with("状态:") || line.starts_with("状态：") {
            let rest = split_after_colon(line);
            let running = rest.contains("运行中");
            map.insert("running".into(), Value::Bool(running));
            // 匹配英文和全角 'PID:' / 'PID：'
            let pid_rest = rest
                .split("PID:")
                .nth(1)
                .or_else(|| rest.split("PID：").nth(1));
            if let Some(pid_str) = pid_rest {
                let pid = pid_str.trim().trim_end_matches(')').trim();
                if let Ok(p) = pid.parse::<u64>() {
                    map.insert("pid".into(), Value::Number(p.into()));
                }
            }
        }
    }
    map
}

/// 解析 cftunnel list 输出为路由数组
fn parse_cftunnel_routes(output: &str) -> Vec<Value> {
    let mut routes = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("名称") || line.starts_with("---") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            let mut obj = serde_json::Map::new();
            obj.insert("name".into(), Value::String(parts[0].to_string()));
            obj.insert("domain".into(), Value::String(parts[1].to_string()));
            obj.insert("service".into(), Value::String(parts[2].to_string()));
            routes.push(Value::Object(obj));
        }
    }
    routes
}

/// 查找 cftunnel 可执行文件路径
fn cftunnel_bin() -> String {
    let home = dirs::home_dir().unwrap_or_default();

    #[cfg(target_os = "windows")]
    {
        // Windows: 查找 cftunnel.exe
        let candidates = [
            home.join("bin").join("cftunnel.exe"),
            home.join(".cftunnel").join("cftunnel.exe"),
            home.join("AppData")
                .join("Local")
                .join("cftunnel")
                .join("cftunnel.exe"),
        ];
        for path in &candidates {
            if path.exists() {
                return path.to_string_lossy().to_string();
            }
        }
        "cftunnel.exe".to_string()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let user_bin = home.join("bin").join("cftunnel");
        if user_bin.exists() {
            return user_bin.to_string_lossy().to_string();
        }
        "cftunnel".to_string()
    }
}

/// 创建 cftunnel 命令，Windows 上自动隐藏窗口
fn cftunnel_cmd(bin: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new(bin);
        cmd.creation_flags(0x08000000);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(bin)
    }
}

/// 检测 cftunnel 进程是否在运行（平台相关的补充检测）
fn check_cftunnel_process() -> Option<(Option<u64>, bool)> {
    #[cfg(target_os = "macos")]
    {
        // macOS: 通过 launchctl 检测
        let output = Command::new("launchctl").args(["list"]).output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if line.contains("com.cftunnel") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let pid = parts[0].parse::<u64>().ok();
                    let running = pid.is_some();
                    return Some((pid, running));
                }
            }
        }
        None
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: 通过 tasklist 检测 cftunnel.exe 进程
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", "IMAGENAME eq cftunnel.exe", "/FO", "CSV", "/NH"]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let output = cmd.output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        if text.contains("cftunnel.exe") {
            // 尝试提取 PID（CSV 格式: "cftunnel.exe","1234",...）
            let pid = text
                .lines()
                .next()
                .and_then(|line| line.split(',').nth(1))
                .and_then(|s| s.trim_matches('"').parse::<u64>().ok());
            return Some((pid, true));
        }
        None
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: 通过 pgrep 检测
        let output = Command::new("pgrep")
            .args(["-f", "cftunnel"])
            .output()
            .ok()?;
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let pid = text
                .lines()
                .next()
                .and_then(|s| s.trim().parse::<u64>().ok());
            return Some((pid, true));
        }
        None
    }
}

#[tauri::command]
pub fn get_cftunnel_status() -> Result<Value, String> {
    let bin = cftunnel_bin();
    let mut result = serde_json::Map::new();

    // 快速路径：如果是 fallback 名称且不在已知路径，直接返回未安装
    #[cfg(target_os = "windows")]
    if bin == "cftunnel.exe" {
        result.insert("installed".into(), Value::Bool(false));
        return Ok(Value::Object(result));
    }
    #[cfg(not(target_os = "windows"))]
    if bin == "cftunnel" {
        result.insert("installed".into(), Value::Bool(false));
        return Ok(Value::Object(result));
    }

    // 二进制存在即已安装，跳过 cftunnel version 调用
    result.insert("installed".into(), Value::Bool(true));

    // 获取状态（单次 CLI 调用）
    if let Ok(out) = cftunnel_cmd(&bin).arg("status").output() {
        let text = String::from_utf8_lossy(&out.stdout);
        let status = parse_cftunnel_status(&text);
        // 从 status 输出中提取版本号（如果有）
        for (k, v) in status {
            result.insert(k, v);
        }
    }

    // 仅当 status 报未运行时才做进程检测补充
    let reported_running = result
        .get("running")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !reported_running {
        if let Some((pid, running)) = check_cftunnel_process() {
            if running {
                result.insert("running".into(), Value::Bool(true));
                if let Some(p) = pid {
                    result.insert("pid".into(), Value::Number(p.into()));
                }
            }
        }
    }

    // 获取路由列表
    if let Ok(out) = cftunnel_cmd(&bin).arg("list").output() {
        let text = String::from_utf8_lossy(&out.stdout);
        let routes = parse_cftunnel_routes(&text);
        result.insert("routes".into(), Value::Array(routes));
    }

    Ok(Value::Object(result))
}

#[tauri::command]
pub fn cftunnel_action(action: String) -> Result<(), String> {
    let bin = cftunnel_bin();
    let args = match action.as_str() {
        "up" => vec!["up"],
        "down" => vec!["down"],
        "restart" => vec!["restart"],
        _ => return Err(format!("不支持的操作: {action}")),
    };
    let output = cftunnel_cmd(&bin)
        .args(&args)
        .output()
        .map_err(|e| format!("执行 cftunnel {action} 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("cftunnel {action} 失败: {stderr}"));
    }
    Ok(())
}

#[tauri::command]
pub fn get_cftunnel_logs(lines: Option<u32>) -> Result<String, String> {
    let bin = cftunnel_bin();
    let n = lines.unwrap_or(20).to_string();
    let output = cftunnel_cmd(&bin)
        .args(["logs", "--tail", &n])
        .output()
        .map_err(|e| format!("读取 cftunnel 日志失败: {e}"))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 检测 ClawApp 状态（端口 3210）
/// 使用 TcpStream 跨平台检测端口，macOS 额外用 lsof 获取 PID
#[tauri::command]
pub fn get_clawapp_status() -> Result<Value, String> {
    let mut result = serde_json::Map::new();

    // 检测是否已安装（检查 npm 全局包）
    let installed = check_clawapp_installed();
    result.insert("installed".into(), Value::Bool(installed));

    // 跨平台方式：尝试连接端口检测是否在运行
    let running = std::net::TcpStream::connect_timeout(
        &"127.0.0.1:3210".parse().unwrap(),
        std::time::Duration::from_millis(150),
    )
    .is_ok();

    result.insert("running".into(), Value::Bool(running));

    // macOS: 用 lsof 获取 PID
    #[cfg(target_os = "macos")]
    if running {
        if let Ok(out) = Command::new("lsof")
            .args(["-i", ":3210", "-P", "-t"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Ok(pid) = text.lines().next().unwrap_or("").parse::<u64>() {
                result.insert("pid".into(), Value::Number(pid.into()));
            }
        }
    }

    // Windows: TCP 探测已足够，不再 spawn netstat 取 PID
    #[cfg(target_os = "windows")]
    {}

    result.insert("port".into(), Value::Number(3210.into()));
    result.insert("url".into(), Value::String("http://localhost:3210".into()));
    Ok(Value::Object(result))
}

/// 检测 ClawApp 是否已安装
fn check_clawapp_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "npm", "list", "-g", "clawapp"]);
        cmd.creation_flags(0x08000000);
        if let Ok(out) = cmd.output() {
            return out.status.success();
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(out) = Command::new("npm").args(["list", "-g", "clawapp"]).output() {
            return out.status.success();
        }
        false
    }
}

fn clawhub_cmd() -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("npx.cmd");
        cmd.creation_flags(0x08000000);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("npx")
    }
}

fn clawhub_workdir() -> std::path::PathBuf {
    super::openclaw_dir()
}

fn parse_clawhub_search_output(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('-') {
                return None;
            }
            let parts: Vec<&str> = line.split("  ").filter(|s| !s.trim().is_empty()).collect();
            if parts.is_empty() {
                return None;
            }
            let slug = parts[0].trim();
            let display_name = parts.get(1).copied().unwrap_or(slug).trim();
            Some(json!({
                "slug": slug,
                "displayName": display_name,
                "summary": "",
                "source": "clawhub"
            }))
        })
        .collect()
}

fn parse_clawhub_list_output(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line == "No installed skills." {
                return None;
            }
            let slug = line.split_whitespace().next()?.trim();
            Some(json!({
                "slug": slug,
                "installed": true
            }))
        })
        .collect()
}

fn parse_clawhub_trending_output(output: &str) -> Vec<Value> {
    let mut items = Vec::new();
    let mut lines = output.lines().peekable();

    while let Some(line) = lines.next() {
        let line = line.trim();
        if !line.starts_with('[') || !line.contains("](") {
            continue;
        }
        let Some(close_bracket) = line.find("](") else { continue; };
        let title_block = &line[1..close_bracket];
        let Some(url_end) = line[close_bracket + 2..].find(')') else { continue; };
        let url = &line[close_bracket + 2..close_bracket + 2 + url_end];

        let mut parts = title_block.split('/');
        let display_name = parts.next().unwrap_or("").trim();
        let slug = parts.next().unwrap_or("").trim();
        if slug.is_empty() {
            continue;
        }

        let summary = lines
            .next()
            .map(|s| s.trim().trim_matches('\\'))
            .unwrap_or("")
            .to_string();

        let mut author = String::new();
        let mut downloads = String::new();
        for _ in 0..3 {
            if let Some(meta) = lines.next() {
                let meta = meta.trim();
                if meta.contains("@") && author.is_empty() {
                    if let Some(at) = meta.rfind('@') {
                        author = meta[at + 1..].trim_matches('\\').to_string();
                    }
                }
                if meta.contains('★') && downloads.is_empty() {
                    downloads = meta.split('★').next().unwrap_or("").trim().to_string();
                }
            }
        }

        items.push(json!({
            "slug": slug,
            "displayName": display_name,
            "summary": summary,
            "author": author,
            "downloadsText": downloads,
            "url": url,
            "source": "clawhub"
        }));

        if items.len() >= 12 {
            break;
        }
    }

    items
}

#[tauri::command]
pub fn clawhub_trending() -> Result<Value, String> {
    let output = clawhub_cmd()
        .args(["-y", "clawhub", "explore"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let items = parse_clawhub_trending_output(&stdout);
            if !items.is_empty() {
                return Ok(Value::Array(items));
            }
        }
    }

    Ok(Value::Array(vec![
        json!({"slug":"find-skills","displayName":"Find Skills","summary":"帮助用户发现并安装合适的 skills。","author":"JimLiuxinghai","downloadsText":"99.3k","url":"https://clawhub.ai/JimLiuxinghai/find-skills","source":"clawhub"}),
        json!({"slug":"summarize","displayName":"Summarize","summary":"总结网页、PDF、图片、音频等内容。","author":"steipete","downloadsText":"82.7k","url":"https://clawhub.ai/steipete/summarize","source":"clawhub"}),
        json!({"slug":"agent-browser","displayName":"Agent Browser","summary":"浏览器自动化 CLI，支持点击、输入、抓取和截图。","author":"TheSethRose","downloadsText":"73.9k","url":"https://clawhub.ai/TheSethRose/agent-browser","source":"clawhub"}),
        json!({"slug":"github","displayName":"Github","summary":"通过 gh CLI 与 GitHub issues、PR、CI 交互。","author":"steipete","downloadsText":"72.5k","url":"https://clawhub.ai/steipete/github","source":"clawhub"}),
        json!({"slug":"weather","displayName":"Weather","summary":"获取当前天气和预报，无需 API Key。","author":"steipete","downloadsText":"61.9k","url":"https://clawhub.ai/steipete/weather","source":"clawhub"}),
        json!({"slug":"brave-search","displayName":"Brave Search","summary":"轻量网页搜索和内容提取。","author":"steipete","downloadsText":"29.4k","url":"https://clawhub.ai/steipete/brave-search","source":"clawhub"})
    ]))
}

#[tauri::command]
pub fn clawhub_search(query: String) -> Result<Value, String> {
    let output = clawhub_cmd()
        .args(["-y", "clawhub", "search", &query, "--limit", "12"])
        .output()
        .map_err(|e| format!("执行 clawhub search 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("clawhub search 失败: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(Value::Array(parse_clawhub_search_output(&stdout)))
}

#[tauri::command]
pub fn clawhub_list_installed() -> Result<Value, String> {
    let workdir = clawhub_workdir();
    std::fs::create_dir_all(workdir.join("skills")).map_err(|e| format!("创建 skills 目录失败: {e}"))?;

    let output = clawhub_cmd()
        .current_dir(&workdir)
        .args(["-y", "clawhub", "list", "--workdir", ".", "--dir", "skills"])
        .output()
        .map_err(|e| format!("执行 clawhub list 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("clawhub list 失败: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(Value::Array(parse_clawhub_list_output(&stdout)))
}

#[tauri::command]
pub fn clawhub_inspect(slug: String) -> Result<Value, String> {
    let output = clawhub_cmd()
        .args(["-y", "clawhub", "inspect", &slug, "--json"])
        .output()
        .map_err(|e| format!("执行 clawhub inspect 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("clawhub inspect 失败: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("解析 clawhub inspect 输出失败: {e}"))
}

#[tauri::command]
pub fn clawhub_install(slug: String) -> Result<Value, String> {
    let workdir = clawhub_workdir();
    std::fs::create_dir_all(workdir.join("skills")).map_err(|e| format!("创建 skills 目录失败: {e}"))?;

    let output = clawhub_cmd()
        .current_dir(&workdir)
        .args(["-y", "clawhub", "install", &slug, "--workdir", ".", "--dir", "skills"])
        .output()
        .map_err(|e| format!("执行 clawhub install 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("clawhub install 失败: {}", stderr.trim()));
    }

    Ok(json!({
        "success": true,
        "slug": slug,
        "output": String::from_utf8_lossy(&output.stdout).trim().to_string()
    }))
}

/// 一键安装 cftunnel
/// macOS/Linux: bash 脚本安装
/// Windows: PowerShell 下载安装
#[tauri::command]
pub async fn install_cftunnel(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    let _ = app.emit("install-log", "开始安装 cftunnel...");
    let _ = app.emit("install-progress", 10);

    let _ = app.emit("install-log", "下载安装脚本...");
    let _ = app.emit("install-progress", 30);

    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let install_script = r#"
#!/bin/bash
set -e
cd /tmp
echo "下载 cftunnel..."
curl -fsSL https://raw.githubusercontent.com/qingchencloud/cftunnel/main/install.sh -o cftunnel-install.sh
chmod +x cftunnel-install.sh
echo "执行安装..."
./cftunnel-install.sh
echo "安装完成"
"#;
        Command::new("bash")
            .arg("-c")
            .arg(install_script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动安装进程失败: {e}"))?
    };

    #[cfg(target_os = "windows")]
    let mut child = {
        let install_script = r#"
$ErrorActionPreference = 'Stop'
$binDir = Join-Path $env:USERPROFILE 'bin'
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
Write-Output '下载 cftunnel...'
$url = 'https://github.com/qingchencloud/cftunnel/releases/latest/download/cftunnel-windows-amd64.exe'
$dest = Join-Path $binDir 'cftunnel.exe'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
Write-Output '安装完成'
"#;
        // 使用完整路径调用 PowerShell，避免 MSYS2/Git Bash 环境下找不到
        let ps_path = std::env::var("SystemRoot")
            .map(|root| {
                format!(
                    "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                    root
                )
            })
            .unwrap_or_else(|_| "powershell.exe".to_string());
        Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                install_script,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动安装进程失败: {e}"))?
    };

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    let app2 = app.clone();
    let handle = std::thread::spawn(move || {
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app2.emit("install-log", &line);
            }
        }
    });

    let mut progress = 40;
    if let Some(pipe) = stdout {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let _ = app.emit("install-log", &line);
            if progress < 90 {
                progress += 5;
                let _ = app.emit("install-progress", progress);
            }
        }
    }

    let _ = handle.join();
    let _ = app.emit("install-progress", 95);

    let status = child.wait().map_err(|e| format!("等待安装进程失败: {e}"))?;
    let _ = app.emit("install-progress", 100);

    if !status.success() {
        let _ = app.emit("install-log", "❌ 安装失败");
        return Err("安装失败，请查看日志".into());
    }

    let _ = app.emit("install-log", "✅ cftunnel 安装成功");
    Ok("安装成功".into())
}

/// 一键安装 ClawApp（通过 npm）
#[tauri::command]
pub async fn install_clawapp(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    let _ = app.emit("install-log", "开始安装 ClawApp...");
    let _ = app.emit("install-progress", 10);

    let _ = app.emit("install-log", "通过 npm 安装 clawapp...");
    let _ = app.emit("install-progress", 30);

    #[cfg(target_os = "windows")]
    let mut child = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "npm", "install", "-g", "clawapp"]);
        cmd.creation_flags(0x08000000);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动安装进程失败: {e}"))?
    };

    #[cfg(not(target_os = "windows"))]
    let mut child = {
        Command::new("npm")
            .args(["install", "-g", "clawapp"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动安装进程失败: {e}"))?
    };

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    let app2 = app.clone();
    let handle = std::thread::spawn(move || {
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app2.emit("install-log", &line);
            }
        }
    });

    let mut progress = 40;
    if let Some(pipe) = stdout {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let _ = app.emit("install-log", &line);
            if progress < 90 {
                progress += 5;
                let _ = app.emit("install-progress", progress);
            }
        }
    }

    let _ = handle.join();
    let _ = app.emit("install-progress", 95);

    let status = child.wait().map_err(|e| format!("等待安装进程失败: {e}"))?;
    let _ = app.emit("install-progress", 100);

    if !status.success() {
        let _ = app.emit("install-log", "❌ 安装失败");
        return Err("安装失败，请查看日志".into());
    }

    let _ = app.emit("install-log", "✅ ClawApp 安装成功");
    Ok("安装成功".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_search_output_returns_slug_and_summary() {
        let text = "weather  Weather  (3.830)\napi-gateway  API Gateway  (3.123)\n";
        let items = parse_clawhub_search_output(text);
        assert_eq!(items[0]["slug"], "weather");
        assert_eq!(items[1]["displayName"], "API Gateway");
    }

    #[test]
    fn parse_list_output_returns_installed_slugs() {
        let text = "weather  Weather\nfind-skills  Find Skills\n";
        let items = parse_clawhub_list_output(text);
        assert_eq!(items[0]["slug"], "weather");
        assert_eq!(items[1]["slug"], "find-skills");
        assert_eq!(items[0]["installed"], true);
    }
}
