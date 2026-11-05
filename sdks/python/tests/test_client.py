import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from zakura_sdk import Client, APIError
from zakura_sdk.client import Response


class FakeTransport:
    def __init__(self, statuses=(200,), body=b'{"ok":true}'):
        self.calls = []
        self.statuses = iter(statuses)
        self.body = body

    def send(self, request, timeout, max_bytes):
        self.calls.append((request, timeout, max_bytes))
        return Response(next(self.statuses), {"Retry-After": "0", "X-Request-ID": "trace"}, self.body)


class ClientTests(unittest.TestCase):
    def test_path_query_headers_and_snapshot(self):
        client = Client("https://example.test/prefix", "secret")
        tags = ["one", "two"]
        headers = {"X-Trace": "original", "authorization": "override"}
        original = client.get_api_agents_by_id("猫 /?%")
        builder = original.with_query(tag=tags).with_headers(headers)
        tags.append("changed")
        headers["X-Trace"] = "changed"
        request = builder.build()
        self.assertEqual(urlsplit(request.url).path, "/prefix/api/agents/%E7%8C%AB%20%2F%3F%25")
        self.assertEqual(parse_qs(urlsplit(request.url).query)["tag"], ["one", "two"])
        self.assertEqual(request.headers["authorization"], "Bearer secret")
        self.assertEqual(request.headers["x-trace"], "original")
        self.assertEqual(urlsplit(original.build().url).query, "")
        for invalid in ("", ".", ".."):
            with self.assertRaises(ValueError):
                client.get_api_agents_by_id(invalid).build()

    def test_read_retry_but_no_mutation_retry(self):
        transport = FakeTransport((503, 200))
        client = Client("https://example.test", transport=transport, max_attempts=3, base_delay=0)
        self.assertEqual(client.get_api_agents().json(), {"ok": True})
        self.assertEqual(len(transport.calls), 2)
        transport = FakeTransport((503, 200))
        client = Client("https://example.test", transport=transport, max_attempts=3)
        with self.assertRaises(APIError) as raised:
            client.post_api_agents().with_json({"name": "test"}).execute()
        self.assertEqual(raised.exception.status, 503)
        self.assertEqual(raised.exception.request_id, "trace")
        self.assertEqual(len(transport.calls), 1)

    def test_json_null_raw_and_owned_body(self):
        client = Client("https://example.test")
        body = {"name": "original"}
        builder = client.post_api_agents().with_json(body)
        body["name"] = "changed"
        self.assertEqual(json.loads(builder.build().body), {"name": "original"})
        self.assertEqual(client.post_api_agents().with_json(None).build().body, b"null")
        request = client.post_oauth_token().with_raw(b"a=b", "application/x-www-form-urlencoded").build()
        self.assertEqual(request.body, b"a=b")
        self.assertEqual(request.headers["content-type"], "application/x-www-form-urlencoded")

    def test_limits_and_cursor_guard(self):
        client = Client("https://example.test", transport=FakeTransport(body=b"large"), max_response_bytes=3)
        with self.assertRaisesRegex(ValueError, "byte limit"):
            client.get_api_agents().execute()
        client = Client("https://example.test", transport=FakeTransport((200, 200, 200)))
        with self.assertRaisesRegex(ValueError, "repeated"):
            list(client.get_api_agents().pages("cursor", lambda response: "same", max_pages=4))

    def test_validation_and_deadline_after_token(self):
        for url in ("relative", "ftp://example.test", "https://u:p@example.test", "https://example.test?q=1", "https://example.test#f"):
            with self.assertRaises(ValueError):
                Client(url)
        for kwargs in ({"max_attempts": 1.5}, {"max_attempts": True}, {"timeout": float("nan")}, {"base_delay": float("inf")}):
            with self.assertRaises(ValueError):
                Client("https://example.test", **kwargs)
        with self.assertRaisesRegex(ValueError, "newline"):
            Client("https://example.test", "bad\nvalue").get_api_agents().build()
        transport = FakeTransport()
        def slow_token():
            time.sleep(0.02)
            return "secret"
        client = Client("https://example.test", slow_token, transport=transport, timeout=0.005)
        with self.assertRaises(TimeoutError):
            client.get_api_agents().execute()
        self.assertEqual(transport.calls, [])

    def test_real_http_does_not_follow_redirect(self):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                calls.append((self.path, self.headers.get("Authorization")))
                self.send_response(302)
                self.send_header("Location", "/target")
                self.send_header("Content-Length", "0")
                self.end_headers()
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = Client(f"http://127.0.0.1:{server.server_port}", "secret")
            with self.assertRaises(APIError) as raised:
                client.get_api_agents().execute()
            self.assertEqual(raised.exception.status, 302)
            self.assertEqual(calls, [("/api/agents", "Bearer secret")])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
