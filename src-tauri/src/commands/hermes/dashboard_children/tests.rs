use super::*;
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

// 先覆盖真实端口和进程的失败条件：两个启动者竞争、自然退出后同端口被外部占用、
// 手动停止与卸载时隔离 HOME 和端口，以及旧等待者不能删除新的子进程。
fn fixture_command(port: u16, control: &Path) -> std::process::Command {
    let mut cmd = crate::utils::background_command(std::env::current_exe().unwrap());
    cmd.args([
        "--exact",
        "commands::hermes::dashboard_children::tests::fixture_child",
        "--nocapture",
    ])
    .env("CLAWPANEL_DASHBOARD_TEST_PORT", port.to_string())
    .env("CLAWPANEL_DASHBOARD_TEST_EXIT", control)
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    cmd
}

#[test]
fn fixture_child() {
    let Ok(raw) = std::env::var("CLAWPANEL_DASHBOARD_TEST_PORT") else {
        return;
    };
    let control = PathBuf::from(std::env::var_os("CLAWPANEL_DASHBOARD_TEST_EXIT").unwrap());
    let port = raw.parse::<u16>().unwrap();
    // 模拟实际 CLI 包装器：它一直等待真正提供监听服务的子进程。
    if std::env::var_os("CLAWPANEL_DASHBOARD_TEST_LISTENER").is_none() {
        let status = fixture_command(port, &control)
            .env("CLAWPANEL_DASHBOARD_TEST_LISTENER", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let limit = Instant::now() + Duration::from_secs(30);
    while !control.exists() && Instant::now() < limit {
        std::thread::sleep(Duration::from_millis(15));
    }
    drop(listener);
}

fn until(mut check: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(6);
    while !check() {
        assert!(Instant::now() < end, "等待隔离 Dashboard 状态超时");
        std::thread::sleep(Duration::from_millis(15))
    }
}
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn concurrent_launch_stop_foreign_replacement_and_scoped_uninstall() {
    let base = std::env::temp_dir().join(format!(
        "clawpanel-dashboard-child-{}",
        rand::random::<u64>()
    ));
    std::fs::create_dir(&base).unwrap();
    let home = base.join("a");
    let other = base.join("b");
    let port = free_port();
    let exit = base.join("exit");
    let barrier = std::sync::Barrier::new(2);
    let (first, second) = std::thread::scope(|s| {
        let start = || {
            barrier.wait();
            get_or_spawn(&home, port, || spawn(&mut fixture_command(port, &exit))).unwrap()
        };
        let one = s.spawn(start);
        let two = s.spawn(start);
        (one.join().unwrap(), two.join().unwrap())
    });
    assert_ne!(first.1, second.1);
    assert!(Arc::ptr_eq(&first.0, &second.0));
    until(|| TcpStream::connect(("127.0.0.1", port)).is_ok());
    assert!(!stop(&other, port).unwrap());
    std::fs::write(&exit, "exit").unwrap();
    until(|| first.0.lock().unwrap().try_wait().unwrap().is_some());
    let foreign = TcpListener::bind(("127.0.0.1", port)).unwrap();
    assert!(!stop(&home, port).unwrap());
    assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    drop(foreign);
    let marker = base.join("second-exit");
    let (replacement, _) =
        get_or_spawn(&home, port, || spawn(&mut fixture_command(port, &marker))).unwrap();
    forget_exited(&home, port, &first.0);
    until(|| TcpStream::connect(("127.0.0.1", port)).is_ok());
    let port2 = free_port();
    let (other_port, _) =
        get_or_spawn(&home, port2, || spawn(&mut fixture_command(port2, &marker))).unwrap();
    until(|| TcpStream::connect(("127.0.0.1", port2)).is_ok());
    let port3 = free_port();
    let (other_home, _) = get_or_spawn(&other, port3, || {
        spawn(&mut fixture_command(port3, &marker))
    })
    .unwrap();
    until(|| TcpStream::connect(("127.0.0.1", port3)).is_ok());
    let scope = begin_uninstall(&home).unwrap();
    assert!(replacement.lock().unwrap().try_wait().unwrap().is_some());
    assert!(other_port.lock().unwrap().try_wait().unwrap().is_some());
    assert!(get_or_spawn(&home, port, || panic!("卸载期间不能启动")).is_err());
    assert!(other_home.lock().unwrap().try_wait().unwrap().is_none());
    until(|| TcpStream::connect(("127.0.0.1", port)).is_err());
    until(|| TcpStream::connect(("127.0.0.1", port2)).is_err());
    assert!(TcpStream::connect(("127.0.0.1", port3)).is_ok());
    assert!(stop(&other, port3).unwrap());
    until(|| TcpStream::connect(("127.0.0.1", port3)).is_err());
    assert!(!stop(&other, port3).unwrap());
    drop(scope);
    let _ = std::fs::remove_dir_all(base);
}
