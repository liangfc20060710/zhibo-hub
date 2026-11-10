from __future__ import annotations

import http.client
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT / "python"
HOST = "127.0.0.1"


def _rule(title):
    print("")
    print(f"── {title} " + "─" * max(0, 58 - len(title)))


def run_unit_tests():
    _rule("1 · 内核与 API 单元测试")
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=str(PYTHON_DIR / "tests"), top_level_dir=str(ROOT))
    stream = io.StringIO()
    runner = unittest.TextTestRunner(stream=stream, verbosity=2)
    result = runner.run(suite)
    print(stream.getvalue().strip())
    for failure in list(result.failures) + list(result.errors):
        print(failure[1])
    ok = result.wasSuccessful()
    print(f"{'PASS' if ok else 'FAIL'} · 用例 {result.testsRun} · 失败 {len(result.failures)} · 错误 {len(result.errors)}")
    return ok


def run_kernel_acceptance():
    _rule("2 · 产品内验收探针（isolated runtime）")
    sys.path.insert(0, str(PYTHON_DIR))
    from zhibo.acceptance import run_acceptance
    from zhibo.orchestrator import ZhiboRuntime

    runtime = ZhiboRuntime(emit=lambda *_: None, seed=True, auto_simulate=False)
    started = time.perf_counter()
    report = run_acceptance(runtime, stress_events=800)
    elapsed = time.perf_counter() - started
    try:
        runtime.stopTicker()
    except Exception:
        pass

    groups = {}
    for probe in report["probes"]:
        groups.setdefault(probe["group"], []).append(probe)
    for group, probes in groups.items():
        print(f"\n【{group}】")
        for probe in probes:
            flag = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}[probe["status"]]
            print(f"  {flag}  {probe['title']:<28} {probe['metric']}")

    summary = report["summary"]
    ok = summary["fail"] == 0 and report["score"] >= 90
    print(
        f"\n{'PASS' if ok else 'FAIL'} · 总分 {report['score']} · "
        f"通过 {summary['pass']} · 观察 {summary['warn']} · 失败 {summary['fail']} · 耗时 {elapsed:.2f}s"
    )
    return ok


def _request(port, method, pathname, body=None, timeout=60.0):
    connection = http.client.HTTPConnection(HOST, port, timeout=timeout)
    try:
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"} if payload else {}
        connection.request(method, pathname, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read().decode("utf-8", "replace")
        return response.status, response.getheader("Content-Type", ""), raw
    finally:
        connection.close()


def _wait_health(port, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _, raw = _request(port, "GET", "/api/health", timeout=5)
            if status == 200:
                return json.loads(raw)
        except (OSError, http.client.HTTPException, json.JSONDecodeError):
            time.sleep(0.15)
    raise RuntimeError("服务未能在超时内启动")


def _sse_hello(port, timeout=30.0):
    connection = socket.create_connection((HOST, port), timeout=timeout)
    try:
        connection.sendall(
            b"GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Accept: text/event-stream\r\nConnection: close\r\n\r\n"
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
        return bytes(buffer).decode("utf-8", "replace")
    finally:
        connection.close()


def run_service_smoke():
    _rule("3 · HTTP / SSE / 静态资源 契约")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind((HOST, 0))
    port = listener.getsockname()[1]
    listener.close()

    process = subprocess.Popen(
        [sys.executable, str(PYTHON_DIR / "server.py")],
        cwd=str(ROOT),
        env={**os.environ, "HOST": HOST, "PORT": str(port), "PYTHONIOENCODING": "utf-8"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    checks = []

    def check(name, passed, detail=""):
        checks.append((name, passed, detail))
        print(f"  {'PASS' if passed else 'FAIL'}  {name:<26} {detail}")

    try:
        health = _wait_health(port)
        check("health", health.get("ok") is True, f"{health['name']} v{health['version']} · {health['mode']}")

        status, ctype, raw = _request(port, "GET", "/")
        check("静态控制台", status == 200 and "text/html" in ctype and "智播中枢" in raw, f"{len(raw)} bytes")
        for path in ("/css/app.css", "/css/light.css", "/js/app.js", "/api/state"):
            status, ctype, raw = _request(port, "GET", path)
            check(f"资源 {path.split('/')[-1]}", status == 200 and len(raw) > 200, f"{len(raw)} bytes")

        sse = _sse_hello(port)
        check("SSE hello", sse.startswith("HTTP/1.1 200") and "event: hello" in sse, "text/event-stream")

        status, _, raw = _request(port, "POST", "/api/prepare", {})
        prepare = json.loads(raw)
        check(
            "编排 prepare",
            status == 200 and prepare["result"]["plan"]["version"] == "v1.1",
            f"plan {prepare['result']['plan']['version']} · winner {prepare['result']['contract']['winner']}",
        )

        status, _, raw = _request(port, "POST", "/api/live/start", {})
        check("开播", status == 200 and json.loads(raw)["state"]["session"]["stage"] == "live", "stage=live")

        status, _, raw = _request(
            port, "POST", "/api/danmaku", {"text": "这个茶能放多久？", "user": "自检观众"}
        )
        reply = json.loads(raw)["result"]["result"]["response"]["text"]
        check("弹幕应答", status == 200 and bool(reply), f"{len(reply)} 字")

        status, _, raw = _request(
            port, "POST", "/api/tools/call", {"name": "pricing.change", "args": {"productId": "P-02", "price": 199}}
        )
        check(
            "审批闸门 403",
            status == 403 and json.loads(raw)["error"]["code"] == "APPROVAL_REQUIRED",
            "APPROVAL_REQUIRED",
        )

        status, _, raw = _request(port, "POST", "/api/fault", {"agent": "controller", "action": "offline"})
        check(
            "热备故障转移",
            status == 200 and json.loads(raw)["result"]["replica"] == "controller-b",
            "controller → controller-b",
        )

        status, _, raw = _request(port, "POST", "/api/live/stop", {})
        check("下播", status == 200 and json.loads(raw)["state"]["session"]["stage"] == "ended", "stage=ended")

        status, _, raw = _request(port, "POST", "/api/review", {})
        review = json.loads(raw)["result"]["report"]
        check(
            "复盘 + 因果",
            status == 200 and len(review["causal"]["ci95"]) == 2 and review["lessons"],
            f"ATT {review['causal']['att']:.5f} · p {review['causal']['pValue']:.6f} · 经验 {len(review['lessons'])}",
        )

        status, _, raw = _request(port, "POST", "/api/stress", {"events": 600})
        stress = json.loads(raw)["result"]
        check(
            "压测 600 事件",
            status == 200 and stress["passed"] is True,
            f"P99 {stress['p99']}ms · {stress['throughput']} ev/s",
        )

        status, _, raw = _request(port, "GET", "/api/acceptance?force=1")
        report = json.loads(raw)["report"]
        check(
            "服务端验收探针",
            status == 200 and report["summary"]["fail"] == 0,
            f"score {report['score']} · {report['summary']}",
        )
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)

    failed = [name for name, passed, _ in checks if not passed]
    print(f"\n{'PASS' if not failed else 'FAIL'} · 契约检查 {len(checks) - len(failed)}/{len(checks)}")
    return not failed


def main():
    print("")
    print("  智播中枢 · Python 全链路自检（仅标准库）")
    print(f"  runtime  Python {sys.version.split()[0]} · {sys.executable}")
    print(f"  project  {ROOT}")

    gates = []
    for step in (run_unit_tests, run_kernel_acceptance, run_service_smoke):
        done = []
        try:
            target = threading.Thread(target=lambda: done.append(step()), daemon=True)
            target.start()
            target.join(timeout=300)
            gates.append(bool(done) and done[0] is True)
        except Exception as error:
            print(f"  自检步骤异常：{error}")
            gates.append(False)

    _rule("结论")
    labels = ["单元测试", "验收探针", "服务契约"]
    for label, passed in zip(labels, gates):
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
    if all(gates):
        print("\n  全部通过。启动服务：python python/server.py")
        return 0
    print("\n  存在未通过项，请查看上方明细。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
