"""压测脚本的命令行判定：读不到服务端峰值内存、峰值超预算时都必须以非 0 退出。

服务端替身是一个 Python 脚本：只打印与真实服务端相同格式的监听行，HTTP 接口由本进程内的假服务端应答。
替身随后要么一直等到被结束（可测量），要么立刻退出（测量前进程已不在，读不到峰值）。
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "packaging" / "load_users.py"
PACK = REPO / "client" / "fixtures" / "packs" / "v0.3.2-flash-layers.ugcpack"

STAND_IN = """\
import os, sys, time
port = os.environ["KACHA_FAKE_PORT"]
sys.stdout.buffer.write(f"kacha-server 0.0.0 监听 http://127.0.0.1:{port}，数据根 x\\n".encode("utf-8"))
sys.stdout.flush()
if os.environ.get("KACHA_FAKE_EXIT") != "1":
    time.sleep(3600)
"""


class FakeServer(BaseHTTPRequestHandler):
    """按压测脚本走的接口给出最小的成功应答；写入的文件原样读回。"""

    files: dict[str, bytes] = {}

    def _reply(self, body: bytes = b"{}", content_type: str = "application/json", cookie: str | None = None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/api/fs/file":
            self._reply(self.files[urllib.parse.parse_qs(url.query)["path"][0]], "application/octet-stream")
        else:
            self._reply(b"[]")

    def do_PUT(self):
        url = urllib.parse.urlsplit(self.path)
        body = self._body()
        if url.path == "/api/fs/file":
            self.files[urllib.parse.parse_qs(url.query)["path"][0]] = body
        self._reply()

    def do_POST(self):
        self._body()
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/session":
            self._reply(cookie="kacha_session=fake; Path=/")
        elif path == "/api/packs/uploads":
            self._reply(b'{"id":"u1"}')
        elif path == "/api/packs/export":
            self._reply(b"PK\x03\x04", "application/zip")
        else:
            self._reply()

    def log_message(self, *_args):
        pass


class LoadUsersCliTest(unittest.TestCase):
    def setUp(self):
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), FakeServer)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.tmp = tempfile.TemporaryDirectory()
        self.stand_in = Path(self.tmp.name) / "fake_server.py"
        self.stand_in.write_text(STAND_IN, encoding="utf-8")

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.tmp.cleanup()

    def run_load(self, *extra: str, exit_early: bool = False) -> subprocess.CompletedProcess:
        env = dict(os.environ, KACHA_FAKE_PORT=str(self.http.server_port), KACHA_FAKE_EXIT="1" if exit_early else "0")
        output = Path(self.tmp.name) / "result.json"
        command = [sys.executable, str(SCRIPT), "--users", "2", "--server", str(self.stand_in), "--pack", str(PACK), "--static-dir", self.tmp.name, "--output", str(output), *extra]
        result = subprocess.run(command, cwd=REPO, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120)
        result.json = json.loads(output.read_text(encoding="utf-8")) if output.exists() else None
        return result

    def test_measured_peak_within_budget_exits_zero_and_reports_os_metric(self):
        result = self.run_load()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.json["users"], 2)
        self.assertGreater(result.json["server_peak_bytes"], 0, "峰值必须读自操作系统，不能是 0")
        self.assertTrue(result.json["within_budget"])
        expected = "Windows PeakWorkingSetSize" if os.name == "nt" else "Linux /proc VmHWM"
        self.assertEqual(result.json["platform"], expected)

    def test_peak_over_budget_exits_nonzero(self):
        result = self.run_load("--budget-mib", "0")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(result.json["within_budget"])

    def test_unreadable_peak_fails_instead_of_passing(self):
        result = self.run_load(exit_early=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("峰值", result.stderr)
        self.assertIsNone(result.json, "读不到峰值时不得写出测量结果")


if __name__ == "__main__":
    unittest.main()
