//! 回环测试夹具的真实 Rustls 状态机；不连接用户服务，不放宽证书验证。
//! 回归依据：GHSA-2mjx-qc3c-rqvc、rustls/rustls#3265。
use std::io::{Cursor, Read, Write};
use std::sync::Arc;

use base64::Engine;
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName};
use rustls::{ClientConfig, ClientConnection, RootCertStore, ServerConfig, ServerConnection};

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/tls-localhost.json")).unwrap()
}

fn decoded(value: &serde_json::Value, key: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(value[key].as_str().unwrap())
        .unwrap()
}

fn pair() -> (ClientConnection, ServerConnection) {
    let fixture = fixture();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(decoded(
            &fixture,
            "rootCertificateDerBase64",
        )))
        .unwrap();
    let client = ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(decoded(
                &fixture,
                "certificateDerBase64",
            ))],
            PrivatePkcs8KeyDer::from(decoded(&fixture, "privateKeyDerBase64")).into(),
        )
        .unwrap();
    (
        ClientConnection::new(Arc::new(client), ServerName::try_from("localhost").unwrap())
            .unwrap(),
        ServerConnection::new(Arc::new(server)).unwrap(),
    )
}

fn evidence(name: &str, value: serde_json::Value) {
    println!("TLS_RECORD_BOUNDARY {value}");
    if let Some(directory) = std::env::var_os("CLAWPANEL_TLS_TEST_EVIDENCE_DIR") {
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(format!("{name}.json")))
            .unwrap();
        file.write_all(serde_json::to_string_pretty(&value).unwrap().as_bytes())
            .unwrap();
    }
}

fn coalesced_record(record: &[u8], extra: &[u8]) -> Vec<u8> {
    assert_eq!(record[0], 22);
    let length = u16::from_be_bytes([record[3], record[4]]) as usize;
    let mut result = vec![22, 3, 3];
    result.extend_from_slice(&u16::try_from(length + extra.len()).unwrap().to_be_bytes());
    result.extend_from_slice(&record[5..5 + length]);
    result.extend_from_slice(extra);
    result
}

#[test]
fn tls13_normal_handshake_and_complete_payload() {
    let (mut client, mut server) = pair();
    for _ in 0..10 {
        let mut outbound = Vec::new();
        client.write_tls(&mut outbound).unwrap();
        if !outbound.is_empty() {
            server.read_tls(&mut Cursor::new(outbound)).unwrap();
            server.process_new_packets().unwrap();
        }
        let mut outbound = Vec::new();
        server.write_tls(&mut outbound).unwrap();
        if !outbound.is_empty() {
            client.read_tls(&mut Cursor::new(outbound)).unwrap();
            client.process_new_packets().unwrap();
        }
        if !client.is_handshaking() && !server.is_handshaking() {
            break;
        }
    }
    assert!(!client.is_handshaking() && !server.is_handshaking());
    let message = "ClawPanel完整TLS1.3回执".as_bytes();
    server.writer().write_all(message).unwrap();
    let mut encrypted = Vec::new();
    server.write_tls(&mut encrypted).unwrap();
    client.read_tls(&mut Cursor::new(encrypted)).unwrap();
    client.process_new_packets().unwrap();
    let mut received = vec![0; message.len()];
    client.reader().read_exact(&mut received).unwrap();
    assert_eq!(received, message);
    evidence(
        "normal-tls13",
        serde_json::json!({"case":"normal","ok":true,"certificateVerified":true,"bytes":received.len()}),
    );
}

#[test]
fn client_rejects_plaintext_encrypted_extensions_after_server_hello() {
    let (mut client, mut server) = pair();
    let mut hello = Vec::new();
    client.write_tls(&mut hello).unwrap();
    server.read_tls(&mut Cursor::new(hello)).unwrap();
    server.process_new_packets().unwrap();
    let mut flight = Vec::new();
    server.write_tls(&mut flight).unwrap();
    assert_eq!(flight[5], 2, "真实服务端首先输出ServerHello");
    // 仅修改本进程生成的第一条plaintext记录，不读取或发送真实凭据。
    let record = coalesced_record(&flight, &[8, 0, 0, 2, 0, 0]);
    client.read_tls(&mut Cursor::new(record)).unwrap();
    let actual = client.process_new_packets();
    let error = actual.as_ref().err().map(|error| format!("{error:?}"));
    evidence(
        "client-wrong-epoch",
        serde_json::json!({"case":"client-wrong-epoch","rejected":actual.is_err(),"error":error,"normalServerHelloGenerated":true}),
    );
    assert_eq!(
        error.as_deref(),
        Some("PeerMisbehaved(KeyEpochWithPendingFragment)")
    );
}

#[test]
fn acceptor_rejects_plaintext_messages_following_client_hello() {
    let (mut client, _) = pair();
    let mut hello = Vec::new();
    client.write_tls(&mut hello).unwrap();
    assert_eq!(hello[5], 1);
    let record = coalesced_record(&hello, &[8, 0, 0, 2, 0, 0]);
    let mut acceptor = rustls::server::Acceptor::default();
    acceptor.read_tls(&mut Cursor::new(record)).unwrap();
    let actual = acceptor.accept();
    let error = actual.as_ref().err().map(|(error, _)| format!("{error:?}"));
    evidence(
        "acceptor-wrong-epoch",
        serde_json::json!({"case":"acceptor-wrong-epoch","rejected":actual.is_err(),"error":error}),
    );
    assert_eq!(
        error.as_deref(),
        Some("PeerMisbehaved(KeyEpochWithPendingFragment)")
    );
}
