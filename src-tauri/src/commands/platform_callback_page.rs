//! 固定内容的官网授权回执；页面不接收或反射任何授权参数。

const TEMPLATE: &str = include_str!("platform_callback_page.html");
const STYLE: &str = include_str!("platform_callback_page.css");
const SCRIPT: &str = include_str!("platform_callback_page.js");
const STYLE_SHA256: &str = "2bzcPsIjgwsxeBqFjV65QJOsPCc9MgDOEm7dyttubF0=";
const SCRIPT_SHA256: &str = "5hHSIeO5Dk9VKBiu/E5/2wwGDyQIn6krctFJw6rEH4I=";

pub(super) enum Outcome {
    Received,
    Denied,
    Rejected,
}

pub(super) fn response(outcome: Outcome, english: bool) -> String {
    let (status, name, heading, return_hint, result_hint, instruction, instruction_detail) =
        match (outcome, english) {
            (Outcome::Received, false) => (
                "200 OK",
                "received",
                "授权已接收",
                "请返回 ClawPanel 继续",
                "登录结果以客户端显示为准。",
                "切回 ClawPanel，查看登录状态。",
                "你可以关闭此页面。",
            ),
            (Outcome::Received, true) => (
                "200 OK",
                "received",
                "Authorization received",
                "Return to ClawPanel to continue",
                "Check the app for your sign-in result.",
                "Return to ClawPanel to check your sign-in status.",
                "You can close this page.",
            ),
            (Outcome::Denied, false) => (
                "400 Bad Request",
                "denied",
                "已取消授权",
                "请返回 ClawPanel",
                "本次授权已取消，可在客户端重新登录。",
                "无需在此页面继续操作。",
                "如需登录，请返回客户端重试。",
            ),
            (Outcome::Denied, true) => (
                "400 Bad Request",
                "denied",
                "Authorization cancelled",
                "Return to ClawPanel",
                "Authorization was cancelled. Sign in again in the app.",
                "No further action is needed on this page.",
                "Return to the app if you want to try again.",
            ),
            (Outcome::Rejected, false) => (
                "400 Bad Request",
                "rejected",
                "授权未完成",
                "请返回 ClawPanel 重试",
                "此页面已失效或无法确认。",
                "返回客户端，重新发起官网登录。",
                "请勿重复提交此页面。",
            ),
            (Outcome::Rejected, true) => (
                "400 Bad Request",
                "rejected",
                "Authorization incomplete",
                "Return to ClawPanel to try again",
                "This page has expired or could not be verified.",
                "Start website sign-in again from the app.",
                "Do not submit this page again.",
            ),
        };
    let (lang, document_title, close, close_fallback, footer, zh_pressed, en_pressed) = if english {
        (
            "en",
            "ClawPanel · Website authorization",
            "Close this page",
            "The browser did not close. Please close this tab manually.",
            "ClawPanel · Your existing models and conversations stay",
            "false",
            "true",
        )
    } else {
        (
            "zh-CN",
            "ClawPanel · 官网授权",
            "关闭此页",
            "浏览器未关闭，请手动关闭此标签页。",
            "ClawPanel · 原有模型与会话保留",
            "true",
            "false",
        )
    };
    let mut body = TEMPLATE.to_string();
    // 所有替换值均为本模块常量；HTTP 请求及账户信息不进入模板。
    for (marker, value) in [
        ("{{LANG}}", lang),
        ("{{OUTCOME}}", name),
        ("{{DOCUMENT_TITLE}}", document_title),
        ("{{ZH_PRESSED}}", zh_pressed),
        ("{{EN_PRESSED}}", en_pressed),
        ("{{HEADING}}", heading),
        ("{{RETURN_HINT}}", return_hint),
        ("{{RESULT_HINT}}", result_hint),
        ("{{INSTRUCTION}}", instruction),
        ("{{INSTRUCTION_DETAIL}}", instruction_detail),
        ("{{CLOSE}}", close),
        ("{{CLOSE_FALLBACK}}", close_fallback),
        ("{{FOOTER}}", footer),
        ("{{STYLE}}", STYLE),
        ("{{SCRIPT}}", SCRIPT),
    ] {
        body = body.replace(marker, value);
    }
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; style-src 'sha256-{STYLE_SHA256}'; script-src 'sha256-{SCRIPT_SHA256}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}
