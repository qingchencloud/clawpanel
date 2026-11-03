//! 仅本机隔离协议 E2E：JSONL 私有管道复用产品原生服务，不注入授权凭据。
#[cfg(debug_assertions)]
#[tokio::main]
async fn main() {
    if let Err(code) = clawpanel_lib::run_platform_harness().await {
        eprintln!("{code}");
        std::process::exit(1);
    }
}

#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("platform_harness_debug_only");
    std::process::exit(1);
}
