from __future__ import annotations

import json
import math
import os
import queue
import selectors
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from zhibo.orchestrator import ZhiboRuntime

HOST = os.environ.get("HOST") or "127.0.0.1"
PORT = int(os.environ.get("PORT") or 4173)
PUBLIC_DIR = os.path.realpath(os.path.join(SCRIPT_DIR, os.pardir, "public"))
MAX_BODY_BYTES = 1024 * 1024
PING_INTERVAL_S = 20.0
CLIENT_QUEUE_SIZE = 2000

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _js_round(value) -> int:
    return int(math.floor(float(value) + 0.5))


def _dumps(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, allow_nan=True)


_hub_lock = threading.Lock()
_clients = set()
_event_seq = 0


class _SseClient:
    __slots__ = ("queue", "done")

    def __init__(self):
        self.queue = queue.Queue(maxsize=CLIENT_QUEUE_SIZE)
        self.done = threading.Event()

    def signal_stop(self):
        try:
            self.queue.put_nowait(None)
        except queue.Full:
            pass


def broadcast(event_type, payload=None):
    global _event_seq
    try:
        with _hub_lock:
            _event_seq += 1
            frame = {"seq": _event_seq, "type": event_type, "payload": payload, "at": _now_ms()}
            data = f"event: {event_type}\ndata: {_dumps(frame)}\n\n".encode("utf-8")
            dead = []
            for client in _clients:
                try:
                    client.queue.put_nowait(data)
                except queue.Full:
                    dead.append(client)
            for client in dead:
                _clients.discard(client)
                client.signal_stop()
    except Exception:
        pass


runtime = ZhiboRuntime(emit=broadcast, seed=True, auto_simulate=True)

_acceptance_cache = None
_acceptance_at = 0
_acceptance_lock = threading.Lock()
_shutdown_once = threading.Event()


def _send_json(handler, status, body):
    data = _dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _fail(handler, status, message, code="BAD_REQUEST"):
    _send_json(handler, status, {"ok": False, "error": {"message": message, "code": code}})


def _read_body(handler):
    transfer_encoding = (handler.headers.get("Transfer-Encoding") or "").lower()
    if "chunked" in transfer_encoding:
        chunks = []
        size = 0
        while True:
            line = handler.rfile.readline(64).strip()
            if not line:
                break
            try:
                length = int(line.split(b";")[0], 16)
            except ValueError:
                raise RuntimeError("请求体不是有效 JSON")
            if length == 0:
                handler.rfile.readline(4)
                break
            size += length
            if size > MAX_BODY_BYTES:
                raise RuntimeError("请求体过大")
            chunks.append(handler.rfile.read(length))
            handler.rfile.readline(2)
        raw = b"".join(chunks)
    else:
        try:
            length = int(handler.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            remaining = MAX_BODY_BYTES
            while remaining > 0:
                chunk = handler.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise RuntimeError("请求体过大")
        raw = handler.rfile.read(length) if length > 0 else b""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError("请求体不是有效 JSON")
    return parsed if isinstance(parsed, dict) else {}


def _await_future(value, timeout=120.0):
    if hasattr(value, "result") and callable(getattr(value, "result")):
        return value.result(timeout=timeout)
    return value


def _serve_static(handler, pathname):
    relative = "index.html" if pathname == "/" else unquote(pathname.lstrip("/"))
    target = os.path.realpath(os.path.join(PUBLIC_DIR, relative))
    if target != PUBLIC_DIR and not target.startswith(PUBLIC_DIR + os.sep):
        return _fail(handler, 403, "禁止访问")
    try:
        if not os.path.isfile(target):
            raise OSError("not a file")
        with open(target, "rb") as handle:
            data = handle.read()
        ext = os.path.splitext(target)[1].lower()
        handler.send_response(200)
        handler.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        handler.send_header("Cache-Control", "no-store" if ext == ".html" else "no-cache")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
        return
    except OSError:
        pass
    if not os.path.splitext(pathname)[1]:
        fallback = os.path.join(PUBLIC_DIR, "index.html")
        try:
            with open(fallback, "rb") as handle:
                data = handle.read()
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html; charset=utf-8")
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("Content-Length", str(len(data)))
            handler.end_headers()
            handler.wfile.write(data)
            return
        except OSError:
            pass
    return _fail(handler, 404, "资源不存在", "NOT_FOUND")


def _run_acceptance():
    global _acceptance_cache, _acceptance_at
    from zhibo.acceptance import run_acceptance

    with _acceptance_lock:
        isolated = ZhiboRuntime(emit=lambda *_: None, seed=True, auto_simulate=False)
        report = run_acceptance(isolated, stress_events=800)
        _acceptance_cache = report
        _acceptance_at = _now_ms()
        return report


def _handle_api_get(handler, pathname, query):
    if pathname == "/api/health" and handler.command == "GET":
        return _send_json(handler, 200, {
            "ok": True,
            "name": "zhibo-hub",
            "version": runtime.version,
            "stage": runtime.session["stage"],
            "uptimeSec": _js_round((_now_ms() - runtime.startedAt) / 1000),
            "clients": len(_clients),
            "mode": "local-deterministic",
        })
    if pathname == "/api/state":
        return _send_json(handler, 200, {"ok": True, "state": runtime.snapshot()})
    if pathname == "/api/events" and handler.command == "GET":
        return _handle_events(handler)
    if pathname == "/api/trace/" and handler.command == "GET":
        return _fail(handler, 400, "缺少 trace id")
    if pathname.startswith("/api/trace/") and handler.command == "GET":
        trace_id = unquote(pathname[len("/api/trace/"):])
        trace = runtime.tracer.summary(runtime.tracer.get(trace_id))
        if not trace:
            return _fail(handler, 404, "Trace 不存在", "NOT_FOUND")
        decisions = [d for d in runtime.decisions if d.get("traceId") == trace_id]
        return _send_json(handler, 200, {"ok": True, "trace": trace, "decisions": decisions})
    if pathname == "/api/acceptance" and handler.command == "GET":
        force = query.get("force") == "1"
        if not force and _acceptance_cache and _now_ms() - _acceptance_at < 60000:
            return _send_json(handler, 200, {"ok": True, "cached": True, "report": _acceptance_cache})
        try:
            report = _run_acceptance()
        except ModuleNotFoundError:
            return _fail(handler, 500, "验收探针模块不可用", "ACCEPTANCE_UNAVAILABLE")
        return _send_json(handler, 200, {"ok": True, "cached": False, "report": report})
    if pathname == "/api/history/sessions" and handler.command == "GET":
        sessions = runtime.persistence.list_sessions(limit=int(query.get("limit") or 20))
        return _send_json(handler, 200, {"ok": True, "sessions": sessions})
    if pathname.startswith("/api/history/sessions/") and handler.command == "GET":
        session_id = unquote(pathname[len("/api/history/sessions/"):])
        detail = runtime.persistence.get_session(session_id)
        if detail is None:
            return _fail(handler, 404, "会话不存在", "NOT_FOUND")
        decisions = runtime.persistence.get_decisions(session_id, limit=40)
        metrics = runtime.persistence.get_metrics_history(session_id, limit=60)
        chat = runtime.persistence.get_chat_log(session_id, limit=60)
        return _send_json(handler, 200, {"ok": True, "session": detail, "decisions": decisions, "metrics": metrics, "chat": chat})
    if pathname.startswith("/api/profile/") and handler.command == "GET":
        user = unquote(pathname[len("/api/profile/"):])
        profile = runtime.userProfile.route(user)
        return _send_json(handler, 200, {"ok": True, "profile": profile})
    if pathname == "/api/llm/config" and handler.command == "GET":
        return _send_json(handler, 200, {"ok": True, "config": runtime.getLlmConfig()})
    return None


def _handle_events(handler):
    handler.close_connection = True
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache, no-transform")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("X-Accel-Buffering", "no")
    handler.end_headers()
    try:
        hello = f"event: hello\ndata: {_dumps({'ok': True, 'state': runtime.snapshot()})}\n\n".encode("utf-8")
        handler.wfile.write(hello)
        handler.wfile.flush()
    except OSError:
        return
    client = _SseClient()
    with _hub_lock:
        _clients.add(client)
    writer = threading.Thread(target=_client_writer_loop, args=(handler, client), daemon=True)
    writer.start()
    client.done.wait()
    writer.join(timeout=5)


def _client_writer_loop(handler, client):
    selector = None
    try:
        selector = selectors.DefaultSelector()
        selector.register(handler.connection, selectors.EVENT_READ)
    except (OSError, ValueError):
        if selector is not None:
            selector.close()
        selector = None
    last_ping = time.time()
    try:
        while not client.done.is_set():
            wait = PING_INTERVAL_S - (time.time() - last_ping)
            if selector is not None:
                wait = min(max(wait, 0.0), 0.5)
            item = None
            got_item = False
            try:
                item = client.queue.get(timeout=max(wait, 0.01))
                got_item = True
            except queue.Empty:
                if selector is not None and selector.select(0):
                    break
            if not got_item:
                if time.time() - last_ping >= PING_INTERVAL_S:
                    item = f": ping {_now_ms()}\n\n".encode("utf-8")
                    last_ping = time.time()
                else:
                    continue
            if item is None:
                break
            try:
                handler.wfile.write(item)
                handler.wfile.flush()
            except (OSError, socket.error, ValueError):
                break
    finally:
        if selector is not None:
            selector.close()
        with _hub_lock:
            _clients.discard(client)
        client.done.set()


def _handle_api_post(handler, pathname, body):
    if pathname == "/api/prepare":
        result = runtime.prepare()
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/live/start":
        result = runtime.startLive()
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/live/stop":
        result = runtime.stopLive()
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/live/pause":
        result = runtime.pauseLive()
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/live/resume":
        result = runtime.resumeLive()
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/danmaku":
        future = runtime.ingestDanmaku(
            body.get("text"),
            user=body.get("user"),
            pool=body.get("pool") if body.get("pool") is not None else "manual",
            simulated=bool(body.get("simulated")),
        )
        result = _await_future(future)
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/scenario":
        result = runtime.runScenario(body.get("type"))
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/review":
        result = runtime.review()
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/fault":
        action = body.get("action") if body.get("action") is not None else "offline"
        result = runtime.setAgentFault(body.get("agent"), action)
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/tools/hotplug":
        spec = runtime.hotplugTool(body)
        return _send_json(handler, 200, {"ok": True, "spec": spec, "state": runtime.snapshot()})
    if pathname == "/api/tools/remove":
        removed = runtime.removeTool(body.get("name"))
        return _send_json(handler, 200, {"ok": True, "removed": removed, "state": runtime.snapshot()})
    if pathname == "/api/tools/call":
        result = runtime.callTool(
            body.get("name"),
            body.get("args") if isinstance(body.get("args"), dict) else {},
            {"traceId": body.get("traceId")},
        )
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/stress":
        events = body.get("events") if body.get("events") is not None else 800
        result = runtime.stressTest(events)
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/chat":
        mode = body.get("mode") if body.get("mode") in ("cmd", "llm") else "cmd"
        result = runtime.chat(body.get("message"), mode=mode)
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/reset":
        global _acceptance_cache, _acceptance_at
        result = runtime.resetSession()
        with _acceptance_lock:
            _acceptance_cache = None
            _acceptance_at = 0
        return _send_json(handler, 200, {"ok": True, "result": result, "state": runtime.snapshot()})
    if pathname == "/api/memory/cases":
        query_text = body.get("query") or body.get("text") or ""
        method = body.get("method") or "fused"
        limit = int(body.get("limit") or 3)
        if method == "bm25":
            hits = runtime.memory.recall_bm25(query_text, limit)
        elif method == "tfidf":
            hits = runtime.memory.recall_tfidf(query_text, limit)
        else:
            hits = runtime.memory.recall_cases(query_text, limit)
        return _send_json(handler, 200, {"ok": True, "method": method, "hits": hits})
    if pathname == "/api/llm/config":
        config = runtime.updateLlmConfig(body)
        return _send_json(handler, 200, {"ok": True, "config": config})
    return _fail(handler, 404, "接口不存在", "NOT_FOUND")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ZhiboHub/1.0"
    _resp_started = False

    def log_message(self, fmt, *args):
        return

    def send_response_only(self, code, message=None):
        self._resp_started = True
        super().send_response_only(code, message)

    def handle_expect_100(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            try:
                _fail(self, 400, "请求体过大")
            except OSError:
                pass
            return False
        return super().handle_expect_100()

    def _dispatch(self):
        parsed = urlparse(self.path or "/")
        pathname = parsed.path
        query = {}
        if parsed.query:
            for pair in parsed.query.split("&"):
                key, _, value = pair.partition("=")
                query.setdefault(unquote(key), unquote(value))
        method = self.command
        try:
            if not pathname.startswith("/api/"):
                return _serve_static(self, pathname)
            if pathname in ("/api/health", "/api/events", "/api/trace/", "/api/acceptance", "/api/history/sessions", "/api/llm/config") or pathname.startswith("/api/trace/") or pathname.startswith("/api/history/sessions/") or pathname.startswith("/api/profile/"):
                handled = _handle_api_get(self, pathname, query)
                if handled is not None or method != "POST":
                    return
            elif pathname != "/api/state" and method != "POST":
                return _fail(self, 405, "方法不允许", "METHOD_NOT_ALLOWED")
            if pathname == "/api/state":
                return _handle_api_get(self, pathname, query)
            if method == "POST":
                body = _read_body(self)
                return _handle_api_post(self, pathname, body)
            return _fail(self, 405, "方法不允许", "METHOD_NOT_ALLOWED")
        except Exception as error:
            self.close_connection = True
            code = getattr(error, "code", None)
            status = 403 if code == "APPROVAL_REQUIRED" else 400
            message = str(error) or "请求失败"
            if not self._resp_started:
                try:
                    _fail(self, status, message, code or "BAD_REQUEST")
                except OSError:
                    pass

    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()


httpd = None


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, OSError):
            return
        super().handle_error(request, client_address)


def shutdown():
    if _shutdown_once.is_set():
        return
    _shutdown_once.set()
    try:
        broadcast("system.shutdown", {"at": _now_ms()})
    except Exception:
        pass
    with _hub_lock:
        targets = list(_clients)
        _clients.clear()
    for client in targets:
        client.signal_stop()
    deadline = time.time() + 1.0
    for client in targets:
        remaining = max(0.0, deadline - time.time())
        client.done.wait(remaining)
    try:
        runtime.stopTicker()
    except Exception:
        pass
    if httpd is not None:
        threading.Thread(target=httpd.shutdown, daemon=True).start()


def _on_term(signum, frame):
    threading.Thread(target=shutdown, daemon=True).start()


def main():
    global httpd
    signal.signal(signal.SIGINT, signal.default_int_handler)
    for name in ("SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _on_term)
            except (ValueError, OSError):
                pass
    httpd = Server((HOST, PORT), Handler)
    print("")
    print("  智播中枢 · ZHIBO NEXUS")
    print(f"  API + 控制台  http://{HOST}:{PORT}")
    print("  本地确定性内核 · 零外部依赖 · 演示数据")
    print("", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()
