use command_group::{CommandGroup, GroupChild};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

pub(super) type Handle = Arc<Mutex<GroupChild>>;

#[derive(Default)]
struct Registry {
    children: HashMap<(PathBuf, u16), Handle>,
    uninstalling: HashSet<PathBuf>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Default::default);

// Windows CLI 包装器可能派生实际监听的 Python；自创建起将它们放在专属 Job 中。
// Unix 对应使用独立进程组。两端均只通过本次 spawn 返回的句柄停止。
pub(super) fn spawn(cmd: &mut std::process::Command) -> Result<GroupChild, String> {
    let mut group = cmd.group();
    #[cfg(windows)]
    group.creation_flags(super::CREATE_NO_WINDOW);
    group
        .spawn()
        .map_err(|e| format!("spawn hermes dashboard failed: {e}"))
}

pub(super) fn get_or_spawn(
    home: &Path,
    port: u16,
    launch: impl FnOnce() -> Result<GroupChild, String>,
) -> Result<(Handle, bool), String> {
    let mut registry = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if registry.uninstalling.contains(home) {
        return Err("Hermes 正在卸载，无法启动 Dashboard".into());
    }
    let key = (home.to_owned(), port);
    if let Some(child) = registry.children.get(&key) {
        if child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok((Arc::clone(child), false));
        }
        registry.children.remove(&key);
    }
    let child = Arc::new(Mutex::new(launch()?));
    registry.children.insert(key, Arc::clone(&child));
    Ok((child, true))
}

pub(super) fn forget_exited(home: &Path, port: u16, child: &Handle) {
    let mut registry = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let key = (home.to_owned(), port);
    if registry
        .children
        .get(&key)
        .is_some_and(|registered| Arc::ptr_eq(registered, child))
    {
        registry.children.remove(&key);
    }
}

// 即使启动调用已经就绪、超时或被取消，也回收自然退出的子进程。
pub(super) fn watch_exit(home: PathBuf, port: u16, child: Handle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let status = child.lock().unwrap_or_else(|e| e.into_inner()).try_wait();
            match status {
                Ok(None) => continue,
                Ok(Some(_)) => forget_exited(&home, port, &child),
                Err(error) => eprintln!("[Hermes Dashboard] 读取子进程状态失败: {error}"),
            }
            break;
        }
    });
}

fn stop_registered(registry: &mut Registry, key: &(PathBuf, u16)) -> Result<bool, String> {
    let Some(handle) = registry.children.get(key) else {
        return Ok(false);
    };
    let stopped = {
        let mut child = handle.lock().unwrap_or_else(|e| e.into_inner());
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            false
        } else {
            match child.kill() {
                Ok(()) => {
                    child.wait().map_err(|e| e.to_string())?;
                    true
                }
                Err(error) if child.try_wait().map_err(|e| e.to_string())?.is_none() => {
                    return Err(format!("停止 Hermes Dashboard 失败: {error}"))
                }
                Err(_) => false,
            }
        }
    };
    registry.children.remove(key);
    Ok(stopped)
}

pub(super) fn stop(home: &Path, port: u16) -> Result<bool, String> {
    let mut registry = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    stop_registered(&mut registry, &(home.to_owned(), port))
}

pub(super) struct UninstallGuard(PathBuf);
impl Drop for UninstallGuard {
    fn drop(&mut self) {
        REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .uninstalling
            .remove(&self.0);
    }
}

pub(super) fn begin_uninstall(home: &Path) -> Result<UninstallGuard, String> {
    let mut registry = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if registry.uninstalling.contains(home) {
        return Err("Hermes 已在卸载".into());
    }
    let keys: Vec<_> = registry
        .children
        .keys()
        .filter(|(owner, _)| owner == home)
        .cloned()
        .collect();
    for key in keys {
        stop_registered(&mut registry, &key)?;
    }
    registry.uninstalling.insert(home.to_owned());
    Ok(UninstallGuard(home.to_owned()))
}

#[cfg(test)]
mod tests;
