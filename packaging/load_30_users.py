#!/usr/bin/env python3
"""用真实 HTTP 接口模拟 30 个并发用户，并采样 kacha-server 的峰值 RSS。

只使用 Python 标准库。默认使用 release/kacha-web/kacha-server 与随仓库提交的
v0.3.2 画板包；网关由本地桩代替，不访问团队服务，不使用真实 API 密钥。
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import urllib.parse
import zipfile


class GatewayHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/usage/token" and self.headers.get("Authorization", "").startswith("Bearer sk-load-"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"data":{"name":"load","remain_quota":100}}')
            return
        self.send_response(401)
        self.end_headers()

    def log_message(self, *_args):
        pass


def request(port: int, method: str, path: str, body=None, cookie: str | None = None, content_type: str = "application/json"):
    headers = {}
    if cookie:
        headers["Cookie"] = cookie
    if body is not None:
        headers["Content-Type"] = content_type
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    conn.request(method, path, body=body, headers=headers)
    response = conn.getresponse()
    data = response.read()
    response_cookie = response.getheader("Set-Cookie")
    status = response.status
    conn.close()
    if status < 200 or status >= 300:
        raise RuntimeError(f"{method} {path} -> {status}: {data[:300]!r}")
    return data, response_cookie


def rss_bytes(pid: int) -> int:
    status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
    match = re.search(r"^VmRSS:\s+(\d+) kB$", status, re.MULTILINE)
    if not match:
        raise RuntimeError("无法读取服务端 VmRSS；此脚本目前在 Linux 上采样")
    return int(match.group(1)) * 1024


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--users", type=int, default=30)
    parser.add_argument("--server", type=Path, default=Path("release/kacha-web/kacha-server"))
    parser.add_argument("--pack", type=Path, default=Path("client/fixtures/packs/v0.3.2-flash-layers.ugcpack"))
    parser.add_argument("--static-dir", type=Path, default=Path("client/dist"))
    parser.add_argument("--output", type=Path, help="可选：把测量结果写成 JSON")
    args = parser.parse_args()
    if args.users < 1:
        parser.error("--users 必须大于 0")

    pack_bytes = args.pack.read_bytes()
    with zipfile.ZipFile(args.pack) as pack:
        names = pack.namelist()
        manifest_name = "manifest.json"
        manifest = json.loads(pack.read(manifest_name))
        board_entry = manifest["boards"][0]
        board_text = pack.read(board_entry).decode("utf-8")
        image_bytes = next(pack.read(name) for name in names if name.endswith("/result.png"))
    task_dirs = sorted({"/".join(name.split("/")[:2]) for name in names if re.match(r"^\d{4}-\d{2}-\d{2}/[^/]+/task\.json$", name)})
    references = sorted(name for name in names if name.startswith("导入参考图/") and not name.endswith("/"))
    units = [{"path": path, "identity": "task.json"} for path in task_dirs] + [{"path": path, "identity": None} for path in references]

    gateway = ThreadingHTTPServer(("127.0.0.1", 0), GatewayHandler)
    gateway_thread = threading.Thread(target=gateway.serve_forever, daemon=True)
    gateway_thread.start()
    with tempfile.TemporaryDirectory(prefix="kacha-load-") as data_root:
        command = [
            str(args.server.resolve()),
            "--listen", "127.0.0.1:0",
            "--data-root", data_root,
            "--gateway-url", f"http://127.0.0.1:{gateway.server_port}",
            "--static-dir", str(args.static_dir.resolve()),
            "--result-hosts", "127.0.0.1",
            "--min-free-gb", "0",
        ]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert process.stdout is not None
        line = process.stdout.readline()
        match = re.search(r"监听 http://127\.0\.0\.1:(\d+)", line)
        if not match:
            process.kill()
            raise RuntimeError(f"服务端未就绪：{line} {process.stderr.read() if process.stderr else ''}")
        port = int(match.group(1))
        peak = 0
        samples = 0
        stop = threading.Event()

        def sample():
            nonlocal peak, samples
            while not stop.is_set():
                peak = max(peak, rss_bytes(process.pid))
                samples += 1
                stop.wait(0.02)

        sampler = threading.Thread(target=sample)
        sampler.start()
        started = time.monotonic()
        try:
            def user(index: int):
                key = f"sk-load-{index:03d}"
                _, set_cookie = request(port, "POST", "/api/session", json.dumps({"key": key}).encode())
                cookie = set_cookie.split(";", 1)[0]
                date = "2026-11-05"
                task = f"20261105T000000Z-{index:08x}"
                result_path = f"{date}/{task}/result.png"
                request(port, "PUT", "/api/fs/file?" + urllib.parse.urlencode({"path": result_path}), image_bytes, cookie, "application/octet-stream")
                read_back, _ = request(port, "GET", "/api/fs/file?" + urllib.parse.urlencode({"path": result_path}), cookie=cookie)
                if read_back != image_bytes:
                    raise RuntimeError("读图字节与写入不一致")
                request(port, "PUT", "/api/boards?" + urllib.parse.urlencode({"path": "画板/压力.ugcboard.json", "create_only": "true"}), board_text.encode(), cookie)
                uploaded, _ = request(port, "POST", "/api/packs/uploads", pack_bytes, cookie, "application/zip")
                upload_id = json.loads(uploaded)["id"]
                base = f"/api/packs/uploads/{upload_id}"
                request(port, "GET", base + "/entries", cookie=cookie)
                request(port, "POST", base + "/texts", json.dumps([manifest_name, board_entry]).encode(), cookie)
                request(port, "POST", base + "/import?op=" + f"import-{index}", json.dumps(units).encode(), cookie)
                exported_manifest = {"pack_format_version": 1, "app_version": "load", "boards": ["画板/压力.ugcboard.json"]}
                export_spec = {
                    "texts": [
                        {"entry": manifest_name, "text": json.dumps(exported_manifest)},
                        {"entry": "画板/压力.ugcboard.json", "text": board_text},
                    ],
                    "task_dirs": task_dirs,
                    "files": [{"source": name, "entry": name} for name in references],
                }
                exported, _ = request(port, "POST", "/api/packs/export?op=" + f"export-{index}", json.dumps(export_spec).encode(), cookie)
                if not exported.startswith(b"PK"):
                    raise RuntimeError("画板包导出不是 zip")

            with ThreadPoolExecutor(max_workers=args.users) as pool:
                list(pool.map(user, range(args.users)))
        finally:
            stop.set()
            sampler.join()
            process.terminate()
            process.wait(timeout=10)
            gateway.shutdown()
            gateway.server_close()
        elapsed = time.monotonic() - started
        result = {
            "users": args.users,
            "operations_per_user": ["write result", "read image", "import board pack", "export board pack"],
            "elapsed_seconds": round(elapsed, 3),
            "server_peak_rss_bytes": peak,
            "server_peak_rss_mib": round(peak / 1024 / 1024, 2),
            "budget_mib": 512,
            "within_budget": peak <= 512 * 1024 * 1024,
            "samples": samples,
            "profile": "release",
            "platform": "Linux /proc VmRSS",
        }
        text = json.dumps(result, ensure_ascii=False, indent=2)
        print(text)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text + "\n", encoding="utf-8")
        return 0 if result["within_budget"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
