//! SkillHub SDK — 纯 HTTP + zip 操作，不依赖 Tauri 框架。
//! 供 skills.rs Tauri 命令层薄包装调用。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const COS_BASE: &str = "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com";
const API_BASE: &str = "https://lightmake.site/api/v1";
const INDEX_TTL: Duration = Duration::from_secs(600); // 10 分钟缓存

// ── 数据结构 ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillHubItem {
    pub slug: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, alias = "displayName")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub categories: Option<Vec<String>>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub downloads: Option<u64>,
    #[serde(default)]
    pub stars: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    results: Vec<SkillHubItem>,
}

#[derive(Debug, Deserialize)]
struct IndexResponse {
    #[serde(default)]
    skills: Vec<SkillHubItem>,
}

// ── 全量索引缓存 ──────────────────────────────────────────

static INDEX_CACHE: Mutex<Option<(Instant, Vec<SkillHubItem>)>> = Mutex::new(None);

// ── HTTP 客户端 ──────────────────────────────────────────

fn client() -> Result<reqwest::Client, String> {
    super::build_http_client(Duration::from_secs(30), Some("ClawPanel-SkillHub/1.0"))
}

// ── 公开接口 ──────────────────────────────────────────────

/// 搜索 SkillHub
pub async fn search(query: &str, limit: u32) -> Result<Vec<SkillHubItem>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let url = format!(
        "{}/search?q={}&limit={}",
        API_BASE,
        urlencoding::encode(q),
        limit
    );
    let resp = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("SkillHub 搜索请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("SkillHub 搜索失败: HTTP {}", resp.status()));
    }
    let data: SearchResponse = resp
        .json()
        .await
        .map_err(|e| format!("SkillHub 搜索结果解析失败: {e}"))?;
    Ok(data.results)
}

/// 拉取全量索引（带 10 分钟内存缓存）
pub async fn fetch_index() -> Result<Vec<SkillHubItem>, String> {
    // 命中缓存
    if let Ok(guard) = INDEX_CACHE.lock() {
        if let Some((ts, ref items)) = *guard {
            if ts.elapsed() < INDEX_TTL {
                return Ok(items.clone());
            }
        }
    }
    // 拉取远程索引
    let url = format!("{}/skills.json", COS_BASE);
    let resp = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("拉取技能索引失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取技能索引失败: HTTP {}", resp.status()));
    }
    let data: IndexResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析技能索引失败: {e}"))?;
    let items = data.skills;
    // 写入缓存
    if let Ok(mut guard) = INDEX_CACHE.lock() {
        *guard = Some((Instant::now(), items.clone()));
    }
    Ok(items)
}

/// 下载 Skill zip（COS 镜像优先，回退主站 API）
pub async fn download_zip(slug: &str) -> Result<Vec<u8>, String> {
    let c = client()?;
    // 1. 优先 COS 镜像（国内 CDN）
    let cos_url = format!("{}/skills/{}.zip", COS_BASE, slug);
    match c.get(&cos_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            return resp
                .bytes()
                .await
                .map(|b| b.to_vec())
                .map_err(|e| format!("COS 下载读取失败: {e}"));
        }
        _ => {}
    }
    // 2. 回退主站 API
    let api_url = format!("{}/download?slug={}", API_BASE, urlencoding::encode(slug));
    let resp = c
        .get(&api_url)
        .send()
        .await
        .map_err(|e| format!("主站下载请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("下载读取失败: {e}"))
}

/// 下载并安装 Skill：zip → 解压到 skills_dir/{slug}/
pub async fn install(slug: &str, skills_dir: &Path) -> Result<PathBuf, String> {
    validate_slug(slug)?;
    let target_dir = skills_dir.join(slug);
    let zip_bytes = download_zip(slug).await?;
    extract_zip(&zip_bytes, &target_dir)?;
    Ok(target_dir)
}

// ── 内部工具 ──────────────────────────────────────────────

/// 校验 slug 安全性
fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() {
        return Err("Skill slug 不能为空".into());
    }
    if slug.contains("..") || slug.contains('/') || slug.contains('\\') {
        return Err(format!("无效的 Skill slug: {slug}"));
    }
    Ok(())
}

/// 将 zip 字节解压到目标目录
fn extract_zip(zip_bytes: &[u8], target_dir: &Path) -> Result<(), String> {
    use std::io::Cursor;
    use zip::ZipArchive;

    // 清理旧目录
    if target_dir.exists() {
        std::fs::remove_dir_all(target_dir).map_err(|e| format!("清理旧目录失败: {e}"))?;
    }
    std::fs::create_dir_all(target_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let reader = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("打开 zip 失败: {e}"))?;

    // 收集所有文件名，检测是否都在同一个顶层目录下（常见的 zip 打包方式）
    let names = archive
        .file_names()
        .map(|name| name.map(|name| name.into_owned()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("zip 条目名称无效: {e}"))?;
    let strip_prefix = detect_single_root_dir(&names);

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;

        let raw_name = file
            .name()
            .map_err(|e| format!("zip 条目名称无效: {e}"))?
            .into_owned();
        // 安全检查：防止路径穿越
        if file.enclosed_name().is_none() || raw_name.contains("..") {
            continue;
        }

        // 如果 zip 内有单一根目录，剥掉它
        let relative = if let Some(ref prefix) = strip_prefix {
            match raw_name.strip_prefix(prefix.as_str()) {
                Some(rest) if !rest.is_empty() => rest,
                _ => continue, // 跳过根目录本身
            }
        } else {
            raw_name.as_str()
        };

        if relative.is_empty()
            || !Path::new(relative)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
        {
            continue;
        }

        let out_path = target_dir.join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(&out_path).ok();
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut outfile = std::fs::File::create(&out_path)
                .map_err(|e| format!("创建文件失败 {relative}: {e}"))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("写入文件失败 {relative}: {e}"))?;
        }
    }
    Ok(())
}

/// 检测 zip 是否有单一顶层目录（如 `skill-name/...`），返回要剥掉的前缀
fn detect_single_root_dir(names: &[String]) -> Option<String> {
    let (root, _) = names.first()?.split_once('/')?;
    if root.is_empty() {
        return None;
    }
    let prefix = format!("{root}/");
    names
        .iter()
        .all(|name| name.starts_with(&prefix))
        .then_some(prefix)
}
