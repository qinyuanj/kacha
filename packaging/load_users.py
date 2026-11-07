#!/usr/bin/env python3
"""用真实 HTTP 接口模拟若干同时使用的用户，并读取 kacha-server 由操作系统记录的峰值内存。

只使用 Python 标准库。默认使用 release/kacha-web 下的服务端与随仓库提交的 v0.3.2 画板包；网关由本地桩代替，
不访问团队服务，不使用真实 API 密钥。人数用 --users 传入，按设计规模取 12。

峰值内存在服务端退出前读一次：Linux 读 /proc/<pid>/status 的 VmHWM（峰值常驻集），Windows 用
GetProcessMemoryInfo 读 PeakWorkingSetSize（峰值工作集）。两者都是操作系统全程记录的峰值，不受采样间隔影响。
读不到时直接报错退出（非 0），不输出测量结果。
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import zipfile

from build_web import SERVER_BINARY

BUDGET_MIB = 512


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


def peak_memory_bytes(pid: int) -> tuple[int, str]:
    """返回 (峰值字节数, 所用指标)。读不到时抛 RuntimeError。"""
    if sys.platform == "win32":
        return _windows_peak_working_set(pid), "Windows PeakWorkingSetSize"
    if sys.platform.startswith("linux"):
        try:
            status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
        except OSError as e:
            raise RuntimeError(f"读不到服务端峰值内存：{e}") from e
        match = re.search(r"^VmHWM:\s+(\d+) kB$", status, re.MULTILINE)
        if not match:
            raise RuntimeError("读不到服务端峰值内存：/proc status 中没有 VmHWM")
        return int(match.group(1)) * 1024, "Linux /proc VmHWM"
    raise RuntimeError(f"读不到服务端峰值内存：不支持的平台 {sys.platform}")


def _windows_peak_working_set(pid: int) -> int:
    import ctypes
    from ctypes import wintypes

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.K32GetProcessMemoryInfo.restype = wintypes.BOOL
    kernel32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemoryCounters), wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    process_query_limited_information = 0x1000
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        raise RuntimeError(f"读不到服务端峰值内存：OpenProcess 失败（错误 {ctypes.get_last_error()}）")
    try:
        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        if not kernel32.K32GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            raise RuntimeError(f"读不到服务端峰值内存：GetProcessMemoryInfo 失败（错误 {ctypes.get_last_error()}）")
        return counters.PeakWorkingSetSize
    finally:
        kernel32.CloseHandle(handle)


def server_command(server: Path) -> list[str]:
    # 服务端替身可以是 Python 脚本（测试用），用当前解释器启动；其它情况直接启动程序。
    path = str(server.resolve())
    return [sys.executable, path] if server.suffix == ".py" else [path]


def server_profile(server: Path) -> str:
    """所用服务端的构建档：离可执行文件最近的 debug / release 目录说了算（cargo 的 target/debug、
    打包产物 release/kacha-web 都落在其中），判断不出写 unknown。"""
    for part in reversed(server.parent.parts):
        if part.lower() in ("debug", "release"):
            return part.lower()
    return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--users", type=int, required=True, help="同时使用的用户数；按设计规模取 12")
    parser.add_argument("--server", type=Path, default=Path("release/kacha-web") / SERVER_BINARY)
    parser.add_argument("--pack", type=Path, default=Path("client/fixtures/packs/v0.3.2-flash-layers.ugcpack"))
    parser.add_argument("--static-dir", type=Path, default=Path("client/dist"))
    parser.add_argument("--budget-mib", type=int, default=BUDGET_MIB, help=f"服务端峰值内存预算（MiB），默认 {BUDGET_MIB}")
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
        command = server_command(args.server) + [
            "--listen", "127.0.0.1:0",
            "--data-root", data_root,
            "--gateway-url", f"http://127.0.0.1:{gateway.server_port}",
            "--static-dir", str(args.static_dir.resolve()),
            "--result-hosts", "127.0.0.1",
            "--min-free-gb", "0",
        ]
        # 服务端输出 UTF-8；不能按系统区域编码（中文 Windows 是 GBK）解码。
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
        assert process.stdout is not None
        try:
            line = process.stdout.readline()
            match = re.search(r"监听 http://127\.0\.0\.1:(\d+)", line)
            if not match:
                process.kill()
                raise RuntimeError(f"服务端未就绪：{line} {process.stderr.read() if process.stderr else ''}")
            port = int(match.group(1))
            started = time.monotonic()

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
                request(port, "POST", base + "/import?op=" + f"import-{index}", json.dumps({"units": units, "duplicates": []}).encode(), cookie)
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
            elapsed = time.monotonic() - started
            # 峰值只能在服务端还活着时读；提前退出（崩溃）就是读不到。
            if process.poll() is not None:
                raise RuntimeError(f"读不到服务端峰值内存：服务端在测量前已退出（退出码 {process.returncode}）")
            peak, metric = peak_memory_bytes(process.pid)
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
            gateway.shutdown()
            gateway.server_close()
    result = {
        "users": args.users,
        "operations_per_user": ["write result", "read image", "import board pack", "export board pack"],
        "elapsed_seconds": round(elapsed, 3),
        "server_peak_bytes": peak,
        "server_peak_mib": round(peak / 1024 / 1024, 2),
        "budget_mib": args.budget_mib,
        "within_budget": peak <= args.budget_mib * 1024 * 1024,
        "profile": server_profile(args.server.resolve()),
        "platform": metric,
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    return 0 if result["within_budget"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
