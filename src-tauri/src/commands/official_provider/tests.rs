use super::*;

#[test]
fn isolated_install_refresh_disconnect_and_conflicts() {
    let executable = std::env::current_exe().unwrap();
    let flag = "CLAWPANEL_OFFICIAL_PROVIDER_FIXTURE";
    if let Some(home) = std::env::var_os(flag) {
        let root = std::path::PathBuf::from(home).join("data/openclaw");
        assert_eq!(super::super::openclaw_dir(), root);
        let path = root.join("openclaw.json");
        let initial = json!({"agents":{"defaults":{"workspace":"keep"}},"models":{"providers":{"mine":{"baseUrl":"http://localhost:1111","models":[]}}}});
        std::fs::write(&path, serde_json::to_vec(&initial).unwrap()).unwrap();
        let agent_file = root.join("agents/main/agent/models.json");
        std::fs::create_dir_all(agent_file.parent().unwrap()).unwrap();
        let agent_initial =
            json!({"providers":{"agent-specific":{"models":[{"id":"keep-private-model"}]}}});
        std::fs::write(&agent_file, serde_json::to_vec(&agent_initial).unwrap()).unwrap();
        let connection = json!({"epoch":1,"memberId":"fixture-member","baseUrl":"http://127.0.0.1:1234/engine/test-capability/v1","apiKey":"clawpanel-local","models":[{"id":"official/mock","context_tokens":16000}]});
        let mut state = load_state().unwrap();
        install_connection(&connection, &mut state).unwrap();
        assert!(current_provider().unwrap().is_some());
        let url = connection["baseUrl"].as_str().unwrap();
        assert!(active_endpoint(1, "fixture-member", url));
        assert!(!active_endpoint(2, "fixture-member", url));
        let agent: Value = serde_json::from_slice(&std::fs::read(&agent_file).unwrap()).unwrap();
        assert_eq!(
            agent["providers"]["agent-specific"],
            agent_initial["providers"]["agent-specific"]
        );
        assert_eq!(
            agent["providers"][PROVIDER_ID]["models"][0]["id"],
            "official/mock"
        );
        install_connection(&connection, &mut state).unwrap();
        let mut changed = connection.clone();
        changed["models"][0]["id"] = json!("official/new");
        install_connection(&changed, &mut state).unwrap();
        assert_eq!(
            current_provider().unwrap().unwrap()["models"][0]["id"],
            "official/new"
        );
        remove_connection(&mut state).unwrap();
        remove_connection(&mut state).unwrap();
        assert_eq!(current_provider().unwrap(), None);
        assert!(!active_endpoint(1, "fixture-member", url));
        let agent: Value = serde_json::from_slice(&std::fs::read(&agent_file).unwrap()).unwrap();
        assert_eq!(agent, agent_initial);
        let restored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored, initial);
        let mut collision = initial.clone();
        collision["models"]["providers"][PROVIDER_ID] =
            json!({"baseUrl":"http://localhost:4567","apiKey":"user-owned","models":[]});
        std::fs::write(&path, serde_json::to_vec(&collision).unwrap()).unwrap();
        assert!(install_connection(&connection, &mut state).is_err());
        assert!(remove_connection(&mut state).is_err());
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved, collision);
        std::fs::write(&path, "{}").unwrap();
        install_connection(&connection, &mut state).unwrap();
        let mut edited = current_provider().unwrap().unwrap();
        edited["models"][0]["name"] = json!("user edit");
        super::super::config::save_openclaw_json(
            &json!({"models":{"providers":{PROVIDER_ID:edited}}}),
        )
        .unwrap();
        assert!(remove_connection(&mut state).is_err());
        assert!(install_connection(&changed, &mut state).is_err());
        assert_eq!(current_provider().unwrap(), Some(edited));
        return;
    }
    let home = std::env::temp_dir().join(format!(
        "clawpanel-official-provider-{}",
        rand::random::<u64>()
    ));
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("portable.json"), br#"{"mode":"portable"}"#).unwrap();
    let mut cmd = crate::utils::background_command(executable);
    cmd.args([
        "--exact",
        "commands::official_provider::tests::isolated_install_refresh_disconnect_and_conflicts",
        "--nocapture",
    ])
    .env(flag, &home)
    .env("HOME", &home)
    .env("USERPROFILE", &home)
    .env("APPDATA", home.join("roaming"))
    .env("LOCALAPPDATA", home.join("local"))
    .env("XDG_CONFIG_HOME", home.join("xdg"))
    .env("CLAWPANEL_PORTABLE_ROOT", &home);
    let result = cmd.output().unwrap();
    assert!(
        result.status.success(),
        "{} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    std::fs::remove_dir_all(&home).unwrap();
}
