#!/usr/bin/env python3
"""Browser acceptance for 智播中枢, driven over the Chrome DevTools Protocol.

Only the Python standard library is used: a minimal WebSocket client talks to a
headless Chrome/Edge instance, walks the five-stage flow, captures screenshots
into shots/ and fails on console errors or layout regressions.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "shots"
BASE = "http://127.0.0.1:4173"
DEBUG_PORT = 9333

RESULTS: list[tuple[bool, str, str]] = []


def record(ok: bool, label: str, detail: str = "") -> bool:
    RESULTS.append((bool(ok), label, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  · ' + detail) if detail else ''}")
    return ok


# --------------------------------------------------------------------------- WS


class WebSocket:
    def __init__(self, url: str):
        if not url.startswith("ws://"):
            raise ValueError(f"unsupported websocket url: {url}")
        hostport, _, path = url[5:].partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("websocket handshake closed")
            buffer += chunk
        head, _, tail = buffer.partition(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            raise ConnectionError(f"handshake failed: {status.decode(errors='replace')}")
        self.buffer = tail

    def _read(self, size: int) -> bytes:
        while len(self.buffer) < size:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("websocket closed")
            self.buffer += chunk
        out, self.buffer = self.buffer[:size], self.buffer[size:]
        return out

    def _frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send(self, text: str) -> None:
        self._frame(0x1, text.encode())

    def recv(self) -> str:
        parts: list[bytes] = []
        while True:
            first, second = self._read(2)
            fin = first & 0x80
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if second & 0x80 else None
            data = self._read(length)
            if mask:
                data = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
            if opcode == 0x9:
                self._frame(0xA, data)
                continue
            if opcode == 0x8:
                raise ConnectionError("websocket closed by peer")
            if opcode in (0x0, 0x1, 0x2):
                parts.append(data)
                if fin:
                    return b"".join(parts).decode()

    def close(self) -> None:
        try:
            self._frame(0x8, b"")
        finally:
            self.sock.close()


class CDP:
    def __init__(self, ws_url: str):
        self.ws = WebSocket(ws_url)
        self.next_id = 0
        self.events: list[dict] = []

    def call(self, method: str, params: dict | None = None, timeout: float = 90):
        self.next_id += 1
        message_id = self.next_id
        self.ws.sock.settimeout(timeout)
        self.ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            if "method" in message:
                if len(self.events) < 600:
                    self.events.append(message)

    def evaluate(self, expression: str, *, await_promise: bool = False, timeout: float = 60):
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            text = details.get("exception", {}).get("description") or details.get("text")
            raise RuntimeError(f"JS error: {text}")
        return result.get("result", {}).get("value")

    def wait_for(self, expression: str, timeout: float = 30, interval: float = 0.3) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.evaluate(expression, timeout=15):
                    return True
            except Exception:
                pass
            time.sleep(interval)
        return False

    def click(self, selector: str) -> bool:
        script = f"""(() => {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return false;
            el.click();
            return true;
        }})()"""
        return bool(self.evaluate(script))


# ------------------------------------------------------------------ browser


def find_browser() -> Path:
    candidates = [
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise SystemExit("未找到 Chrome 或 Edge，无法运行浏览器验收。")


def page_target() -> dict:
    for _ in range(160):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/list", timeout=2) as response:
                targets = json.load(response)
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return target
        except Exception:
            pass
        time.sleep(0.25)
    raise SystemExit("CDP 调试端口未就绪。")


def reset_state() -> None:
    request = urllib.request.Request(
        BASE + "/api/reset",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.load(response)
        stage = payload.get("result", {}).get("stage", "?")
        print(f"RESET 演示状态 · {stage}")
    except Exception as error:
        raise SystemExit(f"无法重置演示状态：{error}")


def check_assets() -> None:
    for path in ("/css/experience.css", "/js/app.js", "/js/views.js", "/js/ui.js"):
        try:
            with urllib.request.urlopen(BASE + path, timeout=5) as response:
                size = len(response.read())
            record(response.status == 200 and size > 1000, f"静态资源 {path}", f"{size} bytes")
        except Exception as error:
            record(False, f"静态资源 {path}", str(error))


# ------------------------------------------------------------------ steps


def shot(cdp: CDP, name: str) -> None:
    result = cdp.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
    (SHOTS / name).write_bytes(base64.b64decode(result["data"]))
    print(f"SHOT  shots/{name}")


def set_viewport(cdp: CDP, width: int, height: int) -> None:
    cdp.call(
        "Emulation.setDeviceMetricsOverride",
        {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False},
    )


def console_errors(cdp: CDP) -> list[str]:
    try:
        cdp.evaluate("1")  # drain buffered protocol events
    except Exception:
        pass
    problems: list[str] = []
    for event in cdp.events:
        method = event.get("method")
        params = event.get("params", {})
        if method == "Runtime.exceptionThrown":
            detail = params.get("exceptionDetails", {})
            text = detail.get("exception", {}).get("description") or detail.get("text")
            problems.append(f"exception: {text}")
        elif method == "Runtime.consoleAPICalled" and params.get("type") in {"error", "assert"}:
            args = " ".join(str(arg.get("value", arg.get("description", ""))) for arg in params.get("args", []))
            problems.append(f"console.{params.get('type')}: {args[:200]}")
        elif method == "Log.entryAdded" and params.get("entry", {}).get("level") == "error":
            problems.append(f"log: {params['entry'].get('text', '')[:200]}")
    deduped = list(dict.fromkeys(problems))
    return deduped


def main() -> int:
    SHOTS.mkdir(exist_ok=True)
    reset_state()
    check_assets()

    profile = Path(tempfile.mkdtemp(prefix="zhibo-cdp-"))
    browser = find_browser()
    print(f"浏览器 · {browser}")
    proc = subprocess.Popen(
        [
            str(browser),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--mute-audio",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            f"--remote-debugging-port={DEBUG_PORT}",
            f"--user-data-dir={profile}",
            "--window-size=1600,1000",
            f"{BASE}/",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    cdp: CDP | None = None
    try:
        target = page_target()
        cdp = CDP(target["webSocketDebuggerUrl"])
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")
        cdp.call("Log.enable")

        ready = cdp.wait_for("!!window.__NEXUS__ && !!window.__NEXUS__.state", timeout=40)
        record(ready, "应用启动并拿到运行状态")
        if not ready:
            print("console:", console_errors(cdp))
            raise SystemExit(1)
        time.sleep(1.4)

        # --- coach marks on first visit -------------------------------------
        coach = cdp.wait_for("!!document.querySelector('#coach-root.open .coach-card')", timeout=12)
        record(coach, "首次进入出现 3 步引导")
        if coach:
            shot(cdp, "01-coach.png")
            steps = cdp.evaluate("document.querySelectorAll('.coach-dots i').length")
            record(steps == 3, "引导步骤数", f"{steps}")
            for _ in range(2):
                cdp.click("[data-coach='next']")
                time.sleep(0.45)
            cdp.click("[data-coach='next']")
            time.sleep(0.5)
            saved = cdp.evaluate("localStorage.getItem('nexus.coach.v1')")
            record(saved == "done", "引导完成后写入 localStorage", str(saved))
            record(
                not cdp.evaluate("!!document.querySelector('#coach-root.open')"),
                "引导层已关闭",
            )
        time.sleep(0.4)

        # --- first screen hierarchy ----------------------------------------
        layout = cdp.evaluate(
            """(() => {
              const kpis = [...document.querySelectorAll('.kpi2')];
              const heights = kpis.map((el) => Math.round(el.getBoundingClientRect().height));
              const font = (sel) => {
                const el = document.querySelector(sel);
                return el ? getComputedStyle(el).fontSize : null;
              };
              const flow = document.querySelector('.flow-bar');
              const firstKpi = kpis[0];
              const stage = document.querySelector('.stage-head');
              return {
                kpis: kpis.length,
                uniqueHeights: [...new Set(heights)],
                flowVisible: !!flow,
                flowSteps: document.querySelectorAll('.flow-step').length,
                current: document.querySelector('.flow-step.is-current b')?.textContent ?? null,
                primary: document.querySelector('.stage-head .btn.primary')?.textContent.trim() ?? null,
                kpiFont: font('.kpi2-label'),
                flowFont: font('.flow-copy small'),
                navFont: font('.nav-copy small'),
                badgeFont: font('.badge'),
                kpiTop: firstKpi ? Math.round(firstKpi.getBoundingClientRect().top) : null,
                stageTop: stage ? Math.round(stage.getBoundingClientRect().top) : null
              };
            })()"""
        )
        record(layout["kpis"] == 4, "首屏 4 张等宽 KPI 卡", str(layout["kpis"]))
        record(len(layout["uniqueHeights"]) == 1, "KPI 卡同高对齐", str(layout["uniqueHeights"]))
        record(layout["flowVisible"] and layout["flowSteps"] == 5, "五阶段流程条", f"{layout['flowSteps']} 步")
        record(layout["current"] == "筹备", "当前阶段高亮=筹备", str(layout["current"]))
        record(layout["primary"] == "生成直播方案", "首屏唯一主按钮", str(layout["primary"]))
        sizes = [layout["kpiFont"], layout["flowFont"], layout["navFont"], layout["badgeFont"]]
        record(
            all(size and float(size.replace("px", "")) >= 11 for size in sizes),
            "关键标签字号 ≥ 11px",
            f"kpi {layout['kpiFont']} / flow {layout['flowFont']} / nav {layout['navFont']} / badge {layout['badgeFont']}",
        )
        record(
            layout["stageTop"] is not None
            and layout["kpiTop"] is not None
            and layout["kpiTop"] - layout["stageTop"] < 260,
            "KPI 仍位于首屏上方",
            f"stage {layout['stageTop']}px → kpi {layout['kpiTop']}px",
        )
        shot(cdp, "02-overview-prep.png")

        # --- prepare -> launch -> interact ---------------------------------
        record(cdp.click(".stage-head [data-act='prepare']"), "点击首屏主按钮生成方案")
        record(cdp.wait_for("!!window.__NEXUS__.state.plan", timeout=70), "直播方案已生成")
        time.sleep(0.6)
        primary = cdp.evaluate("document.querySelector('.stage-head .btn.primary')?.textContent.trim()")
        record(primary == "开始直播", "主按钮切换为开始直播", str(primary))
        shot(cdp, "03-overview-ready.png")

        record(cdp.click(".stage-head [data-act='live-start']"), "点击开始直播")
        record(cdp.wait_for("window.__NEXUS__.state.session.stage === 'live'", timeout=30), "进入直播阶段")
        time.sleep(2.6)
        record(
            cdp.evaluate("document.querySelector('.flow-step.is-current b')?.textContent") == "实时互动",
            "流程条高亮实时互动",
        )
        shot(cdp, "04-live.png")

        # --- function map ---------------------------------------------------
        record(cdp.click(".topbar-actions [data-act='function-map']"), "打开功能地图")
        record(cdp.wait_for("!!document.querySelector('.map-root.open')", timeout=8), "功能地图弹窗可见")
        map_views = cdp.evaluate("document.querySelectorAll('.map-view').length")
        record(map_views == 7, "功能地图覆盖 7 个工作区", str(map_views))
        shot(cdp, "05-function-map.png")
        record(cdp.click(".map-close"), "关闭功能地图")
        time.sleep(0.5)

        # --- pause / resume -------------------------------------------------
        cdp.evaluate("window.__NEXUS__.navigate('overview')")
        time.sleep(0.8)
        record(cdp.click(".stage-head [data-act='live-pause']"), "点击暂停")
        record(cdp.wait_for("window.__NEXUS__.state.session.stage === 'paused'", timeout=20), "进入暂停阶段")
        record(cdp.click(".stage-head [data-act='live-resume']"), "点击继续直播")
        record(cdp.wait_for("window.__NEXUS__.state.session.stage === 'live'", timeout=20), "恢复直播")

        # --- end + review ---------------------------------------------------
        cdp.evaluate("window.__NEXUS__.navigate('overview')")
        time.sleep(0.7)
        record(cdp.click(".stage-head [data-act='end-review']"), "点击结束直播并复盘")
        record(cdp.wait_for("!!document.querySelector('#confirm-root.open')", timeout=8), "出现确认对话框")
        shot(cdp, "06-confirm.png")
        cdp.click("[data-confirm-ok]")
        record(cdp.wait_for("window.__NEXUS__.state.session.stage === 'reviewed'", timeout=80), "结束并完成复盘")
        time.sleep(1)
        shot(cdp, "07-review.png")
        record(
            cdp.evaluate("document.querySelector('.flow-step.is-current b')?.textContent") == "复盘",
            "流程条高亮复盘",
        )
        disabled = cdp.evaluate("document.querySelectorAll('#chat-suggestions .suggestion.is-disabled').length")
        record(disabled >= 3, "Copilot 快捷指令按阶段置灰", f"{disabled} 条置灰")

        # --- one-click demo -------------------------------------------------
        record(cdp.click("#demo-trigger"), "点击一键演示")
        record(cdp.wait_for("!!document.querySelector('.demo-hud')", timeout=10), "演示 HUD 出现")
        time.sleep(4.5)
        shot(cdp, "08-demo-running.png")
        done = cdp.wait_for("!!document.querySelector('.demo-hud.is-done')", timeout=150)
        record(done, "演示剧本跑完 8 步")
        if done:
            steps_done = cdp.evaluate("document.querySelectorAll('.demo-hud-steps li.done').length")
            record(steps_done == 8, "剧本步骤全部打勾", f"{steps_done}/8")
            shot(cdp, "09-demo-done.png")
            record(
                cdp.evaluate("window.__NEXUS__.state.session.stage === 'reviewed'"),
                "演示终点为复盘阶段",
            )
        time.sleep(0.5)

        # --- command palette ------------------------------------------------
        cdp.call(
            "Input.dispatchKeyEvent",
            {"type": "keyDown", "modifiers": 2, "key": "k", "code": "KeyK", "windowsVirtualKeyCode": 75},
        )
        cdp.call(
            "Input.dispatchKeyEvent",
            {"type": "keyUp", "modifiers": 2, "key": "k", "code": "KeyK", "windowsVirtualKeyCode": 75},
        )
        record(cdp.wait_for("!!document.querySelector('#palette-root.open')", timeout=8), "⌘K 打开命令面板")
        first_group = cdp.evaluate("document.querySelector('.palette-group')?.textContent")
        record(first_group == "常用动作", "常用动作置顶", str(first_group))
        shot(cdp, "10-palette.png")
        cdp.call(
            "Input.dispatchKeyEvent",
            {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
        )
        time.sleep(0.4)

        # --- responsive -----------------------------------------------------
        cdp.evaluate("window.__NEXUS__.navigate('overview')")
        set_viewport(cdp, 1440, 960)
        time.sleep(1.2)
        columns = cdp.evaluate(
            "getComputedStyle(document.querySelector('.kpi-band')).gridTemplateColumns.split(' ').length"
        )
        copilot_closed = cdp.evaluate("document.querySelector('#shell').classList.contains('copilot-closed')")
        record(columns == 2, "1440 宽 KPI 变 2×2", f"{columns} 列")
        record(copilot_closed, "1440 宽 Copilot 自动折叠")
        shot(cdp, "11-1440.png")

        set_viewport(cdp, 1024, 820)
        time.sleep(1.2)
        overflow = cdp.evaluate(
            """(() => {
              const flow = document.querySelector('.flow-bar');
              return {
                flow: flow ? flow.scrollWidth - flow.clientWidth : 0,
                page: document.documentElement.scrollWidth - window.innerWidth
              };
            })()"""
        )
        record(overflow["flow"] <= 2 and overflow["page"] <= 2, "1024 宽无横向溢出", str(overflow))
        shot(cdp, "12-1024.png")

        set_viewport(cdp, 820, 900)
        time.sleep(1.2)
        record(
            cdp.evaluate("getComputedStyle(document.querySelector('.rail')).display === 'none'"),
            "820 宽隐藏侧栏",
        )
        shot(cdp, "13-820.png")

        set_viewport(cdp, 1600, 1000)
        time.sleep(0.8)

        # --- errors ---------------------------------------------------------
        problems = console_errors(cdp)
        record(not problems, "无控制台错误 / 未捕获异常", "; ".join(problems[:3]))
        shot(cdp, "14-final.png")
    finally:
        if cdp:
            try:
                cdp.ws.close()
            except Exception:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(0.4)
        try:
            import shutil

            shutil.rmtree(profile, ignore_errors=True)
        except Exception:
            pass

    passed = sum(1 for ok, _, _ in RESULTS if ok)
    total = len(RESULTS)
    print("\n" + "=" * 60)
    print(f"浏览器验收 {passed}/{total} 通过")
    for ok, label, detail in RESULTS:
        if not ok:
            print(f"  FAIL  {label}  {detail}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
