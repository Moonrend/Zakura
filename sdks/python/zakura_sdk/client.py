# SPDX-License-Identifier: AGPL-3.0-only
from __future__ import annotations

import copy
import json
import math
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Iterator, Mapping, Protocol
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request as URLRequest, build_opener


@dataclass(frozen=True)
class Request:
    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes | None = None


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)

    def text(self, encoding: str = "utf-8") -> str:
        return self.body.decode(encoding)

    def header(self, name: str) -> str | None:
        return next((value for key, value in self.headers.items() if key.lower() == name.lower()), None)


class APIError(Exception):
    def __init__(self, method: str, path: str, response: Response):
        super().__init__(f"Zakura {method} {path} returned HTTP {response.status}")
        self.status = response.status
        self.response = response
        self.request_id = response.header("X-Request-ID")


class Transport(Protocol):
    def send(self, request: Request, timeout: float, max_bytes: int) -> Response: ...


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HTTPTransport:
    def __init__(self):
        self._opener = build_opener(NoRedirect())

    def send(self, request: Request, timeout: float, max_bytes: int) -> Response:
        req = URLRequest(request.url, data=request.body, headers=dict(request.headers), method=request.method)
        try:
            stream = self._opener.open(req, timeout=timeout)
        except HTTPError as error:
            stream = error
        with stream:
            body = stream.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise ValueError("response exceeds configured byte limit")
            return Response(stream.code, dict(stream.headers), body)


@dataclass(frozen=True)
class CallOptions:
    query: Mapping[str, Any] = field(default_factory=dict)
    headers: Mapping[str, str] = field(default_factory=dict)
    json_body: Any = None
    has_json_body: bool = False
    raw_body: bytes | None = None
    content_type: str | None = None
    timeout: float | None = None


class Client:
    def __init__(self, base_url: str, token: str | Callable[[], str] = "", *,
                 transport: Transport | None = None, timeout: float = 30,
                 max_response_bytes: int = 8 * 1024 * 1024, max_attempts: int = 1,
                 base_delay: float = 0.25, max_delay: float = 2):
        url = urlsplit(base_url)
        if url.scheme not in ("http", "https") or not url.netloc or url.username is not None or url.password is not None or url.query or url.fragment:
            raise ValueError("base URL must be absolute HTTP(S), without credentials, query or fragment")
        if type(max_attempts) is not int or type(max_response_bytes) is not int or not 1 <= max_attempts <= 8 or not 1 <= max_response_bytes <= 1024**3:
            raise ValueError("invalid attempts or response byte limit")
        if not all(math.isfinite(value) for value in (timeout, base_delay, max_delay)) or not 0 < timeout <= 86400 or not 0 <= base_delay <= 86400 or not 0 < max_delay <= 86400:
            raise ValueError("invalid timeout or retry delay")
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._transport = transport if transport is not None else HTTPTransport()
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self.max_attempts = max_attempts
        self.base_delay = base_delay
        self.max_delay = max_delay

    def build(self, method: str, path: str, parameters: Mapping[str, str], options: CallOptions) -> Request:
        if not path.startswith("/") or "?" in path or "#" in path:
            raise ValueError("route must be an absolute path without query or fragment")
        for key, value in parameters.items():
            marker = "{" + key + "}"
            if marker not in path or not isinstance(value, str) or not value or len(value.encode()) > 4096 or value in (".", ".."):
                raise ValueError(f"invalid path parameter {key}")
            escaped = quote(value, safe="")
            path = path.replace(marker, escaped)
        if "{" in path or "}" in path:
            raise ValueError("required path parameter is missing")
        headers = {key.lower(): value for key, value in options.headers.items()}
        if any("\r" in key + value or "\n" in key + value for key, value in headers.items()):
            raise ValueError("headers contain newline characters")
        headers.setdefault("accept", "application/json")
        headers["user-agent"] = "zakura-python-sdk/1"
        token = self._token() if callable(self._token) else self._token
        if "\r" in token or "\n" in token:
            raise ValueError("token contains newline characters")
        if token:
            headers["authorization"] = "Bearer " + token
        if options.has_json_body and options.raw_body is not None:
            raise ValueError("JSON and raw bodies are mutually exclusive")
        body = options.raw_body
        if options.has_json_body:
            body = json.dumps(options.json_body, ensure_ascii=False, allow_nan=False).encode()
            headers["content-type"] = "application/json"
        elif options.content_type:
            headers["content-type"] = options.content_type
        target = self.base_url + path
        if options.query:
            target += "?" + urlencode(options.query, doseq=True)
        return Request(method, target, headers, body)

    def _delay(self, attempt: int, response: Response) -> float:
        delay = min(self.base_delay * 2**attempt, self.max_delay)
        value = response.header("Retry-After")
        if value is not None:
            try:
                delay = float(value)
            except ValueError:
                try:
                    when = parsedate_to_datetime(value)
                    if when.tzinfo is None:
                        when = when.replace(tzinfo=timezone.utc)
                    delay = (when - datetime.now(timezone.utc)).total_seconds()
                except (ValueError, TypeError, OverflowError):
                    pass
        return min(max(delay, 0), self.max_delay) if math.isfinite(delay) else min(self.base_delay, self.max_delay)

    def execute(self, method: str, path: str, parameters: Mapping[str, str], options: CallOptions) -> Response:
        timeout = self.timeout if options.timeout is None else options.timeout
        if not math.isfinite(timeout) or not 0 < timeout <= 86400:
            raise ValueError("timeout must be positive")
        deadline = time.monotonic() + timeout
        attempts = self.max_attempts if method in ("GET", "HEAD") else 1
        for attempt in range(attempts):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("request deadline exceeded")
            request = self.build(method, path, parameters, options)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("request deadline exceeded during request construction")
            response = self._transport.send(request, remaining, self.max_response_bytes)
            if time.monotonic() >= deadline:
                raise TimeoutError("request deadline exceeded")
            if len(response.body) > self.max_response_bytes:
                raise ValueError("response exceeds configured byte limit")
            if 200 <= response.status < 300:
                return response
            if response.status not in (429, 502, 503, 504) or attempt + 1 == attempts:
                raise APIError(method, path, response)
            delay = self._delay(attempt, response)
            if delay >= deadline - time.monotonic():
                raise TimeoutError("retry would exceed request deadline")
            time.sleep(delay)
        raise RuntimeError("unreachable retry state")


class Endpoint:
    method: str
    path: str

    def __init__(self, client: Client, parameters: Mapping[str, str], options: CallOptions | None = None):
        self._client = client
        self._parameters = dict(parameters)
        self._options = options or CallOptions()

    def _with(self, **changes):
        return type(self)(self._client, self._parameters, replace(self._options, **changes))

    def with_query(self, **values):
        return self._with(query=copy.deepcopy(values))

    def with_headers(self, headers: Mapping[str, str]):
        return self._with(headers=dict(headers))

    def with_timeout(self, seconds: float):
        return self._with(timeout=seconds)

    def with_json(self, body: Any):
        return self._with(json_body=copy.deepcopy(body), has_json_body=True, raw_body=None)

    def with_raw(self, body: bytes, content_type: str):
        return self._with(raw_body=bytes(body), content_type=content_type, has_json_body=False)

    def build(self) -> Request:
        return self._client.build(self.method, self.path, self._parameters, self._options)

    def execute(self) -> Response:
        return self._client.execute(self.method, self.path, self._parameters, self._options)

    def json(self) -> Any:
        return self.execute().json()

    def pages(self, cursor_key: str, next_cursor: Callable[[Response], str | None], *, max_pages: int = 1000) -> Iterator[Response]:
        if self.method != "GET" or not cursor_key or type(max_pages) is not int or not 1 <= max_pages <= 10000:
            raise ValueError("invalid pagination configuration")
        current = self
        seen = set()
        for _ in range(max_pages):
            response = current.execute()
            yield response
            cursor = next_cursor(response)
            if not cursor:
                return
            if cursor in seen:
                raise ValueError("pagination repeated a cursor")
            seen.add(cursor)
            query = dict(current._options.query)
            query[cursor_key] = cursor
            current = current._with(query=query)
        raise ValueError("pagination reached configured page limit")
