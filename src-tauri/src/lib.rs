mod commands;
mod models;
mod tray;
mod utils;

use commands::{agent, assistant, config, device, extensions, logs, memory, pairing, service};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 配置
            config::read_openclaw_config,
            config::write_openclaw_config,
            config::read_mcp_config,
            config::write_mcp_config,
            config::get_version_info,
            config::check_installation,
            config::init_openclaw_config,
            config::check_node,
            config::check_node_at_path,
            config::scan_node_paths,
            config::save_custom_node_path,
            config::write_env_file,
            config::list_backups,
            config::create_backup,
            config::restore_backup,
            config::delete_backup,
            config::reload_gateway,
            config::restart_gateway,
            config::test_model,
            config::list_remote_models,
            config::upgrade_openclaw,
            config::install_gateway,
            config::uninstall_gateway,
            config::patch_model_vision,
            config::check_panel_update,
            config::read_panel_config,
            config::write_panel_config,
            config::get_npm_registry,
            config::set_npm_registry,
            config::get_fallbacks_history_path,
            config::load_fallbacks_history,
            config::save_fallbacks_history,
            config::clear_fallbacks_history,
            config::set_fallbacks_config,
            // 设备密钥 + Gateway 握手
            device::create_connect_frame,
            // 设备配对
            pairing::auto_pair_device,
            pairing::check_pairing_status,
            // 服务
            service::get_services_status,
            service::start_service,
            service::stop_service,
            service::restart_service,
            // 日志
            logs::read_log_tail,
            logs::search_log,
            // 记忆文件
            memory::list_memory_files,
            memory::read_memory_file,
            memory::write_memory_file,
            memory::delete_memory_file,
            memory::export_memory_zip,
            // 扩展工具
            extensions::get_cftunnel_status,
            extensions::cftunnel_action,
            extensions::get_cftunnel_logs,
            extensions::get_clawapp_status,
            extensions::install_cftunnel,
            extensions::install_clawapp,
            // Agent 管理
            agent::list_agents,
            agent::add_agent,
            agent::delete_agent,
            agent::update_agent_identity,
            agent::update_agent_model,
            agent::backup_agent,
            // AI 助手工具
            assistant::assistant_exec,
            assistant::assistant_read_file,
            assistant::assistant_write_file,
            assistant::assistant_list_dir,
            assistant::assistant_system_info,
            assistant::assistant_list_processes,
            assistant::assistant_check_port,
            // 数据目录 & 图片存储
            assistant::assistant_ensure_data_dir,
            assistant::assistant_save_image,
            assistant::assistant_load_image,
            assistant::assistant_delete_image,
        ])
        .run(tauri::generate_context!())
        .expect("启动 ClawPanel 失败");
}
