//! 系统浏览器 launcher 的有界观测；仅返回固定错误，不记录授权地址。
use std::{
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const OBSERVATION_LIMIT: Duration = Duration::from_secs(5);
const CANDIDATE_LIMIT: Duration = Duration::from_millis(1500);
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const UNAVAILABLE: &str = "platform_browser_unavailable";

fn reap(mut child: Child) {
    // 部分桌面 launcher 随浏览器长期运行；交付后只回收，不结束或重复启动它。
    let _ = thread::Builder::new()
        .name("platform-browser-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        });
}

pub(super) fn dispatch_commands(commands: Vec<Command>) -> Result<(), String> {
    let deadline = Instant::now() + OBSERVATION_LIMIT;
    for mut command in commands {
        if Instant::now() >= deadline {
            return Err(UNAVAILABLE.into());
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            // Windows 生产使用 ShellExecute；此分支仅供独立通用子进程验收。
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => continue,
        };
        let candidate_deadline = (Instant::now() + CANDIDATE_LIMIT).min(deadline);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(_) => {
                    // 无法确定原进程状态时不再打开另一个候选，避免重复页面。
                    reap(child);
                    return Err(UNAVAILABLE.into());
                }
            }
            let remaining = candidate_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                // 已交付不等于网页已显示；授权是否完成仍以原 loopback 回调为准。
                reap(child);
                return Ok(());
            }
            thread::sleep(POLL_INTERVAL.min(remaining));
        }
    }
    Err(UNAVAILABLE.into())
}
