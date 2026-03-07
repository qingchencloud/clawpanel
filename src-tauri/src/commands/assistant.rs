use base64::{engine::general_purpose, Engine as _};
/// AI 助手工具命令
/// 提供终端执行、文件读写、目录列表等能力
/// 仅在用户主动开启工具后由 AI 调用
use std::path::PathBuf;

/// 审计日志：记录 AI 助手的敏感操作（exec / read / write）
fn audit_log(action: &str, detail: &str) {
    let log_dir = super::openclaw_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("assistant-audit.log");
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{ts}] [{action}] {detail}\n");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

/// ClawPanel 数据目录（~/.openclaw/clawpanel/）
fn data_dir() -> PathBuf {
    super::openclaw_dir().join("clawpanel")
}

/// 确保数据目录及子目录存在，返回目录路径
#[tauri::command]
pub async fn assistant_ensure_data_dir() -> Result<String, String> {
    let base = data_dir();
    let subdirs = ["images", "sessions", "cache"];
    for sub in &subdirs {
        let dir = base.join(sub);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("创建目录 {} 失败: {e}", dir.display()))?;
    }
    Ok(base.to_string_lossy().to_string())
}

/// 保存图片（base64 → 文件），返回文件路径
#[tauri::command]
pub async fn assistant_save_image(id: String, data: String) -> Result<String, String> {
    let dir = data_dir().join("images");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("创建目录失败: {e}"))?;

    // data 可能包含 data:image/xxx;base64, 前缀
    let pure_b64 = if let Some(pos) = data.find(",") {
        &data[pos + 1..]
    } else {
        &data
    };

    // 从 data URI 提取扩展名
    let ext = if data.starts_with("data:image/png") {
        "png"
    } else if data.starts_with("data:image/gif") {
        "gif"
    } else if data.starts_with("data:image/webp") {
        "webp"
    } else {
        "jpg"
    };

    let filename = format!("{}.{}", id, ext);
    let filepath = dir.join(&filename);

    let bytes = general_purpose::STANDARD
        .decode(pure_b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;

    tokio::fs::write(&filepath, &bytes)
        .await
        .map_err(|e| format!("写入图片失败: {e}"))?;

    Ok(filepath.to_string_lossy().to_string())
}

/// 加载图片（文件 → base64 data URI）
#[tauri::command]
pub async fn assistant_load_image(id: String) -> Result<String, String> {
    let dir = data_dir().join("images");

    // 尝试各种扩展名
    let mut found: Option<PathBuf> = None;
    for ext in &["jpg", "png", "gif", "webp", "jpeg"] {
        let path = dir.join(format!("{}.{}", id, ext));
        if path.exists() {
            found = Some(path);
            break;
        }
    }

    let filepath = found.ok_or_else(|| format!("图片 {} 不存在", id))?;
    let bytes = tokio::fs::read(&filepath)
        .await
        .map_err(|e| format!("读取图片失败: {e}"))?;

    let ext = filepath
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg");
    let mime = match ext {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };

    let b64 = general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 删除图片文件
#[tauri::command]
pub async fn assistant_delete_image(id: String) -> Result<(), String> {
    let dir = data_dir().join("images");
    for ext in &["jpg", "png", "gif", "webp", "jpeg"] {
        let path = dir.join(format!("{}.{}", id, ext));
        if path.exists() {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|e| format!("删除图片失败: {e}"))?;
        }
    }
    Ok(())
}

// ── AI 助手工具 ──

/// 执行 shell 命令，返回 stdout + stderr
#[tauri::command]
pub async fn assistant_exec(command: String, cwd: Option<String>) -> Result<String, String> {
    let work_dir = cwd.unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    audit_log("EXEC", &format!("cmd={command} cwd={work_dir}"));

    let output;

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        output = tokio::process::Command::new("cmd")
            .args(["/c", &command])
            .current_dir(&work_dir)
            .env("PATH", super::enhanced_path())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await
            .map_err(|e| format!("执行失败: {e}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        output = tokio::process::Command::new("sh")
            .args(["-c", &command])
            .current_dir(&work_dir)
            .env("PATH", super::enhanced_path())
            .output()
            .await
            .map_err(|e| format!("执行失败: {e}"))?;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let code = output.status.code().unwrap_or(-1);

    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str("[stderr] ");
        result.push_str(&stderr);
    }
    if result.is_empty() {
        result = format!("(命令已执行，退出码: {code})");
    } else if code != 0 {
        result.push_str(&format!("\n(退出码: {code})"));
    }

    // 限制输出长度
    if result.len() > 10000 {
        result.truncate(10000);
        result.push_str("\n...(输出已截断)");
    }

    Ok(result)
}

/// 读取文件内容
#[tauri::command]
pub async fn assistant_read_file(path: String) -> Result<String, String> {
    audit_log("READ", &path);
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("读取文件失败 {path}: {e}"))?;

    if content.len() > 50000 {
        Ok(format!(
            "{}...\n(文件内容已截断，共 {} 字节)",
            &content[..50000],
            content.len()
        ))
    } else {
        Ok(content)
    }
}

/// 写入文件
#[tauri::command]
pub async fn assistant_write_file(path: String, content: String) -> Result<String, String> {
    audit_log("WRITE", &format!("{path} ({} bytes)", content.len()));
    if let Some(parent) = PathBuf::from(&path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败: {e}"))?;
    }

    tokio::fs::write(&path, &content)
        .await
        .map_err(|e| format!("写入文件失败 {path}: {e}"))?;

    Ok(format!("已写入 {} ({} 字节)", path, content.len()))
}

/// 获取系统信息（OS、架构、主目录、主机名）
#[tauri::command]
pub async fn assistant_system_info() -> Result<String, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let home = dirs::home_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into());
    let shell = if cfg!(target_os = "windows") {
        "powershell / cmd"
    } else if cfg!(target_os = "macos") {
        "zsh (macOS default)"
    } else {
        "bash / sh"
    };

    Ok(format!(
        "OS: {}\nArch: {}\nHome: {}\nHostname: {}\nShell: {}\nPath separator: {}",
        os,
        arch,
        home,
        hostname,
        shell,
        std::path::MAIN_SEPARATOR
    ))
}

/// 列出运行中的进程（按名称过滤）
#[tauri::command]
pub async fn assistant_list_processes(filter: Option<String>) -> Result<String, String> {
    let output = if cfg!(target_os = "windows") {
        tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-Command",
                "Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64 | Sort-Object ProcessName | Format-Table -AutoSize | Out-String -Width 200"])
            .output()
            .await
    } else {
        tokio::process::Command::new("ps")
            .args(["aux", "--sort=-%mem"])
            .output()
            .await
    };

    let output = output.map_err(|e| format!("获取进程列表失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if let Some(f) = filter {
        let f_lower = f.to_lowercase();
        let lines: Vec<&str> = stdout
            .lines()
            .filter(|line| {
                let lower = line.to_lowercase();
                lower.contains(&f_lower)
                    || lower.starts_with("id")
                    || lower.starts_with("user")
                    || lower.contains("---")
            })
            .collect();
        if lines.len() <= 2 {
            return Ok(format!("未找到匹配 '{}' 的进程", f));
        }
        Ok(lines.join("\n"))
    } else {
        // 无过滤时限制输出行数
        let lines: Vec<&str> = stdout.lines().take(80).collect();
        Ok(lines.join("\n"))
    }
}

/// 检测端口是否在监听
#[tauri::command]
pub async fn assistant_check_port(port: u16) -> Result<String, String> {
    use std::time::Duration;

    let addr = format!("127.0.0.1:{}", port);
    let result = std::net::TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("地址解析失败: {e}"))?,
        Duration::from_secs(2),
    );

    match result {
        Ok(_stream) => {
            // 尝试获取占用进程信息
            let process_info = get_port_process(port).await;
            Ok(format!(
                "端口 {} 已被占用（正在监听）{}",
                port, process_info
            ))
        }
        Err(_) => Ok(format!("端口 {} 未被占用（空闲）", port)),
    }
}

async fn get_port_process(port: u16) -> String {
    let output = if cfg!(target_os = "windows") {
        tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-Command",
                &format!("Get-NetTCPConnection -LocalPort {} -ErrorAction SilentlyContinue | Select-Object OwningProcess | ForEach-Object {{ (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }}", port)])
            .output()
            .await
    } else {
        tokio::process::Command::new("lsof")
            .args(["-i", &format!(":{}", port), "-t"])
            .output()
            .await
    };

    match output {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                String::new()
            } else {
                format!("\n占用进程: {}", s)
            }
        }
        Err(_) => String::new(),
    }
}

/// 联网搜索（DuckDuckGo HTML）
#[tauri::command]
pub async fn assistant_web_search(
    query: String,
    max_results: Option<usize>,
) -> Result<String, String> {
    let max = max_results.unwrap_or(5);
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(&query)
    );

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let html = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {e}"))?
        .text()
        .await
        .map_err(|e| format!("读取搜索结果失败: {e}"))?;

    // 解析搜索结果
    let mut results = Vec::new();
    let re_result = regex::Regex::new(
        r#"class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)</a>"#
    ).unwrap();

    let re_strip_tags = regex::Regex::new(r"<[^>]+>").unwrap();

    for cap in re_result.captures_iter(&html) {
        if results.len() >= max {
            break;
        }
        let raw_url = &cap[1];
        let title = re_strip_tags.replace_all(&cap[2], "").trim().to_string();
        let snippet = re_strip_tags.replace_all(&cap[3], "").trim().to_string();

        // 解码 DuckDuckGo 的重定向 URL
        let final_url = if let Some(pos) = raw_url.find("uddg=") {
            let encoded = &raw_url[pos + 5..];
            let end = encoded.find('&').unwrap_or(encoded.len());
            urlencoding::decode(&encoded[..end])
                .unwrap_or_else(|_| encoded[..end].into())
                .to_string()
        } else {
            raw_url.to_string()
        };

        if !title.is_empty() && !final_url.is_empty() {
            results.push((title, final_url, snippet));
        }
    }

    if results.is_empty() {
        return Ok(format!("搜索「{}」未找到相关结果。", query));
    }

    let mut output = format!("搜索「{}」找到 {} 条结果：\n\n", query, results.len());
    for (i, (title, url, snippet)) in results.iter().enumerate() {
        output.push_str(&format!(
            "{}. **{}**\n   {}\n   {}\n\n",
            i + 1,
            title,
            url,
            snippet
        ));
    }
    Ok(output)
}

/// 抓取 URL 内容（通过 Jina Reader API）
#[tauri::command]
pub async fn assistant_fetch_url(url: String) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL 必须以 http:// 或 https:// 开头".into());
    }

    let jina_url = format!("https://r.jina.ai/{}", url);
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let content = client
        .get(&jina_url)
        .header("Accept", "text/plain")
        .send()
        .await
        .map_err(|e| format!("抓取失败: {e}"))?
        .text()
        .await
        .map_err(|e| format!("读取内容失败: {e}"))?;

    if content.len() > 100_000 {
        Ok(format!(
            "{}\n\n[内容已截断，超过 100KB 限制]",
            &content[..100_000]
        ))
    } else if content.is_empty() {
        Ok("（页面内容为空）".into())
    } else {
        Ok(content)
    }
}

/// 列出目录内容
#[tauri::command]
pub async fn assistant_list_dir(path: String) -> Result<String, String> {
    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("读取目录失败 {path}: {e}"))?;

    let mut items = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| format!("{e}"))? {
        let meta = entry.metadata().await.ok();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        if is_dir {
            items.push(format!("[DIR]  {}/", name));
        } else {
            items.push(format!("[FILE] {} ({} bytes)", name, size));
        }

        if items.len() >= 200 {
            items.push("...(已截断)".into());
            break;
        }
    }

    items.sort();
    Ok(items.join("\n"))
}
