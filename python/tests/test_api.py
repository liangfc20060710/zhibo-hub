from __future__ import annotations

import http.client
import json
import math
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

HOST = "127.0.0.1"
SERVER_PATH = ROOT / "python" / "server.py"
BOOT_TIMEOUT_S = 30.0
REQUEST_TIMEOUT_S = 120.0


def free_port():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind((HOST, 0))
        return listener.getsockname()[1]
    finally:
        listener.close()


def request_json(port, method, pathname, body=None, timeout=REQUEST_TIMEOUT_S):
    connection = http.client.HTTPConnection(HOST, port, timeout=timeout)
    try:
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, pathname, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = None
        return response.status, parsed
    finally:
        connection.close()


def wait_for_health(port, timeout=BOOT_TIMEOUT_S):
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            status, payload = request_json(port, "GET", "/api/health", timeout=5)
            if status == 200 and isinstance(payload, dict) and payload.get("ok"):
                return payload
        except (OSError, http.client.HTTPException) as error:
            last_error = error
        time.sleep(0.15)
    raise RuntimeError(f"server did not become healthy: {last_error}")


def read_sse_hello(port, timeout=REQUEST_TIMEOUT_S):
    connection = socket.create_connection((HOST, port), timeout=timeout)
    try:
        connection.sendall(
            b"GET /api/events HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Accept: text/event-stream\r\n"
            b"Connection: close\r\n\r\n"
        )
        buffer = bytearray()
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            buffer.extend(chunk)
            head = buffer.find(b"\r\n\r\n")
            if head != -1 and b"\n\n" in bytes(buffer[head + 4:]):
                break
        raw = bytes(buffer).decode("utf-8", "replace")
    finally:
        connection.close()
    head = raw.find("\r\n\r\n")
    if head == -1:
        raise RuntimeError("SSE 响应缺少头部")
    return raw.splitlines()[0], raw[:head].lower(), raw[head + 4:]


def is_finite(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


class ApiTest(unittest.TestCase):
    def test_http_api_full_operating_loop_security_gates_and_sse(self):
        port = free_port()
        log_file = tempfile.TemporaryFile(mode="w+b")
        process = subprocess.Popen(
            [sys.executable, str(SERVER_PATH)],
            cwd=str(ROOT),
            env={**os.environ, "PORT": str(port), "HOST": HOST, "PYTHONIOENCODING": "utf-8"},
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
        try:
            health = wait_for_health(port)
            self.assertIs(health["ok"], True)
            self.assertEqual(health["mode"], "local-deterministic")
            self.assertEqual(health["stage"], "prep")

            status, initial = request_json(port, "GET", "/api/state")
            self.assertEqual(status, 200)
            self.assertIs(initial["ok"], True)
            self.assertEqual(len(initial["state"]["agents"]), 6)
            self.assertGreaterEqual(len(initial["state"]["tools"]), 15)
            self.assertEqual(initial["state"]["session"]["stage"], "prep")

            status_line, sse_headers, sse_body = read_sse_hello(port)
            self.assertTrue(status_line.startswith("HTTP/1.1 200"), status_line)
            self.assertIn("text/event-stream", sse_headers)
            self.assertIn("charset=utf-8", sse_headers)
            self.assertTrue(sse_body.startswith("event: hello"), "SSE 首帧必须是 hello")
            self.assertRegex(sse_body, r'"stage"\s*:\s*"prep"')

            status, prepare = request_json(port, "POST", "/api/prepare", {})
            self.assertEqual(status, 200)
            self.assertEqual(prepare["result"]["plan"]["version"], "v1.1")
            self.assertEqual(prepare["result"]["contract"]["winner"], "selector")
            self.assertEqual(prepare["state"]["session"]["stage"], "ready")
            self.assertGreaterEqual(len(prepare["state"]["metricsHistory"]), 1)

            trace_id = prepare["result"]["trace"]["id"]
            status, trace = request_json(port, "GET", f"/api/trace/{quote(trace_id)}")
            self.assertEqual(status, 200)
            self.assertEqual(trace["trace"]["id"], trace_id)
            self.assertGreaterEqual(len(trace["trace"]["spans"]), 3)

            status, live = request_json(port, "POST", "/api/live/start", {})
            self.assertEqual(status, 200)
            self.assertEqual(live["state"]["session"]["stage"], "live")

            status, danmaku = request_json(
                port,
                "POST",
                "/api/danmaku",
                {"text": "这款凤凰蜜兰单丛怎么冲泡？", "user": "验收观众"},
            )
            self.assertEqual(status, 200)
            self.assertTrue(danmaku["result"]["result"]["response"]["text"])
            self.assertEqual(danmaku["state"]["danmaku"][-1]["text"], "这款凤凰蜜兰单丛怎么冲泡？")

            status, blocked = request_json(
                port,
                "POST",
                "/api/tools/call",
                {"name": "pricing.change", "args": {"productId": "P-02", "price": 199}},
            )
            self.assertEqual(status, 403)
            self.assertEqual(blocked["error"]["code"], "APPROVAL_REQUIRED")

            status, negative = request_json(port, "POST", "/api/scenario", {"type": "negative"})
            self.assertEqual(status, 200)
            self.assertEqual(negative["result"]["injected"], 3)
            self.assertGreaterEqual(len(negative["state"]["consensusHistory"]), 1)
            incident_vote = negative["state"]["consensusHistory"][0]
            self.assertGreaterEqual(incident_vote["weight"], incident_vote["threshold"])

            status, coupon = request_json(port, "POST", "/api/scenario", {"type": "coupon"})
            self.assertEqual(status, 200)
            self.assertIs(coupon["result"]["vote"]["approved"], True)
            self.assertTrue(coupon["result"]["vote"]["approvalId"])
            self.assertTrue(coupon["result"]["coupon"]["label"])
            self.assertEqual(coupon["state"]["coupon"]["label"], coupon["result"]["coupon"]["label"])

            status, price = request_json(port, "POST", "/api/scenario", {"type": "price"})
            self.assertEqual(status, 200)
            self.assertEqual(price["result"]["veto"]["code"], "PRICE_FLOOR")

            status, fault = request_json(
                port, "POST", "/api/fault", {"agent": "controller", "action": "offline"}
            )
            self.assertEqual(status, 200)
            self.assertEqual(fault["result"]["replica"], "controller-b")
            status, restored = request_json(
                port, "POST", "/api/fault", {"agent": "controller", "action": "restore"}
            )
            self.assertEqual(status, 200)

            status, hotplug = request_json(
                port,
                "POST",
                "/api/tools/hotplug",
                {
                    "name": "qa.margin",
                    "category": "验收",
                    "handlerType": "margin_calc",
                    "riskLevel": "low",
                    "description": "验收用毛利工具",
                },
            )
            self.assertEqual(status, 200)
            self.assertEqual(hotplug["spec"]["source"], "hotplug")

            status, tool_call = request_json(
                port, "POST", "/api/tools/call", {"name": "qa.margin", "args": {"price": 199, "cost": 80}}
            )
            self.assertEqual(status, 200)
            self.assertTrue(is_finite(tool_call["result"]["result"]["grossMargin"]))

            status, removed = request_json(port, "POST", "/api/tools/remove", {"name": "qa.margin"})
            self.assertEqual(status, 200)
            self.assertIs(removed["removed"], True)

            status, chat = request_json(port, "POST", "/api/chat", {"message": "查看当前状态"})
            self.assertEqual(status, 200)
            self.assertGreater(len(chat["result"]["message"]["text"]), 10)
            self.assertEqual(chat["state"]["chat"][-1]["role"], "assistant")

            status, stress = request_json(port, "POST", "/api/stress", {"events": 400})
            self.assertEqual(status, 200)
            self.assertEqual(stress["result"]["events"], 400)
            self.assertLessEqual(stress["result"]["p99"], stress["result"]["targetP99"])
            self.assertTrue(stress["state"]["loadTest"])

            status, stop = request_json(port, "POST", "/api/live/stop", {})
            self.assertEqual(status, 200)
            self.assertEqual(stop["state"]["session"]["stage"], "ended")

            status, review = request_json(port, "POST", "/api/review", {})
            self.assertEqual(status, 200)
            self.assertEqual(review["state"]["session"]["stage"], "reviewed")
            self.assertTrue(is_finite(review["result"]["report"]["causal"]["pValue"]))
            self.assertEqual(len(review["result"]["report"]["causal"]["ci95"]), 2)

            status, review_chat = request_json(
                port, "POST", "/api/chat", {"message": "复盘并解释发券效果"}
            )
            self.assertEqual(status, 200)
            self.assertEqual(
                review_chat["state"]["session"]["stage"], "reviewed", "review chat must not restart live"
            )
            self.assertEqual(
                review_chat["state"]["session"]["id"], review["state"]["session"]["id"]
            )
            self.assertEqual(
                (review_chat["state"].get("coupon") or {}).get("id"),
                coupon["state"]["coupon"]["id"],
                "review chat must not reissue a coupon",
            )
            self.assertRegex(review_chat["result"]["message"]["text"], "因果结论")

            status, acceptance = request_json(port, "GET", "/api/acceptance?force=1")
            self.assertEqual(status, 200)
            self.assertGreaterEqual(acceptance["report"]["score"], 90)
            self.assertEqual(acceptance["report"]["summary"]["fail"], 0)

            status, reset = request_json(port, "POST", "/api/reset", {})
            self.assertEqual(status, 200)
            self.assertEqual(reset["state"]["session"]["stage"], "prep")
            self.assertIsNone(reset["state"]["plan"])
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            log_file.seek(0)
            server_log = log_file.read().decode("utf-8", "replace")
            log_file.close()

        self.assertNotIn("Traceback (most recent call last)", server_log)


if __name__ == "__main__":
    unittest.main()
