use serde_json::Value;

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

/// 列出所有 Skills 及其状态（纯本地扫描，不依赖 CLI）
/// agent_id: 可选，指定 Agent ID，不同 Agent 有不同的 workspace/skills 目录
#[tauri::command]
pub async fn skills_list(agent_id: Option<String>) -> Result<Value, String> {
    let agent_ws = resolve_agent_skills_dir(agent_id.as_deref());
    scan_local_skills(None, agent_ws.as_deref())
}

/// 查看单个 Skill 详情（纯本地文件解析，不依赖 CLI）
#[tauri::command]
pub async fn skills_info(name: String, agent_id: Option<String>) -> Result<Value, String> {
    let agent_ws = resolve_agent_skills_dir(agent_id.as_deref());
    scan_custom_skill_detail(&name, agent_ws.as_deref())
        .ok_or_else(|| format!("Skill「{name}」不存在"))
}

/// 检查 Skills 依赖状态（纯本地扫描）
#[tauri::command]
pub async fn skills_check() -> Result<Value, String> {
    let skills = scan_local_skill_entries()?;
    let total = skills.len();
    let ready = skills
        .iter()
        .filter(|s| s.get("eligible").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();
    let missing = total - ready;
    Ok(serde_json::json!({
        "total": total,
        "ready": ready,
        "missingDeps": missing,
        "skills": skills,
    }))
}

/// 安装 Skill 依赖（根据 install spec 执行 brew/npm/go/uv/download）
#[tauri::command]
pub async fn skills_install_dep(kind: String, spec: Value) -> Result<Value, String> {
    let path_env = super::enhanced_path();

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
    cmd.args(&args).env("PATH", &path_env);
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

/// 搜索 SkillHub（内置 HTTP，不依赖 CLI）
#[tauri::command]
pub async fn skillhub_search(query: String, limit: Option<u32>) -> Result<Value, String> {
    let items = super::skillhub::search(&query, limit.unwrap_or(20)).await?;
    Ok(serde_json::to_value(items).unwrap_or_default())
}

/// 获取全量技能索引（COS CDN，带内存缓存）
#[tauri::command]
pub async fn skillhub_index() -> Result<Value, String> {
    let items = super::skillhub::fetch_index().await?;
    Ok(serde_json::to_value(items).unwrap_or_default())
}

/// 从 SkillHub 安装 Skill（内置 HTTP 下载 + zip 解压）
#[tauri::command]
pub async fn skillhub_install(slug: String, agent_id: Option<String>) -> Result<Value, String> {
    let skills_dir = match resolve_agent_skills_dir(agent_id.as_deref()) {
        Some(dir) => dir,
        None => super::openclaw_dir().join("skills"),
    };
    if !skills_dir.exists() {
        std::fs::create_dir_all(&skills_dir).map_err(|e| format!("创建 skills 目录失败: {e}"))?;
    }
    let installed_path = super::skillhub::install(&slug, &skills_dir).await?;
    Ok(serde_json::json!({
        "success": true,
        "slug": slug,
        "path": installed_path.to_string_lossy(),
    }))
}

/// 卸载 Skill（删除 skills/<name>/ 目录）
#[tauri::command]
pub async fn skills_uninstall(name: String, agent_id: Option<String>) -> Result<Value, String> {
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("无效的 Skill 名称".to_string());
    }
    let agent_ws = resolve_agent_skills_dir(agent_id.as_deref());
    let skills_dir = resolve_custom_skill_dir_with_agent(&name, agent_ws.as_deref())
        .ok_or_else(|| format!("Skill「{name}」不存在"))?;
    if !skills_dir.exists() {
        return Err(format!("Skill「{name}」不存在"));
    }
    std::fs::remove_dir_all(&skills_dir).map_err(|e| format!("删除失败: {e}"))?;
    Ok(serde_json::json!({ "success": true, "name": name }))
}

/// 验证 Skill 配置是否正确
#[tauri::command]
pub async fn skills_validate(name: String) -> Result<Value, String> {
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("无效的 Skill 名称".to_string());
    }

    let skill_dir = resolve_custom_skill_dir_with_agent(&name, None)
        .ok_or_else(|| format!("Skill「{name}」不存在"))?;
    if !skill_dir.exists() {
        return Err(format!("Skill「{name}」不存在"));
    }

    let skill_md = skill_dir.join("SKILL.md");
    let package_json = skill_dir.join("package.json");

    let mut issues: Vec<Value> = Vec::new();
    let mut warnings: Vec<Value> = Vec::new();
    let mut passed: Vec<String> = Vec::new();

    // 1. 检查 SKILL.md 是否存在
    if !skill_md.exists() {
        issues.push(serde_json::json!({
            "level": "error",
            "code": "MISSING_SKILL_MD",
            "message": "缺少 SKILL.md 文件",
            "suggestion": "创建 SKILL.md 文件，包含 skill 的描述和使用说明"
        }));
    } else {
        passed.push("SKILL.md 存在".to_string());

        // 2. 检查 SKILL.md frontmatter 格式
        if let Some(frontmatter) = parse_skill_frontmatter(&skill_md) {
            // 检查必要字段
            let required_fields = ["description", "fullPath"];
            for field in &required_fields {
                if !frontmatter
                    .get(*field)
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
                {
                    issues.push(serde_json::json!({
                        "level": "error",
                        "code": "MISSING_REQUIRED_FIELD",
                        "message": format!("SKILL.md frontmatter 缺少必要字段: {}", field),
                        "field": field,
                        "suggestion": format!("在 frontmatter 中添加 {}: <值>", field)
                    }));
                } else {
                    passed.push(format!("frontmatter.{} 字段存在且非空", field));
                }
            }

            // 检查 fullPath 格式（应该是绝对路径或 ~ 开头）
            if let Some(fp) = frontmatter.get("fullPath").and_then(|v| v.as_str()) {
                // Windows 路径以盘符开头（如 C:\），Unix 以 / 或 ~ 或 . 开头
                let is_valid_path = fp.starts_with('/')
                    || fp.starts_with('~')
                    || fp.starts_with('.')
                    || (fp.len() >= 3
                        && fp.as_bytes()[1] == b':'
                        && (fp.as_bytes()[2] == b'\\' || fp.as_bytes()[2] == b'/'));
                if !is_valid_path {
                    warnings.push(serde_json::json!({
                        "level": "warning",
                        "code": "INVALID_FULLPATH_FORMAT",
                        "message": format!("fullPath 格式可能不正确: {}", fp),
                        "suggestion": "建议使用绝对路径或 ~ 开头"
                    }));
                }
            }
        } else {
            issues.push(serde_json::json!({
                "level": "error",
                "code": "INVALID_FRONTMATTER",
                "message": "SKILL.md frontmatter 格式不正确",
                "suggestion": "确保 frontmatter 以 --- 开头和结尾，包含正确的 YAML 格式"
            }));
        }

        // 3. 检查 SKILL.md 内容（非 frontmatter 部分）
        if let Ok(content) = std::fs::read_to_string(&skill_md) {
            // 检查是否有空内容
            let body = content
                .split("---")
                .skip(2) // 跳过 frontmatter
                .collect::<Vec<_>>()
                .join("---")
                .trim()
                .to_string();

            if body.len() < 10 {
                warnings.push(serde_json::json!({
                    "level": "warning",
                    "code": "EMPTY_SKILL_CONTENT",
                    "message": "SKILL.md 正文内容为空或过短",
                    "suggestion": "添加 skill 的使用说明、功能描述等详细内容"
                }));
            } else {
                passed.push("SKILL.md 正文内容完整".to_string());
            }
        }
    }

    // 4. 检查 package.json
    if !package_json.exists() {
        warnings.push(serde_json::json!({
            "level": "warning",
            "code": "MISSING_PACKAGE_JSON",
            "message": "缺少 package.json 文件",
            "suggestion": "可选：创建 package.json 以便管理 npm 依赖"
        }));
    } else {
        passed.push("package.json 存在".to_string());

        // 5. 解析并验证 package.json
        if let Ok(pkg_content) = std::fs::read_to_string(&package_json) {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&pkg_content) {
                // 检查 name 字段
                if let Some(pkg_name) = pkg.get("name").and_then(|v| v.as_str()) {
                    if pkg_name != name {
                        warnings.push(serde_json::json!({
                            "level": "warning",
                            "code": "NAME_MISMATCH",
                            "message": format!("package.json 中的 name '{}' 与目录名 '{}' 不一致", pkg_name, name),
                            "suggestion": "确保 package.json 的 name 字段与 skill 目录名一致"
                        }));
                    } else {
                        passed.push("package.json.name 与目录名一致".to_string());
                    }
                }

                // 检查 dependencies 和 node_modules
                if let Some(deps) = pkg.get("dependencies").and_then(|v| v.as_object()) {
                    let deps_count = deps.len();
                    passed.push(format!("package.json 声明了 {} 个依赖", deps_count));

                    // 检查 node_modules
                    let node_modules = skill_dir.join("node_modules");
                    if node_modules.exists() {
                        let missing = detect_missing_dependencies(
                            &deps.keys().cloned().collect::<Vec<_>>(),
                            &skill_dir,
                        );
                        if !missing.is_empty() {
                            warnings.push(serde_json::json!({
                                "level": "warning",
                                "code": "MISSING_NPM_DEPS",
                                "message": format!("缺少 {} 个 npm 依赖: {}", missing.len(), missing.join(", ")),
                                "missingDeps": missing,
                                "suggestion": "运行 npm install 安装依赖"
                            }));
                        } else {
                            passed.push("所有 npm 依赖已安装".to_string());
                        }
                    } else if deps_count > 0 {
                        issues.push(serde_json::json!({
                            "level": "error",
                            "code": "NODE_MODULES_MISSING",
                            "message": "package.json 声明了依赖但 node_modules 不存在",
                            "suggestion": "运行 npm install 安装依赖"
                        }));
                    }
                }
            } else {
                issues.push(serde_json::json!({
                    "level": "error",
                    "code": "INVALID_PACKAGE_JSON",
                    "message": "package.json 格式不正确",
                    "suggestion": "确保 package.json 是有效的 JSON 格式"
                }));
            }
        }
    }

    // 6. 检查常见的不应该存在的文件
    let unnecessary_files = ["README.md", "README.txt", "readme.md"];
    for file in unnecessary_files {
        let file_path = skill_dir.join(file);
        if file_path.exists() {
            warnings.push(serde_json::json!({
                "level": "warning",
                "code": "UNNECESSARY_FILE",
                "message": format!("发现不必要的文件: {}", file),
                "suggestion": "Skill 文档应放在 SKILL.md 中，删除 README.md"
            }));
        }
    }

    // 汇总结果
    let has_errors = !issues.is_empty();
    let is_valid = !has_errors;

    Ok(serde_json::json!({
        "name": name,
        "valid": is_valid,
        "summary": {
            "errors": issues.len(),
            "warnings": warnings.len(),
            "passed": passed.len()
        },
        "issues": issues,
        "warnings": warnings,
        "passed": passed,
        "validatedAt": chrono::Utc::now().to_rfc3339()
    }))
}

/// Public wrapper for extract_json, used by config.rs get_status_summary
pub fn extract_json_pub(text: &str) -> Option<Value> {
    extract_json(text)
}

/// Extract the first valid JSON object or array from a string that may contain
/// non-JSON lines (Node.js warnings, npm update prompts, ANSI codes, etc.)
fn extract_json(text: &str) -> Option<Value> {
    // Pre-processing: clean up common CLI output artifacts
    let cleaned = clean_cli_output(text);

    // Try parsing the whole string first (fast path)
    if let Ok(v) = serde_json::from_str::<Value>(&cleaned) {
        return Some(v);
    }

    // Find the first '{' or '[' and try parsing from there
    for (i, ch) in cleaned.char_indices() {
        if ch == '{' || ch == '[' {
            // Try direct parsing first
            if let Ok(v) = serde_json::from_str::<Value>(&cleaned[i..]) {
                return Some(v);
            }
            // Try with a streaming deserializer to handle trailing content
            let mut de = serde_json::Deserializer::from_str(&cleaned[i..]).into_iter::<Value>();
            if let Some(Ok(v)) = de.next() {
                return Some(v);
            }
        }
    }
    None
}

/// Clean up CLI output by removing common non-JSON artifacts:
/// - ANSI escape sequences (color codes)
/// - npm/node progress bars
/// - Multiple leading/trailing whitespace
/// - Debug log prefixes
fn clean_cli_output(text: &str) -> String {
    let mut result = text.to_string();

    // 1. Remove ANSI escape sequences
    // Common patterns: \x1b[...m, \x1b[...;...m, ESC[...m
    let ansi_regex = regex::Regex::new(r"\x1b\[[0-9;]*m").unwrap();
    result = ansi_regex.replace_all(&result, "").to_string();

    // 2. Remove npm/node progress bar characters
    // Pattern: ████░░░░░░ 50% | some info
    let progress_regex = regex::Regex::new(r"[█▓▒░│┼┤├┬┴]+[│].*?\r?\n").unwrap();
    result = progress_regex.replace_all(&result, "").to_string();

    // 3. Remove lines that are purely ANSI cursor control sequences
    // Like \r (carriage return for overwriting), \x1b[?25l (hide cursor), etc.
    let cursor_regex = regex::Regex::new(r"\x1b\[[?][0-9]+[a-zA-Z]").unwrap();
    result = cursor_regex.replace_all(&result, "").to_string();

    // 4. Remove "Download" / "Installing" progress prefixes common in npm
    let npm_progress_regex = regex::Regex::new(r"^\s*(added|removed|changed|up to date)?\s*\d+\s*(package)?s?\s*(in\s+\d+s)?\s*(✓|✔|:)?\s*\r?$").unwrap();
    result = npm_progress_regex.replace_all(&result, "").to_string();

    // 5. Normalize line endings and remove empty lines at the start
    let lines: Vec<&str> = result
        .lines()
        .map(|l| l.trim_end_matches(['\r', '\n']))
        .collect();

    // Skip leading empty/whitespace-only lines
    let start_idx = lines.iter().position(|l| !l.trim().is_empty()).unwrap_or(0);
    let relevant_lines = &lines[start_idx..];

    // 6. Find the first line that starts JSON and return from there to end
    for (i, line) in relevant_lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            return relevant_lines[i..].join("\n");
        }
    }

    // 7. Otherwise, rejoin and let extract_json handle it
    result
        .lines()
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 根据 agentId 解析该 Agent 的 workspace/skills 目录
/// 如果 agentId 为 None 或 "main"，返回 None（使用默认的 ~/.openclaw/skills）
fn resolve_agent_skills_dir(agent_id: Option<&str>) -> Option<std::path::PathBuf> {
    let id = agent_id
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "main")?;
    // 读取 openclaw.json 获取 agent workspace
    let config = super::config::load_openclaw_json().ok()?;
    let workspace = super::agent::find_agent_config(&config, id)
        .and_then(|agent| {
            agent
                .get("workspace")
                .and_then(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| {
            // 默认：~/.openclaw/agents/{id}/workspace
            super::openclaw_dir()
                .join("agents")
                .join(id)
                .join("workspace")
                .to_string_lossy()
                .to_string()
        });
    let expanded = super::agent::expand_user_path_pub(&workspace);
    Some(expanded.join("skills"))
}

fn custom_skill_roots_for_agent(
    agent_skills_dir: Option<&std::path::Path>,
) -> Vec<(std::path::PathBuf, &'static str)> {
    let mut roots = Vec::new();

    // 如果指定了 agent 的 skills 目录，优先放在第一位
    if let Some(agent_dir) = agent_skills_dir {
        roots.push((agent_dir.to_path_buf(), "Agent 自定义"));
    } else {
        // 默认 agent 使用全局 skills 目录
        roots.push((super::openclaw_dir().join("skills"), "OpenClaw 自定义"));
    }

    if let Some(home) = dirs::home_dir() {
        let claude_skills = home.join(".claude").join("skills");
        if !roots.iter().any(|(dir, _)| dir == &claude_skills) {
            roots.push((claude_skills, "Claude 自定义"));
        }
    }
    // 从已解析的 CLI 路径推导 npm 包内的 bundled skills 目录
    if let Some(cli_path) = crate::utils::resolve_openclaw_cli_path() {
        let cli = std::path::PathBuf::from(&cli_path);
        let cli = std::fs::canonicalize(&cli).unwrap_or(cli);
        for pkg_root in [cli.parent(), cli.parent().and_then(|p| p.parent())]
            .into_iter()
            .flatten()
        {
            let bundled = pkg_root.join("skills");
            if bundled.is_dir() && !roots.iter().any(|(dir, _)| dir == &bundled) {
                roots.push((bundled, "OpenClaw 内置"));
                break;
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(prefix) = super::windows_npm_global_prefix() {
        for pkg in ["openclaw", "@qingchencloud/openclaw-zh"] {
            let bundled = std::path::PathBuf::from(&prefix)
                .join("node_modules")
                .join(pkg)
                .join("skills");
            if bundled.is_dir() && !roots.iter().any(|(dir, _)| dir == &bundled) {
                roots.push((bundled, "OpenClaw 内置"));
            }
        }
    }
    roots
}

fn resolve_custom_skill_dir_with_agent(
    name: &str,
    agent_skills_dir: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    custom_skill_roots_for_agent(agent_skills_dir)
        .into_iter()
        .map(|(root, _)| root.join(name))
        .find(|path| path.exists())
}

fn scan_custom_skill_detail(
    name: &str,
    agent_skills_dir: Option<&std::path::Path>,
) -> Option<Value> {
    for (root, source_label) in custom_skill_roots_for_agent(agent_skills_dir) {
        let skill_path = root.join(name);
        if !skill_path.exists() {
            continue;
        }

        let base = scan_single_skill(&skill_path, name);
        let missing_deps = base
            .get("missingDeps")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let eligible = base.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut detail = serde_json::json!({
            "name": name,
            "description": base.get("description").cloned().unwrap_or(Value::String(String::new())),
            "emoji": base.get("emoji").cloned().unwrap_or(Value::String("🧩".to_string())),
            "eligible": eligible,
            "disabled": false,
            "blockedByAllowlist": false,
            "source": source_label,
            "bundled": false,
            "filePath": skill_path.to_string_lossy().to_string(),
            "homepage": base.get("homepage").cloned().unwrap_or(Value::Null),
            "version": base.get("version").cloned().unwrap_or(Value::Null),
            "author": base.get("author").cloned().unwrap_or(Value::Null),
            "dependencies": base.get("dependencies").cloned().unwrap_or(Value::Array(vec![])),
            "missingDeps": Value::Array(missing_deps.clone()),
            "missing": {
                "bins": [],
                "anyBins": [],
                "env": [],
                "config": [],
                "os": []
            },
            "requirements": {
                "bins": [],
                "env": [],
                "config": []
            },
            "install": []
        });

        if let Some(full_path) = base.get("fullPath").cloned() {
            detail["fullPath"] = full_path;
        }

        return Some(detail);
    }
    None
}

fn scan_local_skill_entries_for_agent(
    agent_skills_dir: Option<&std::path::Path>,
) -> Result<Vec<Value>, String> {
    let mut skills = Vec::new();

    for (skills_dir, source_label) in custom_skill_roots_for_agent(agent_skills_dir) {
        if !skills_dir.exists() {
            continue;
        }

        let entries = std::fs::read_dir(&skills_dir).map_err(|e| {
            format!(
                "读取 Skills 目录失败 ({}): {e}",
                skills_dir.to_string_lossy()
            )
        })?;

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() && !file_type.is_symlink() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let base = scan_single_skill(&entry.path(), &name);
            let eligible = base.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut item = serde_json::json!({
                "name": name,
                "description": base.get("description").cloned().unwrap_or(Value::String(String::new())),
                "emoji": base.get("emoji").cloned().unwrap_or(Value::String("🧩".to_string())),
                "eligible": eligible,
                "disabled": false,
                "blockedByAllowlist": false,
                "source": source_label,
                "bundled": false,
                "filePath": entry.path().to_string_lossy().to_string(),
                "homepage": base.get("homepage").cloned().unwrap_or(Value::Null),
                "missing": {
                    "bins": [],
                    "anyBins": [],
                    "env": [],
                    "config": [],
                    "os": []
                },
                "missingDeps": base.get("missingDeps").cloned().unwrap_or(Value::Array(vec![])),
                "install": []
            });

            if let Some(full_path) = base.get("fullPath").cloned() {
                item["fullPath"] = full_path;
            }

            skills.push(item);
        }
    }

    skills.sort_by(|a, b| {
        let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        an.cmp(bn)
    });

    Ok(skills)
}

fn scan_local_skill_entries() -> Result<Vec<Value>, String> {
    scan_local_skill_entries_for_agent(None)
}

/// CLI 不可用或当前结果不可用时的兜底：扫描本地自定义 Skills 目录
fn scan_local_skills(
    cli_diagnostic: Option<Value>,
    agent_skills_dir: Option<&std::path::Path>,
) -> Result<Value, String> {
    let roots = custom_skill_roots_for_agent(agent_skills_dir);
    let scanned_roots: Vec<String> = roots
        .iter()
        .map(|(dir, label)| format!("{}: {}", label, dir.to_string_lossy()))
        .collect();
    let skills = scan_local_skill_entries_for_agent(agent_skills_dir)?;
    let cli_available = cli_diagnostic
        .as_ref()
        .and_then(|v| v.get("cliAvailable"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if skills.is_empty() {
        return Ok(serde_json::json!({
            "skills": [],
            "source": "local-scan",
            "cliAvailable": cli_available,
            "diagnostic": {
                "status": cli_diagnostic.as_ref().and_then(|v| v.get("status")).and_then(|v| v.as_str()).unwrap_or("no-skills-dir"),
                "message": "未在本地自定义目录中发现 Skills",
                "scannedRoots": scanned_roots,
                "cli": cli_diagnostic
            }
        }));
    }

    // 统计信息
    let total = skills.len();
    let ready_count = skills
        .iter()
        .filter(|s| s.get("eligible").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();
    let missing_deps_count = skills
        .iter()
        .filter(|s| !s.get("eligible").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();

    Ok(serde_json::json!({
        "skills": skills,
        "source": "local-scan",
        "cliAvailable": cli_available,
        "summary": {
            "total": total,
            "ready": ready_count,
            "missingDeps": missing_deps_count,
        },
        "diagnostic": {
            "status": cli_diagnostic.as_ref().and_then(|v| v.get("status")).and_then(|v| v.as_str()).unwrap_or("scanned"),
            "scannedAt": chrono::Utc::now().to_rfc3339(),
            "scannedRoots": scanned_roots,
            "cli": cli_diagnostic
        }
    }))
}

/// 扫描单个 Skill 的详细信息
fn scan_single_skill(skill_path: &std::path::Path, name: &str) -> Value {
    let mut result = serde_json::json!({
        "name": name,
        "source": "managed",
        "bundled": false,
        "filePath": skill_path.to_string_lossy(),
        "ready": false,
        "missingDeps": [],
        "installedDeps": [],
    });

    // 1. 检查必要文件
    let skill_md = skill_path.join("SKILL.md");
    let package_json = skill_path.join("package.json");

    let has_skill_md = skill_md.exists();
    let has_package_json = package_json.exists();

    result["hasSkillMd"] = Value::Bool(has_skill_md);
    result["hasPackageJson"] = Value::Bool(has_package_json);

    // 2. 解析 package.json 获取更多信息
    if has_package_json {
        if let Ok(pkg_content) = std::fs::read_to_string(&package_json) {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&pkg_content) {
                // 提取基本信息
                if let Some(version) = pkg.get("version").and_then(|v| v.as_str()) {
                    result["version"] = Value::String(version.to_string());
                }
                if let Some(author) = pkg.get("author").and_then(|v| {
                    v.as_str().or_else(|| {
                        v.as_object()
                            .and_then(|o| o.get("name").and_then(|n| n.as_str()))
                    })
                }) {
                    result["author"] = Value::String(author.to_string());
                }
                if let Some(desc) = pkg.get("description").and_then(|v| v.as_str()) {
                    result["description"] = Value::String(desc.to_string());
                }
                if let Some(homepage) = pkg.get("homepage").and_then(|v| v.as_str()) {
                    result["homepage"] = Value::String(homepage.to_string());
                }

                // 提取 dependencies
                if let Some(deps) = pkg.get("dependencies").and_then(|v| v.as_object()) {
                    let deps_list: Vec<String> = deps.keys().cloned().collect();
                    result["dependencies"] =
                        Value::Array(deps_list.iter().map(|s| Value::String(s.clone())).collect());

                    // 检测缺少的依赖（简化版：通过检查 node_modules）
                    let missing_deps = detect_missing_dependencies(&deps_list, skill_path);
                    result["missingDeps"] = Value::Array(
                        missing_deps
                            .iter()
                            .map(|s| Value::String(s.clone()))
                            .collect(),
                    );
                    result["installedDeps"] = Value::Array(
                        deps_list
                            .iter()
                            .filter(|d| !missing_deps.contains(d))
                            .map(|s| Value::String(s.clone()))
                            .collect(),
                    );
                }

                // 提取 scripts（可能包含 install 后处理等）
                if let Some(scripts) = pkg.get("scripts").and_then(|v| v.as_object()) {
                    let script_names: Vec<String> = scripts.keys().cloned().collect();
                    result["scripts"] = Value::Array(
                        script_names
                            .iter()
                            .map(|s| Value::String(s.clone()))
                            .collect(),
                    );
                }
            }
        }
    }

    // 3. 从 SKILL.md frontmatter 提取额外信息
    if has_skill_md {
        if let Some(frontmatter) = parse_skill_frontmatter(&skill_md) {
            // 覆盖或补充 description（SKILL.md 的 description 更权威）
            if let Some(desc) = frontmatter.get("description").and_then(|v| v.as_str()) {
                result["description"] = Value::String(desc.to_string());
            }
            if let Some(full_path) = frontmatter.get("fullPath").and_then(|v| v.as_str()) {
                result["fullPath"] = Value::String(full_path.to_string());
            }
        }
    }

    // 4. 判断 ready 状态
    // Skill ready 需要：1) 有 SKILL.md  2) 没有缺少依赖  3) 依赖已安装
    let has_all_deps = result["missingDeps"]
        .as_array()
        .map(|a| a.is_empty())
        .unwrap_or(true);
    let has_essential_files = has_skill_md;
    result["ready"] = Value::Bool(has_essential_files && has_all_deps);

    // 5. 检测是否有 node_modules（npm 包已安装）
    let node_modules = skill_path.join("node_modules");
    result["nodeModulesInstalled"] = Value::Bool(node_modules.exists());

    result
}

/// 检测缺少的依赖
fn detect_missing_dependencies(deps: &[String], skill_path: &std::path::Path) -> Vec<String> {
    let node_modules = skill_path.join("node_modules");
    if !node_modules.exists() {
        // node_modules 不存在，所有依赖都算缺失
        return deps.to_vec();
    }

    let mut missing = Vec::new();
    for dep in deps {
        let dep_path = node_modules.join(dep);
        // 检查依赖目录或 @scope/package 格式
        if !dep_path.exists() {
            // 可能是 @scope/package 格式，直接检查目录
            missing.push(dep.clone());
        }
    }
    missing
}

/// 解析 SKILL.md frontmatter，返回键值对
fn parse_skill_frontmatter(path: &std::path::Path) -> Option<Value> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return None,
    };

    // frontmatter 格式: ---\n...\n---
    if !content.starts_with("---") {
        return None;
    }

    let after_first = content[3..].find("---")?;

    let fm_content = &content[3..3 + after_first];
    let mut fm_map = serde_json::Map::new();

    for line in fm_content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains(':') {
            continue;
        }

        if let Some(colon_pos) = trimmed.find(':') {
            let key = trimmed[..colon_pos].trim().to_string();
            let value = trimmed[colon_pos + 1..].trim();

            // 处理引号包裹的值
            let clean_value = value.trim_matches('"').trim_matches('\'').trim();

            if !key.is_empty() && !clean_value.is_empty() {
                fm_map.insert(key, Value::String(clean_value.to_string()));
            }
        }
    }

    if fm_map.is_empty() {
        None
    } else {
        Some(Value::Object(fm_map))
    }
}
