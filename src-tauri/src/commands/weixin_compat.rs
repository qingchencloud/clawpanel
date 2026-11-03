use serde_json::{json, Value};

// Web 与桌面共用已审计版本线；不把 npm 可变标签当成兼容性保证。
fn policy() -> Value {
    serde_json::from_str(include_str!("../../../src/lib/weixin-compat-policy.json"))
        .expect("微信兼容性策略 JSON")
}

fn version_parts(value: &str) -> Option<[u32; 3]> {
    let value = value.trim();
    let value = value.strip_prefix('v').unwrap_or(value);
    let value = if let Some((core, suffix)) = value.split_once("-zh.") {
        if suffix.is_empty()
            || !suffix.chars().all(|c| c.is_ascii_digit())
            || suffix.parse::<u32>().is_err()
        {
            return None;
        }
        core
    } else {
        value
    };
    let core = if let Some((core, suffix)) = value.split_once('-') {
        if suffix.is_empty()
            || !suffix.chars().all(|c| c.is_ascii_digit())
            || suffix.parse::<u32>().is_err()
        {
            return None;
        }
        core
    } else {
        value
    };
    let parts: Vec<u32> = core
        .split('.')
        .map(|part| {
            if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
                return Err(());
            }
            part.parse().map_err(|_| ())
        })
        .collect::<Result<_, _>>()
        .ok()?;
    parts.try_into().ok()
}

fn plugin_parts(value: &str) -> Option<[u32; 3]> {
    let text = value.trim();
    if !text.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    version_parts(text)
}

const UNKNOWN_HOST_ERROR: &str =
    "未识别 OpenClaw 稳定版本，请先安装或检查内核版本，再安装微信插件。";

fn unknown_plugin_error(version: &str) -> String {
    let policy = policy();
    let reviewed = policy["reviewedVersion"].as_str().unwrap();
    let prefix = if plugin_parts(version).is_some_and(|v| v > plugin_parts(reviewed).unwrap()) {
        "检测到更高版本微信插件"
    } else {
        "微信插件"
    };
    let display = if version.is_empty() {
        "版本未知"
    } else {
        version.trim()
    };
    format!("{prefix} {display} 尚未纳入已核实兼容矩阵（最高 {reviewed}）；请保留现有插件，不会自动更新或降级。")
}

fn host_fits(host: [u32; 3], line: &Value) -> bool {
    host >= version_parts(line["hostMin"].as_str().unwrap()).unwrap()
        && line["hostBefore"]
            .as_str()
            .is_none_or(|v| host < version_parts(v).unwrap())
}

pub fn compatibility(host_version: &str, plugin_version: &str) -> Value {
    if version_parts(host_version).is_none() {
        return json!({"compatible": null, "compatError": UNKNOWN_HOST_ERROR});
    }
    if let (Some(host), Some(plugin)) = (version_parts(host_version), plugin_parts(plugin_version))
    {
        for line in policy()["lines"].as_array().unwrap() {
            if plugin >= version_parts(line["pluginMin"].as_str().unwrap()).unwrap()
                && plugin <= version_parts(line["pluginMax"].as_str().unwrap()).unwrap()
            {
                let compatible = host_fits(host, line);
                let range = format!(
                    ">={}{}",
                    line["hostMin"].as_str().unwrap(),
                    line["hostBefore"]
                        .as_str()
                        .map(|v| format!(" <{v}"))
                        .unwrap_or_default()
                );
                return json!({ "compatible": compatible, "compatError": if compatible { String::new() } else {
                    format!("微信插件 {plugin_version} 要求 OpenClaw {range}，当前为 {host_version}。")
                }});
            }
        }
    }
    json!({ "compatible": null, "compatError": unknown_plugin_error(plugin_version) })
}

pub fn resolve_version(host_version: &str, requested: Option<&str>) -> Result<String, String> {
    let host = version_parts(host_version).ok_or(UNKNOWN_HOST_ERROR)?;
    let policy = policy();
    let requested = requested.filter(|v| !v.is_empty());
    let target = requested
        .or_else(|| {
            policy["lines"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|line| host_fits(host, line))
                .and_then(|line| line["target"].as_str())
        })
        .unwrap_or_default();
    if target.is_empty() {
        let min = policy["lines"][0]["hostMin"].as_str().unwrap();
        return Err(format!("当前 OpenClaw {host_version} 低于已核实微信插件的最低要求 >={min}；请先升级内核，不会自动安装或降级插件。"));
    }
    let check = compatibility(host_version, target);
    if check["compatible"].as_bool() != Some(true) {
        return Err(check["compatError"].as_str().unwrap().into());
    }
    Ok(target.into())
}

pub fn status(host_version: &str, installed_version: Option<&str>) -> Value {
    let installed_version = installed_version.filter(|v| !v.is_empty());
    let target = resolve_version(host_version, None);
    let mut result = compatibility(host_version, installed_version.unwrap_or_default());
    let known = installed_version.is_none() || !result["compatible"].is_null();
    result["hostVersion"] = json!(host_version);
    result["recommendedVersion"] = if known {
        json!(target.as_ref().ok())
    } else {
        Value::Null
    };
    result["installAllowed"] = json!(target.is_ok() && known);
    result["installError"] = json!(target.as_ref().err().cloned().unwrap_or_else(|| {
        if known {
            String::new()
        } else {
            result["compatError"].as_str().unwrap().into()
        }
    }));
    result["updateAvailable"] = json!(
        known
            && installed_version.is_some_and(|v| {
                target
                    .as_ref()
                    .is_ok_and(|t| version_parts(v) < version_parts(t))
            })
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue345_shared_status_and_release_boundaries() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/weixin-issue345.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let actual = status(case["host"].as_str().unwrap(), case["plugin"].as_str());
            for key in [
                "compatible",
                "recommendedVersion",
                "installAllowed",
                "updateAvailable",
            ] {
                assert_eq!(actual[key], case[key], "case {case}, field {key}");
            }
            if case["compatible"].as_bool() == Some(true) {
                assert_eq!(actual["compatError"], "");
                assert_eq!(actual["installError"], "");
            }
        }
        for plugin in ["2.4.10", "3.0.0", "2.4.9-beta.0", "2.4.9-1"] {
            let actual = status("2026.9.8", Some(plugin));
            assert!(actual["compatible"].is_null());
            assert!(actual["recommendedVersion"].is_null());
            let error = actual["installError"].as_str().unwrap();
            assert!(error.contains("插件") && error.contains("保留") && error.contains("降级"));
            assert!(!error.contains("未识别 OpenClaw"));
            assert!(resolve_version("2026.9.8", Some(plugin)).is_err());
        }
        assert_eq!(resolve_version("2026.9.8", None).unwrap(), "2.4.9");
        assert!(resolve_version("2026.5.11", Some("2.4.9"))
            .unwrap_err()
            .contains(">=2026.5.12"));
        for host in [
            "vv2026.9.8",
            "+2026.9.8",
            "2026.9.8-",
            "999999999999999999999.9.8",
            "2026.9.8-preview.1",
        ] {
            assert!(status(host, Some("2.4.9"))["compatible"].is_null());
            assert_eq!(status(host, Some("2.4.9"))["installAllowed"], false);
        }
    }

    #[test]
    fn shared_compatibility_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/weixin-compat.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let actual = status(case["host"].as_str().unwrap(), case["plugin"].as_str());
            for key in [
                "compatible",
                "recommendedVersion",
                "installAllowed",
                "updateAvailable",
            ] {
                assert_eq!(actual[key], case[key], "case {case}, field {key}");
            }
        }
        assert!(resolve_version("2026.3.21", Some("2.4.8")).is_err());
        assert!(resolve_version("2026.9.4", Some("1.0.3")).is_err());
        assert!(resolve_version("2026.9.4", Some("latest")).is_err());
    }
}
