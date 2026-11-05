// SPDX-License-Identifier: AGPL-3.0-only
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

pub type Query = BTreeMap<String, Vec<String>>;
pub type Headers = BTreeMap<String, String>;
pub type TokenProvider = Arc<dyn Fn() -> Result<String, Error> + Send + Sync>;

#[derive(Debug)]
pub enum Error {
    Invalid(String),
    Transport(String),
    Deadline,
    ResponseTooLarge,
    Json(serde_json::Error),
    Api {
        status: u16,
        method: String,
        path: String,
        request_id: Option<String>,
        body: Vec<u8>,
    },
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "Invalid Zakura request: {message}"),
            Self::Transport(_) => write!(f, "Zakura HTTP transport failed"),
            Self::Deadline => write!(f, "Zakura request deadline exceeded"),
            Self::ResponseTooLarge => write!(f, "Zakura response exceeds configured byte limit"),
            Self::Json(error) => write!(f, "Zakura JSON decode failed: {error}"),
            Self::Api {
                status,
                method,
                path,
                ..
            } => write!(f, "Zakura {method} {path} returned HTTP {status}"),
        }
    }
}
impl std::error::Error for Error {}
impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Headers,
    pub body: Option<Vec<u8>>,
}
#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Headers,
    pub body: Vec<u8>,
}
impl Response {
    pub fn json<T: DeserializeOwned>(&self) -> Result<T, Error> {
        Ok(serde_json::from_slice(&self.body)?)
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}
pub trait Transport: Send + Sync {
    fn send(&self, request: Request, timeout: Duration, max_bytes: u64) -> Result<Response, Error>;
}
pub struct HTTPTransport {
    http: reqwest::blocking::Client,
}
impl HTTPTransport {
    pub fn new() -> Result<Self, Error> {
        let http = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| Error::Transport(error.to_string()))?;
        Ok(Self { http })
    }
}
impl Transport for HTTPTransport {
    fn send(&self, request: Request, timeout: Duration, max_bytes: u64) -> Result<Response, Error> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|error| Error::Invalid(error.to_string()))?;
        let mut builder = self.http.request(method, request.url).timeout(timeout);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder.send().map_err(|error| {
            if error.is_timeout() {
                Error::Deadline
            } else {
                Error::Transport(error.to_string())
            }
        })?;
        let status = response.status().as_u16();
        let mut headers = Headers::new();
        for (name, value) in response.headers() {
            if let Ok(text) = value.to_str() {
                headers.insert(name.to_string(), text.to_string());
            }
        }
        let mut body = Vec::new();
        response
            .take(max_bytes + 1)
            .read_to_end(&mut body)
            .map_err(|error| Error::Transport(error.to_string()))?;
        if body.len() as u64 > max_bytes {
            return Err(Error::ResponseTooLarge);
        }
        Ok(Response {
            status,
            headers,
            body,
        })
    }
}

pub struct Config {
    pub base_url: String,
    pub token: String,
    pub token_provider: Option<TokenProvider>,
    pub transport: Option<Arc<dyn Transport>>,
    pub timeout: Duration,
    pub max_response_bytes: u64,
    pub max_attempts: usize,
    pub base_delay: Duration,
    pub max_delay: Duration,
}
impl Config {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            token: String::new(),
            token_provider: None,
            transport: None,
            timeout: Duration::from_secs(30),
            max_response_bytes: 8 << 20,
            max_attempts: 1,
            base_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(2),
        }
    }
}
struct Inner {
    base_url: String,
    token: TokenProvider,
    transport: Arc<dyn Transport>,
    timeout: Duration,
    max_bytes: u64,
    attempts: usize,
    base_delay: Duration,
    max_delay: Duration,
}
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}
impl Client {
    pub fn new(config: Config) -> Result<Self, Error> {
        let url =
            url::Url::parse(&config.base_url).map_err(|error| Error::Invalid(error.to_string()))?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Invalid(
                "base URL must be absolute HTTP(S) without credentials, query or fragment".into(),
            ));
        }
        if config.timeout.is_zero()
            || config.timeout > Duration::from_secs(86400)
            || config.max_delay.is_zero()
            || config.max_delay > Duration::from_secs(86400)
            || config.base_delay > Duration::from_secs(86400)
        {
            return Err(Error::Invalid("invalid timeout or retry delay".into()));
        }
        if !(1..=8).contains(&config.max_attempts)
            || !(1..=1 << 30).contains(&config.max_response_bytes)
        {
            return Err(Error::Invalid(
                "invalid attempts or response byte limit".into(),
            ));
        }
        let token = config
            .token_provider
            .unwrap_or_else(|| Arc::new(move || Ok(config.token.clone())));
        let transport = match config.transport {
            Some(value) => value,
            None => Arc::new(HTTPTransport::new()?),
        };
        Ok(Self {
            inner: Arc::new(Inner {
                base_url: config.base_url.trim_end_matches('/').to_string(),
                token,
                transport,
                timeout: config.timeout,
                max_bytes: config.max_response_bytes,
                attempts: config.max_attempts,
                base_delay: config.base_delay,
                max_delay: config.max_delay,
            }),
        })
    }
    pub fn build(
        &self,
        method: &str,
        path: &str,
        params: &BTreeMap<String, String>,
        options: &CallOptions,
    ) -> Result<Request, Error> {
        let path = expand_path(path, params)?;
        let mut url = self.inner.base_url.clone() + &path;
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        for (key, values) in &options.query {
            for value in values {
                query.append_pair(key, value);
            }
        }
        let encoded = query.finish();
        if !encoded.is_empty() {
            url += "?";
            url += &encoded;
        }
        let mut headers: Headers = options
            .headers
            .iter()
            .map(|(key, value)| (key.to_ascii_lowercase(), value.clone()))
            .collect();
        if headers
            .iter()
            .any(|(key, value)| key.contains(['\r', '\n']) || value.contains(['\r', '\n']))
        {
            return Err(Error::Invalid("headers contain newline characters".into()));
        }
        if !headers.keys().any(|key| key.eq_ignore_ascii_case("accept")) {
            headers.insert("accept".into(), "application/json".into());
        }
        let token = (self.inner.token)()?;
        if token.contains(['\r', '\n']) {
            return Err(Error::Invalid("token contains newline characters".into()));
        }
        if !token.is_empty() {
            headers.retain(|key, _| !key.eq_ignore_ascii_case("authorization"));
            headers.insert("authorization".into(), format!("Bearer {token}"));
        }
        headers.insert("user-agent".into(), "zakura-rust-sdk/1".into());
        let body = if let Some(value) = &options.json {
            if options.raw.is_some() {
                return Err(Error::Invalid(
                    "JSON and raw bodies are mutually exclusive".into(),
                ));
            }
            headers.insert("content-type".into(), "application/json".into());
            Some(serde_json::to_vec(value)?)
        } else {
            if let Some(content_type) = &options.content_type {
                headers.insert("content-type".into(), content_type.clone());
            }
            options.raw.clone()
        };
        Ok(Request {
            method: method.into(),
            url,
            headers,
            body,
        })
    }
    fn delay(&self, attempt: usize, response: &Response) -> Duration {
        let default = self
            .inner
            .base_delay
            .saturating_mul(1 << attempt)
            .min(self.inner.max_delay);
        let parsed = response.header("retry-after").and_then(|value| {
            value
                .parse::<u64>()
                .ok()
                .map(Duration::from_secs)
                .or_else(|| {
                    httpdate::parse_http_date(value)
                        .ok()
                        .map(|when| when.duration_since(SystemTime::now()).unwrap_or_default())
                })
        });
        parsed.unwrap_or(default).min(self.inner.max_delay)
    }
    pub fn execute(
        &self,
        method: &str,
        path: &str,
        params: &BTreeMap<String, String>,
        options: &CallOptions,
    ) -> Result<Response, Error> {
        let timeout = options.timeout.unwrap_or(self.inner.timeout);
        if timeout.is_zero() || timeout > Duration::from_secs(86400) {
            return Err(Error::Invalid("invalid request timeout".into()));
        }
        let deadline = Instant::now() + timeout;
        let attempts = if method == "GET" || method == "HEAD" {
            self.inner.attempts
        } else {
            1
        };
        for attempt in 0..attempts {
            let request = self.build(method, path, params, options)?;
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(Error::Deadline)?;
            let response = self
                .inner
                .transport
                .send(request, remaining, self.inner.max_bytes)?;
            if Instant::now() >= deadline {
                return Err(Error::Deadline);
            }
            if response.body.len() as u64 > self.inner.max_bytes {
                return Err(Error::ResponseTooLarge);
            }
            if (200..300).contains(&response.status) {
                return Ok(response);
            }
            if attempt + 1 == attempts || ![429, 502, 503, 504].contains(&response.status) {
                return Err(Error::Api {
                    status: response.status,
                    method: method.into(),
                    path: path.into(),
                    request_id: response.header("x-request-id").map(str::to_string),
                    body: response.body,
                });
            }
            let delay = self.delay(attempt, &response);
            if delay
                >= deadline
                    .checked_duration_since(Instant::now())
                    .unwrap_or_default()
            {
                return Err(Error::Deadline);
            }
            std::thread::sleep(delay);
        }
        Err(Error::Invalid("unreachable retry state".into()))
    }
}
#[derive(Clone, Default)]
pub struct CallOptions {
    pub query: Query,
    pub headers: Headers,
    pub json: Option<Value>,
    pub raw: Option<Vec<u8>>,
    pub content_type: Option<String>,
    pub timeout: Option<Duration>,
}
#[derive(Clone)]
pub struct Endpoint {
    pub client: Client,
    pub method: &'static str,
    pub path: &'static str,
    pub parameters: BTreeMap<String, String>,
    pub options: CallOptions,
}
impl Endpoint {
    pub fn with_query(mut self, query: Query) -> Self {
        self.options.query = query;
        self
    }
    pub fn with_headers(mut self, headers: Headers) -> Self {
        self.options.headers = headers;
        self
    }
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.options.timeout = Some(timeout);
        self
    }
    pub fn with_options(mut self, options: CallOptions) -> Self {
        self.options = options;
        self
    }
    pub fn with_json(mut self, value: Value) -> Self {
        self.options.json = Some(value);
        self.options.raw = None;
        self
    }
    pub fn with_raw(mut self, body: Vec<u8>, content_type: String) -> Self {
        self.options.raw = Some(body);
        self.options.json = None;
        self.options.content_type = Some(content_type);
        self
    }
    pub fn new(
        client: Client,
        method: &'static str,
        path: &'static str,
        parameters: BTreeMap<String, String>,
    ) -> Self {
        Self {
            client,
            method,
            path,
            parameters,
            options: CallOptions::default(),
        }
    }
    pub fn build(&self) -> Result<Request, Error> {
        self.client
            .build(self.method, self.path, &self.parameters, &self.options)
    }
    pub fn execute(&self) -> Result<Response, Error> {
        self.client
            .execute(self.method, self.path, &self.parameters, &self.options)
    }
    pub fn json<T: DeserializeOwned>(&self) -> Result<T, Error> {
        self.execute()?.json()
    }
    pub fn pages<F>(&self, key: &str, max_pages: usize, mut consume: F) -> Result<(), Error>
    where
        F: FnMut(Response) -> Result<Option<String>, Error>,
    {
        if self.method != "GET" || key.is_empty() || !(1..=10000).contains(&max_pages) {
            return Err(Error::Invalid("invalid pagination configuration".into()));
        }
        let mut current = self.clone();
        let mut seen = BTreeSet::new();
        for _ in 0..max_pages {
            let response = current.execute()?;
            let cursor = match consume(response)? {
                Some(value) if !value.is_empty() => value,
                _ => return Ok(()),
            };
            if !seen.insert(cursor.clone()) {
                return Err(Error::Invalid("pagination repeated a cursor".into()));
            }
            current.options.query.insert(key.into(), vec![cursor]);
        }
        Err(Error::Invalid(
            "pagination reached configured page limit".into(),
        ))
    }
}
fn expand_path(path: &str, params: &BTreeMap<String, String>) -> Result<String, Error> {
    if !path.starts_with('/') || path.contains(['?', '#']) {
        return Err(Error::Invalid(
            "route must be an absolute path without query or fragment".into(),
        ));
    }
    let mut result = path.to_string();
    for (key, value) in params {
        let marker = format!("{{{key}}}");
        if !result.contains(&marker)
            || value.is_empty()
            || value.len() > 4096
            || value == "."
            || value == ".."
        {
            return Err(Error::Invalid(format!("invalid path parameter {key}")));
        }
        let mut escaped = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                escaped.push(byte as char);
            } else {
                escaped.push_str(&format!("%{byte:02X}"));
            }
        }
        result = result.replace(&marker, &escaped);
    }
    if result.contains(['{', '}']) {
        return Err(Error::Invalid("required path parameter is missing".into()));
    }
    Ok(result)
}
