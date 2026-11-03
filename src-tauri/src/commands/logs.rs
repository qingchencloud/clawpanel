/// 日志读取命令
/// 使用 BufReader + Seek 避免 OOM，限制最大读取量
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;

fn log_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".openclaw")
        .join("logs")
}

fn log_path(log_name: &str) -> PathBuf {
    let filename = match log_name {
        "gateway" => "gateway.log",
        "gateway-err" => "gateway.err.log",
        "guardian" => "guardian.log",
        "guardian-backup" => "guardian-backup.log",
        "config-audit" => "config-audit.jsonl",
        _ => "gateway.log",
    };
    log_dir().join(filename)
}

#[tauri::command]
pub fn read_log_tail(log_name: String, lines: Option<u32>) -> Result<String, String> {
    let lines = lines.unwrap_or(200) as usize;
    let path = log_path(&log_name);
    if !path.exists() {
        return Ok(String::new());
    }

    let mut file = fs::File::open(&path).map_err(|e| format!("打开日志失败: {e}"))?;

    let file_len = file
        .metadata()
        .map_err(|e| format!("获取文件元数据失败: {e}"))?
        .len();

    // 最多从尾部读取 1MB，避免 OOM
    let max_read: u64 = 1024 * 1024;
    let start_pos = file_len.saturating_sub(max_read);

    file.seek(SeekFrom::Start(start_pos))
        .map_err(|e| format!("Seek 失败: {e}"))?;

    let mut raw = Vec::new();
    file.read_to_end(&mut raw)
        .map_err(|e| format!("读取日志失败: {e}"))?;
    let buf = crate::utils::decode_text(&raw);

    let mut all_lines: Vec<&str> = buf.lines().collect();

    // 如果从中间开始读，第一行可能不完整，跳过
    if start_pos > 0 && all_lines.len() > 1 {
        all_lines.remove(0);
    }

    // 取最后 N 行
    let start = if all_lines.len() > lines {
        all_lines.len() - lines
    } else {
        0
    };

    Ok(all_lines[start..].join("\n"))
}

#[tauri::command]
pub fn search_log(
    log_name: String,
    query: String,
    max_results: Option<u32>,
) -> Result<Vec<String>, String> {
    let max_results = max_results.unwrap_or(50) as usize;
    let path = log_path(&log_name);
    if !path.exists() {
        return Ok(vec![]);
    }

    let mut file = fs::File::open(&path).map_err(|e| format!("打开日志失败: {e}"))?;

    let file_len = file
        .metadata()
        .map_err(|e| format!("获取文件元数据失败: {e}"))?
        .len();

    // 搜索最多读取尾部 2MB，避免 OOM，同时保证搜索最新内容
    let max_read: u64 = 2 * 1024 * 1024;
    let start_pos = file_len.saturating_sub(max_read);

    file.seek(SeekFrom::Start(start_pos))
        .map_err(|e| format!("Seek 失败: {e}"))?;

    let reader = BufReader::new(file);
    let query_lower = query.to_lowercase();

    let mut matched: Vec<String> = reader
        .lines()
        .map_while(Result::ok)
        .filter(|l| l.to_lowercase().contains(&query_lower))
        .collect();

    // 如果从中间开始读，第一条匹配可能是不完整行，跳过
    if start_pos > 0 && !matched.is_empty() {
        matched.remove(0);
    }

    // 取最后 N 条（最新的匹配结果）
    let start = if matched.len() > max_results {
        matched.len() - max_results
    } else {
        0
    };

    Ok(matched[start..].to_vec())
}
