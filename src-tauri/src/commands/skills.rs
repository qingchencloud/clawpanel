use crate::utils::openclaw_command_async;
use serde_json::Value;

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

/// 列出所有 Skills 及其状态（openclaw skills list --json）
#[tauri::command]
pub async fn skills_list() -> Result<Value, String> {
    let output = openclaw_command_async()
        .args(["skills", "list", "--json"])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // CLI output may contain non-JSON lines (Node warnings, update prompts).
            // Extract the first valid JSON object or array from stdout.
            extract_json(&stdout).ok_or_else(|| "解析失败: 输出中未找到有效 JSON".to_string())
        }
        _ => {
            // CLI 不可用时，兜底扫描本地 skills 目录
            scan_local_skills()
        }
    }
}

/// 查看单个 Skill 详情（openclaw skills info <name> --json）
#[tauri::command]
pub async fn skills_info(name: String) -> Result<Value, String> {
    let output = openclaw_command_async()
        .args(["skills", "info", &name, "--json"])
        .output()
        .await
        .map_err(|e| format!("执行 openclaw 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("获取详情失败: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_json(&stdout).ok_or_else(|| "解析详情失败: 输出中未找到有效 JSON".to_string())
}

/// 检查 Skills 依赖状态（openclaw skills check --json）
#[tauri::command]
pub async fn skills_check() -> Result<Value, String> {
    let output = openclaw_command_async()
        .args(["skills", "check", "--json"])
        .output()
        .await
        .map_err(|e| format!("执行 openclaw 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("检查失败: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_json(&stdout).ok_or_else(|| "解析失败: 输出中未找到有效 JSON".to_string())
}

/// 安装 Skill 依赖（根据 install spec 执行 brew/npm/go/uv/download）
#[tauri::command]
pub async fn skills_install_dep(kind: String, spec: Value) -> Result<Value, String> {

    let (program, args) = match kind.as_str() {
        "brew" => {
            let formula = spec
                .get("formula")
                .and_then(|v| v.as_str())
                .ok_or("缺少 formula 参数")?
                .to_string();
            ("brew".to_string(), vec!["install".to_string(), formula])
        }
        "node" => {
            let package = spec
                .get("package")
                .and_then(|v| v.as_str())
                .ok_or("缺少 package 参数")?
                .to_string();
            (
                "npm".to_string(),
                vec!["install".to_string(), "-g".to_string(), package],
            )
        }
        "go" => {
            let module = spec
                .get("module")
                .and_then(|v| v.as_str())
                .ok_or("缺少 module 参数")?
                .to_string();
            ("go".to_string(), vec!["install".to_string(), module])
        }
        "uv" => {
            let package = spec
                .get("package")
                .and_then(|v| v.as_str())
                .ok_or("缺少 package 参数")?
                .to_string();
            (
                "uv".to_string(),
                vec!["tool".to_string(), "install".to_string(), package],
            )
        }
        other => return Err(format!("不支持的安装类型: {other}")),
    };

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args);
    super::apply_system_env_tokio(&mut cmd);
    super::apply_proxy_env_tokio(&mut cmd);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("执行 {program} 失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "安装失败 ({program} {}): {}",
            output.status,
            stderr.trim()
        ));
    }

    Ok(serde_json::json!({
        "success": true,
        "output": stdout.trim(),
    }))
}

/// 检测 SkillHub CLI 是否已安装
#[tauri::command]
pub async fn skills_skillhub_check() -> Result<Value, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "skillhub", "--version"]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("skillhub");
        c.arg("--version");
        c
    };
    super::apply_system_env_tokio(&mut cmd);
    match cmd.output().await {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            Ok(serde_json::json!({ "installed": true, "version": ver }))
        }
        _ => {
            #[cfg(target_os = "windows")]
            {
                let mut where_cmd = tokio::process::Command::new("cmd");
                where_cmd.args(["/c", "where", "skillhub"]);
                where_cmd.creation_flags(0x08000000);
                super::apply_system_env_tokio(&mut where_cmd);
                if let Ok(out) = where_cmd.output().await {
                    if out.status.success() {
                        let text = String::from_utf8_lossy(&out.stdout).to_string();
                        if let Some(first) = text.lines().find(|l| !l.trim().is_empty()) {
                            let path = first.trim().to_string();
                            let mut ver_cmd = tokio::process::Command::new("cmd");
                            ver_cmd.args(["/c", &path, "--version"]);
                            ver_cmd.creation_flags(0x08000000);
                            super::apply_system_env_tokio(&mut ver_cmd);
                            if let Ok(ver_out) = ver_cmd.output().await {
                                if ver_out.status.success() {
                                    let ver = String::from_utf8_lossy(&ver_out.stdout)
                                        .trim()
                                        .to_string();
                                    return Ok(serde_json::json!({
                                        "installed": true,
                                        "version": ver,
                                        "path": path
                                    }));
                                }
                            }
                            return Ok(serde_json::json!({
                                "installed": true,
                                "path": path
                            }));
                        }
                    }
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut which_cmd = tokio::process::Command::new("sh");
                which_cmd.args(["-c", "which skillhub"]);
                super::apply_system_env_tokio(&mut which_cmd);
                if let Ok(out) = which_cmd.output().await {
                    if out.status.success() {
                        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if !path.is_empty() {
                            let mut ver_cmd = tokio::process::Command::new(&path);
                            ver_cmd.arg("--version");
                            super::apply_system_env_tokio(&mut ver_cmd);
                            if let Ok(ver_out) = ver_cmd.output().await {
                                if ver_out.status.success() {
                                    let ver = String::from_utf8_lossy(&ver_out.stdout)
                                        .trim()
                                        .to_string();
                                    return Ok(serde_json::json!({
                                        "installed": true,
                                        "version": ver,
                                        "path": path
                                    }));
                                }
                            }
                            return Ok(serde_json::json!({
                                "installed": true,
                                "path": path
                            }));
                        }
                    }
                }
            }
            Ok(serde_json::json!({ "installed": false }))
        }
    }
}

/// 安装 SkillHub CLI（从腾讯云 COS 下载）
#[tauri::command]
pub async fn skills_skillhub_setup(cli_only: bool) -> Result<Value, String> {
    #[allow(unused_variables)]
    let flag = if cli_only {
        "--cli-only"
    } else {
        "--no-skills"
    };

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = tokio::process::Command::new("bash");
        cmd.args(["-c", &format!(
            "curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash -s -- {flag}"
        )]);
        super::apply_system_env_tokio(&mut cmd);
        super::apply_proxy_env_tokio(&mut cmd);
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("执行安装脚本失败: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if !output.status.success() {
            return Err(format!("SkillHub 安装失败: {}", stderr.trim()));
        }
        Ok(serde_json::json!({ "success": true, "output": stdout.trim() }))
    }
    #[cfg(target_os = "windows")]
    {
        // Windows: 通过 npm 全局安装 skillhub（避免 bash/WSL 路径问题）
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.args([
            "/c",
            "npm",
            "install",
            "-g",
            "skillhub@latest",
            "--registry",
            "https://registry.npmmirror.com",
        ]);
        super::apply_system_env_tokio(&mut cmd);
        super::apply_proxy_env_tokio(&mut cmd);
        cmd.creation_flags(0x08000000);
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("执行 npm install 失败: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if !output.status.success() {
            return Err(format!("SkillHub CLI 安装失败: {}", stderr.trim()));
        }
        Ok(serde_json::json!({ "success": true, "output": stdout.trim() }))
    }
}

/// 从 SkillHub 安装 Skill（skillhub install <slug>）
#[tauri::command]
pub async fn skills_skillhub_install(slug: String) -> Result<Value, String> {
    let home = dirs::home_dir().unwrap_or_default();

    let skills_dir = super::openclaw_dir().join("skills");
    if !skills_dir.exists() {
        std::fs::create_dir_all(&skills_dir).map_err(|e| format!("创建 skills 目录失败: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "skillhub", "install", &slug, "--force"]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("skillhub");
        c.args(["install", &slug, "--force"]);
        c
    };
    cmd.current_dir(&home);
    super::apply_system_env_tokio(&mut cmd);
    super::apply_proxy_env_tokio(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("执行 skillhub 失败: {e}。请先安装 SkillHub CLI"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("安装失败: {}", stderr.trim()));
    }

    Ok(serde_json::json!({
        "success": true,
        "slug": slug,
        "output": stdout.trim(),
    }))
}

/// 从 SkillHub 搜索 Skills（skillhub search <query>）
#[tauri::command]
pub async fn skills_skillhub_search(query: String) -> Result<Value, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Value::Array(vec![]));
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "skillhub", "search", &q]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("skillhub");
        c.args(["search", &q]);
        c
    };
    super::apply_system_env_tokio(&mut cmd);
    super::apply_proxy_env_tokio(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("执行 skillhub 失败: {e}。请先安装 SkillHub CLI"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("搜索失败: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // skillhub search 实际输出格式：
    // ──────────────── (分隔线)
    // [1]   openclaw/openclaw/feishu-doc           Pass
    //      AI 85  Downloads 33  Stars 248.7k  Feishu document read/write opera...
    // ──────────────── (分隔线)
    // 序号和 slug 在同一行，描述在下一行
    let lines: Vec<&str> = stdout.lines().collect();
    let mut items: Vec<Value> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        // 找序号行：以 [数字] 开头，同一行包含 slug（owner/repo/name）
        if !trimmed.starts_with('[') {
            continue;
        }
        let bracket_end = match trimmed.find(']') {
            Some(pos) => pos,
            None => continue,
        };
        // 提取 ] 后面的内容
        let after_bracket = trimmed[bracket_end + 1..].trim();
        // slug 是第一个空格前的部分，且包含 /
        let slug = after_bracket.split_whitespace().next().unwrap_or("").trim();
        if !slug.contains('/') {
            continue;
        }

        // 描述在下一行：跳过数字与统计字段，提取文字描述
        let mut desc = String::new();
        if i + 1 < lines.len() {
            let next = lines[i + 1].trim();
            // 策略：找到首个英文或中文字符作为描述起点
            let mut start_idx = None;
            for (idx, ch) in next.char_indices() {
                if ch.is_ascii_alphabetic()
                    || (ch >= '\u{4E00}' && ch <= '\u{9FFF}')
                {
                    start_idx = Some(idx);
                    break;
                }
            }
            if let Some(idx) = start_idx {
                let after = next[idx..].trim();
                if !after.is_empty() {
                    desc = after.to_string();
                }
            }
        }

        items.push(serde_json::json!({
            "slug": slug,
            "description": desc,
            "source": "skillhub"
        }));
    }

    Ok(Value::Array(items))
}

/// 从 ClawHub 搜索 Skills（npx clawhub search <query>）— 原版海外源
#[tauri::command]
pub async fn skills_clawhub_search(query: String) -> Result<Value, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Value::Array(vec![]));
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "npx", "-y", "clawhub", "search", &q]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("npx");
        c.args(["-y", "clawhub", "search", &q]);
        c
    };
    super::apply_system_env_tokio(&mut cmd);
    super::apply_proxy_env_tokio(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("执行 clawhub 失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("搜索失败: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let items: Vec<Value> = stdout
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('-') && !l.starts_with("Search"))
        .map(|l| {
            let parts: Vec<&str> = l.splitn(2, char::is_whitespace).collect();
            let slug = parts.first().unwrap_or(&"").trim();
            let desc = parts.get(1).unwrap_or(&"").trim();
            serde_json::json!({ "slug": slug, "description": desc, "source": "clawhub" })
        })
        .filter(|v| !v["slug"].as_str().unwrap_or("").is_empty())
        .collect();
    Ok(Value::Array(items))
}

/// 从 ClawHub 安装 Skill（npx clawhub install <slug>）— 原版海外源
#[tauri::command]
pub async fn skills_clawhub_install(slug: String) -> Result<Value, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let skills_dir = super::openclaw_dir().join("skills");
    if !skills_dir.exists() {
        std::fs::create_dir_all(&skills_dir).map_err(|e| format!("创建 skills 目录失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", "npx", "-y", "clawhub", "install", &slug]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("npx");
        c.args(["-y", "clawhub", "install", &slug]);
        c
    };
    cmd.current_dir(&home);
    super::apply_system_env_tokio(&mut cmd);
    super::apply_proxy_env_tokio(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("执行 clawhub 失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!("安装失败: {}", stderr.trim()));
    }
    Ok(serde_json::json!({ "success": true, "slug": slug, "output": stdout.trim() }))
}

/// 卸载 Skill（删除 ~/.openclaw/skills/<name>/ 目录）
#[tauri::command]
pub async fn skills_uninstall(name: String) -> Result<Value, String> {
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("无效的 Skill 名称".to_string());
    }
    let skills_dir = super::openclaw_dir().join("skills").join(&name);
    if !skills_dir.exists() {
        return Err(format!("Skill「{name}」不存在"));
    }
    std::fs::remove_dir_all(&skills_dir).map_err(|e| format!("删除失败: {e}"))?;
    Ok(serde_json::json!({ "success": true, "name": name }))
}

/// Public wrapper for extract_json, used by config.rs get_status_summary
pub fn extract_json_pub(text: &str) -> Option<Value> {
    extract_json(text)
}

/// Extract the first valid JSON object or array from a string that may contain
/// non-JSON lines (Node.js warnings, npm update prompts, etc.)
fn extract_json(text: &str) -> Option<Value> {
    // Try parsing the whole string first (fast path)
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    // Find the first '{' or '[' and try parsing from there
    for (i, ch) in text.char_indices() {
        if ch == '{' || ch == '[' {
            if let Ok(v) = serde_json::from_str::<Value>(&text[i..]) {
                return Some(v);
            }
            // Try with a streaming deserializer to handle trailing content
            let mut de = serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>();
            if let Some(Ok(v)) = de.next() {
                return Some(v);
            }
        }
    }
    None
}

/// CLI 不可用时的兜底：扫描 ~/.openclaw/skills 目录
fn scan_local_skills() -> Result<Value, String> {
    let skills_dir = super::openclaw_dir().join("skills");
    if !skills_dir.exists() {
        return Ok(serde_json::json!({
            "skills": [],
            "source": "local-scan",
            "cliAvailable": false
        }));
    }

    let mut skills = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&skills_dir) {
        for entry in entries.flatten() {
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if !ft.is_dir() && !ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let skill_md = entry.path().join("SKILL.md");
            let description = if skill_md.exists() {
                // 尝试从 SKILL.md 的 frontmatter 中提取 description
                parse_skill_description(&skill_md)
            } else {
                String::new()
            };
            skills.push(serde_json::json!({
                "name": name,
                "description": description,
                "source": "managed",
                "eligible": true,
                "bundled": false,
                "filePath": skill_md.to_string_lossy(),
            }));
        }
    }

    Ok(serde_json::json!({
        "skills": skills,
        "source": "local-scan",
        "cliAvailable": false
    }))
}

/// 从 SKILL.md 的 YAML frontmatter 中提取 description
fn parse_skill_description(path: &std::path::Path) -> String {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    // frontmatter 格式: ---\n...\n---
    if !content.starts_with("---") {
        return String::new();
    }
    if let Some(end) = content[3..].find("---") {
        let fm = &content[3..3 + end];
        for line in fm.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("description:") {
                return rest.trim().trim_matches('"').trim_matches('\'').to_string();
            }
        }
    }
    String::new()
}
