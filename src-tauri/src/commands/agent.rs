/// Agent 管理命令 — 列表/改名直接读写 openclaw.json；创建/删除走 CLI（需要创建 workspace 等文件）
use crate::utils::openclaw_command_async;
use serde_json::Value;
use std::fs;
use std::io::Write;

/// 获取 agent 列表（直接读配置文件，不走 CLI，毫秒级响应）
#[tauri::command]
pub async fn list_agents() -> Result<Value, String> {
    let config_path = super::openclaw_config_path();
    if !config_path.exists() {
        return Err("配置文件不存在，请先安装 OpenClaw".to_string());
    }
    let content = fs::read_to_string(&config_path).map_err(|e| format!("读取配置失败: {e}"))?;
    let config: Value =
        serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {e}"))?;

    let agents_list = config
        .get("agents")
        .and_then(|a| a.get("list"))
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();

    // 补全 main agent 的 workspace（config 中可能没有显式指定）
    let default_workspace = config
        .get("agents")
        .and_then(|a| a.get("defaults"))
        .and_then(|d| d.get("workspace"))
        .and_then(|w| w.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            super::openclaw_dir()
                .join("workspace")
                .to_string_lossy()
                .to_string()
        });

    // main agent 是隐式的（不在 agents.list 中），始终插入
    let has_main = agents_list
        .iter()
        .any(|a| a.get("id").and_then(|v| v.as_str()) == Some("main"));
    let all_agents = if has_main {
        agents_list
    } else {
        let mut v = vec![serde_json::json!({
            "id": "main",
            "isDefault": true,
            "workspace": default_workspace.clone(),
        })];
        v.extend(agents_list);
        v
    };

    let enriched: Vec<Value> = all_agents
        .into_iter()
        .map(|mut agent| {
            let id = agent
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // 补全 workspace 路径
            if agent.get("workspace").and_then(|w| w.as_str()).is_none()
                || agent.get("workspace").and_then(|w| w.as_str()) == Some("")
            {
                if id == "main" {
                    agent.as_object_mut().map(|o| {
                        o.insert(
                            "workspace".to_string(),
                            Value::String(default_workspace.clone()),
                        )
                    });
                } else {
                    let ws = super::openclaw_dir()
                        .join("agents")
                        .join(&id)
                        .join("workspace")
                        .to_string_lossy()
                        .to_string();
                    agent
                        .as_object_mut()
                        .map(|o| o.insert("workspace".to_string(), Value::String(ws)));
                }
            }
            // 补全 identityName 用于前端显示
            let identity_name = agent
                .get("identity")
                .and_then(|i| i.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            if !identity_name.is_empty() {
                agent
                    .as_object_mut()
                    .map(|o| o.insert("identityName".to_string(), Value::String(identity_name)));
            }
            agent
        })
        .collect();

    Ok(Value::Array(enriched))
}

/// 创建新 agent（走 CLI，自动创建 workspace/sessions 等文件）
#[tauri::command]
pub async fn add_agent(
    name: String,
    model: String,
    workspace: Option<String>,
) -> Result<Value, String> {
    let ws = match workspace {
        Some(ref w) if !w.is_empty() => std::path::PathBuf::from(w),
        _ => super::openclaw_dir()
            .join("agents")
            .join(&name)
            .join("workspace"),
    };

    let mut args = vec![
        "agents".to_string(),
        "add".to_string(),
        name.clone(),
        "--non-interactive".to_string(),
        "--workspace".to_string(),
        ws.to_string_lossy().to_string(),
    ];

    if !model.is_empty() {
        args.push("--model".to_string());
        args.push(model);
    }

    let output = openclaw_command_async()
        .args(&args)
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "OpenClaw CLI 未找到，请确认已安装并重启 ClawPanel。".to_string()
            } else {
                format!("执行失败: {e}")
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("创建 Agent 失败: {stderr}"));
    }

    list_agents().await
}

/// 删除 agent（直接操作 openclaw.json + 删除 agent 目录，不走 CLI）
#[tauri::command]
pub async fn delete_agent(id: String) -> Result<String, String> {
    if id == "main" {
        return Err("不能删除默认 Agent".into());
    }

    // 1. 从 openclaw.json 的 agents.list 中移除
    let config_path = super::openclaw_dir().join("openclaw.json");
    if config_path.exists() {
        let content = fs::read_to_string(&config_path).map_err(|e| format!("读取配置失败: {e}"))?;
        let mut config: Value =
            serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {e}"))?;
        if let Some(list) = config
            .get_mut("agents")
            .and_then(|a| a.get_mut("list"))
            .and_then(|l| l.as_array_mut())
        {
            list.retain(|a| a.get("id").and_then(|v| v.as_str()) != Some(&id));
        }
        // 同时清理 agents.profiles 中的配置
        if let Some(profiles) = config
            .get_mut("agents")
            .and_then(|a| a.get_mut("profiles"))
            .and_then(|p| p.as_object_mut())
        {
            profiles.remove(&id);
        }
        // 备份 + 写回
        let bak = super::openclaw_dir().join("openclaw.json.bak");
        let _ = fs::copy(&config_path, &bak);
        let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
        fs::write(&config_path, &json).map_err(|e| format!("写入失败: {e}"))?;
    }

    // 2. 删除 agent 目录（workspace + sessions 等）
    let agent_dir = super::openclaw_dir().join("agents").join(&id);
    if agent_dir.exists() {
        let _ = fs::remove_dir_all(&agent_dir);
    }

    Ok("已删除".into())
}

/// 更新 agent 身份信息
#[tauri::command]
pub fn update_agent_identity(
    id: String,
    name: Option<String>,
    emoji: Option<String>,
) -> Result<String, String> {
    let path = super::openclaw_config_path();
    let content = fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    let mut config: Value =
        serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {e}"))?;

    let agents_list = config
        .get_mut("agents")
        .and_then(|a| a.get_mut("list"))
        .and_then(|l| l.as_array_mut())
        .ok_or("配置格式错误")?;

    let agent = agents_list
        .iter_mut()
        .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(&id))
        .ok_or(format!("Agent「{id}」不存在"))?;

    // 确保 identity 字段存在且为对象
    if agent.get("identity").and_then(|i| i.as_object()).is_none() {
        agent
            .as_object_mut()
            .ok_or("Agent 格式错误")?
            .insert("identity".to_string(), serde_json::json!({}));
    }

    let identity = agent
        .get_mut("identity")
        .and_then(|i| i.as_object_mut())
        .ok_or("identity 格式错误")?;

    if let Some(n) = name {
        if !n.is_empty() {
            identity.insert("name".to_string(), Value::String(n));
        }
    }
    if let Some(e) = emoji {
        if !e.is_empty() {
            identity.insert("emoji".to_string(), Value::String(e));
        }
    }

    // 提前提取 workspace 路径（克隆为 String，避免借用冲突）
    let workspace_path = agent
        .get("workspace")
        .and_then(|w| w.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            config
                .get("agents")
                .and_then(|a| a.get("defaults"))
                .and_then(|d| d.get("workspace"))
                .and_then(|w| w.as_str())
                .map(|s| s.to_string())
        });

    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入配置失败: {e}"))?;

    // 删除 IDENTITY.md 文件，让配置文件生效
    if let Some(ws_str) = workspace_path {
        let identity_file = std::path::PathBuf::from(ws_str).join("IDENTITY.md");
        if identity_file.exists() {
            let _ = fs::remove_file(&identity_file);
        }
    }

    Ok("已更新".into())
}

/// 备份 agent 数据（agent 配置 + 会话记录）打包为 zip
#[tauri::command]
pub fn backup_agent(id: String) -> Result<String, String> {
    let agent_dir = super::openclaw_dir().join("agents").join(&id);
    if !agent_dir.exists() {
        return Err(format!("Agent「{id}」数据目录不存在"));
    }

    let tmp_dir = std::env::temp_dir();
    let now = chrono::Local::now();
    let zip_name = format!("agent-{}-{}.zip", id, now.format("%Y%m%d-%H%M%S"));
    let zip_path = tmp_dir.join(&zip_name);

    let file = fs::File::create(&zip_path).map_err(|e| format!("创建 zip 失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    collect_dir_to_zip(&agent_dir, &agent_dir, &mut zip, options)?;

    zip.finish().map_err(|e| format!("完成 zip 失败: {e}"))?;
    Ok(zip_path.to_string_lossy().to_string())
}

fn collect_dir_to_zip(
    base: &std::path::Path,
    dir: &std::path::Path,
    zip: &mut zip::ZipWriter<fs::File>,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        if path.is_dir() {
            collect_dir_to_zip(base, &path, zip, options)?;
        } else {
            let content = fs::read(&path).map_err(|e| format!("读取 {rel} 失败: {e}"))?;
            zip.start_file(&rel, options)
                .map_err(|e| format!("写入 zip 失败: {e}"))?;
            zip.write_all(&content)
                .map_err(|e| format!("写入内容失败: {e}"))?;
        }
    }
    Ok(())
}

/// 更新 agent 模型配置
#[tauri::command]
pub fn update_agent_model(id: String, model: String) -> Result<String, String> {
    let path = super::openclaw_config_path();
    let content = fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    let mut config: Value =
        serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {e}"))?;

    let agents_list = config
        .get_mut("agents")
        .and_then(|a| a.get_mut("list"))
        .and_then(|l| l.as_array_mut())
        .ok_or("配置格式错误")?;

    let agent = agents_list
        .iter_mut()
        .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(&id))
        .ok_or(format!("Agent「{id}」不存在"))?;

    let model_obj = serde_json::json!({ "primary": model });
    agent
        .as_object_mut()
        .ok_or("Agent 格式错误")?
        .insert("model".to_string(), model_obj);

    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入配置失败: {e}"))?;

    Ok("已更新".into())
}
