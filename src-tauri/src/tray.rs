/// 系统托盘模块
/// Windows / macOS / Linux 通用，Tauri v2 内置跨平台支持
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use crate::sandbox::gateway;

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 菜单项
    let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let gateway_start = MenuItemBuilder::with_id("gateway_start", "启动 Gateway").build(app)?;
    let gateway_stop = MenuItemBuilder::with_id("gateway_stop", "停止 Gateway").build(app)?;
    let gateway_restart = MenuItemBuilder::with_id("gateway_restart", "重启 Gateway").build(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 CJGClaw").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&separator1)
        .item(&gateway_start)
        .item(&gateway_stop)
        .item(&gateway_restart)
        .item(&separator2)
        .item(&quit)
        .build()?;

    // 托盘图标（使用内嵌 32x32 PNG）
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("CJGClaw")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        "gateway_start" => {
            std::mem::drop(gateway::gateway_start());
        }
        "gateway_stop" => {
            std::mem::drop(gateway::gateway_stop());
        }
        "gateway_restart" => {
            std::mem::drop(gateway::gateway_restart());
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}
