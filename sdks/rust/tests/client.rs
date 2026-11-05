use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zakura_sdk::{Client, Config, Error, Headers, Request, Response, Transport};

struct Fake {
    statuses: Mutex<Vec<u16>>,
    calls: Mutex<Vec<Request>>,
    body: Vec<u8>,
}
impl Fake {
    fn new(statuses: Vec<u16>, body: &[u8]) -> Arc<Self> {
        Arc::new(Self {
            statuses: Mutex::new(statuses),
            calls: Mutex::new(vec![]),
            body: body.to_vec(),
        })
    }
}
impl Transport for Fake {
    fn send(
        &self,
        request: Request,
        _timeout: Duration,
        _max_bytes: u64,
    ) -> Result<Response, Error> {
        self.calls.lock().unwrap().push(request);
        Ok(Response {
            status: self.statuses.lock().unwrap().remove(0),
            headers: BTreeMap::from([("Retry-After".into(), "0".into())]),
            body: self.body.clone(),
        })
    }
}
fn fake_client(transport: Arc<Fake>, attempts: usize, max_bytes: u64) -> Client {
    let mut config = Config::new("https://example.test/prefix");
    config.transport = Some(transport);
    config.max_attempts = attempts;
    config.max_response_bytes = max_bytes;
    config.base_delay = Duration::ZERO;
    config.token = "secret".into();
    Client::new(config).unwrap()
}
#[test]
fn path_encoding_and_owned_options() {
    let client = fake_client(Fake::new(vec![200], b"{}"), 1, 1024);
    let base = client.get_api_agents_by_id("猫 /?%");
    let builder = base
        .clone()
        .with_query(BTreeMap::from([(
            "tag".into(),
            vec!["one".into(), "two".into()],
        )]))
        .with_headers(Headers::from([("authorization".into(), "override".into())]));
    let request = builder.build().unwrap();
    assert_eq!(
        request.url,
        "https://example.test/prefix/api/agents/%E7%8C%AB%20%2F%3F%25?tag=one&tag=two"
    );
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer secret"
    );
    assert!(!base.build().unwrap().url.contains('?'));
    for invalid in ["", ".", ".."] {
        assert!(client.get_api_agents_by_id(invalid).build().is_err());
    }
    assert_eq!(
        client
            .post_api_agents()
            .with_json(serde_json::Value::Null)
            .build()
            .unwrap()
            .body
            .unwrap(),
        b"null"
    );
    assert_eq!(
        client
            .post_oauth_token()
            .with_raw(b"a=b".to_vec(), "application/x-www-form-urlencoded".into())
            .build()
            .unwrap()
            .body
            .unwrap(),
        b"a=b"
    );
}
#[test]
fn read_retry_but_no_mutation_retry() {
    let transport = Fake::new(vec![503, 200], b"{\"ok\":true}");
    let client = fake_client(transport.clone(), 3, 1024);
    let value: serde_json::Value = client.get_api_agents().json().unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(transport.calls.lock().unwrap().len(), 2);
    let transport = Fake::new(vec![503, 200], b"busy");
    let client = fake_client(transport.clone(), 3, 1024);
    assert!(matches!(
        client.post_api_agents().execute(),
        Err(Error::Api { status: 503, .. })
    ));
    assert_eq!(transport.calls.lock().unwrap().len(), 1);
}
#[test]
fn size_and_pagination_guards() {
    let client = fake_client(Fake::new(vec![200], b"too large"), 1, 3);
    assert!(matches!(
        client.get_api_agents().execute(),
        Err(Error::ResponseTooLarge)
    ));
    let client = fake_client(Fake::new(vec![200, 200, 200], b"{}"), 1, 1024);
    let error = client
        .get_api_agents()
        .pages("cursor", 4, |_| Ok(Some("same".into())))
        .unwrap_err();
    assert!(error.to_string().contains("repeated"));
}
#[test]
fn invalid_configuration_and_token() {
    for url in [
        "relative",
        "ftp://example.test",
        "https://u:p@example.test",
        "https://example.test?q=1",
        "https://example.test#f",
    ] {
        assert!(Client::new(Config::new(url)).is_err());
    }
    let mut config = Config::new("https://example.test");
    config.max_attempts = 9;
    assert!(Client::new(config).is_err());
    let mut config = Config::new("https://example.test");
    config.token = "bad\nvalue".into();
    assert!(Client::new(config)
        .unwrap()
        .get_api_agents()
        .build()
        .is_err());
}
#[test]
fn real_http_redirect_and_bounded_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handler = std::thread::spawn(move || {
        let mut captured = vec![];
        for status in [302, 200] {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = vec![];
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            captured.push(String::from_utf8(request).unwrap());
            let reply = format!("HTTP/1.1 {status} Response\r\nLocation: /target\r\nContent-Length: 8\r\nConnection: close\r\n\r\n12345678");
            socket.write_all(reply.as_bytes()).unwrap();
        }
        captured
    });
    let mut config = Config::new(format!("http://{address}"));
    config.token = "secret".into();
    let client = Client::new(config).unwrap();
    assert!(matches!(
        client.get_api_agents().execute(),
        Err(Error::Api { status: 302, .. })
    ));
    let mut config = Config::new(format!("http://{address}"));
    config.max_response_bytes = 3;
    assert!(matches!(
        Client::new(config).unwrap().get_api_agents().execute(),
        Err(Error::ResponseTooLarge)
    ));
    let captured = handler.join().unwrap();
    assert_eq!(captured.len(), 2);
    assert!(captured[0].starts_with("GET /api/agents "));
    assert!(captured[0]
        .to_ascii_lowercase()
        .contains("authorization: bearer secret"));
    assert!(!captured
        .iter()
        .any(|request| request.starts_with("GET /target ")));
}
