#!/usr/bin/env python3
"""把 MyGo Windows 发布资产幂等上传到 Gitea Release。

只从环境变量读取 GITEA_TOKEN；私钥不进入本脚本、仓库或发行资产。
上传前必须齐备安装器、发布者签名、更新描述与校验值，更新描述最后上传。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Protocol

sys.path.insert(0, str(Path(__file__).resolve().parent))

from release_gate import desktop_version, validate_release_assets  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE_URL = "http://lzxsvn:3000"
OWNER_REPO = "qinyuanj/kacha"
INSTALLER_SUFFIX = "-setup-{version}-amd64.exe"
DESCRIPTOR = "update-windows-amd64.json"
CHECKSUMS = "SHA256SUMS"
REQUIRED = (
    "kacha-setup-{version}-amd64.exe",
    "kacha-setup-{version}-amd64.exe.sig",
    DESCRIPTOR,
    CHECKSUMS,
)


class GiteaError(RuntimeError):
    """Gitea API 请求失败。"""


class ReleaseApi(Protocol):
    def release_for_tag(self, tag: str) -> dict | None: ...
    def create_release(self, tag: str, name: str, body: str) -> dict: ...
    def update_release(self, release_id: int, name: str, body: str) -> None: ...
    def list_assets(self, release_id: int) -> list[dict]: ...
    def delete_asset(self, release_id: int, asset_id: int) -> None: ...
    def upload_asset(self, release_id: int, filename: str, data: bytes) -> None: ...


class GiteaClient:
    """Gitea Release API 薄封装；404 表示资源不存在。"""

    def __init__(self, base_url: str, token: str, owner_repo: str) -> None:
        self._api = f"{base_url.rstrip('/')}/api/v1/repos/{owner_repo}"
        self._token = token

    def _request(self, method: str, path: str, *, payload: dict | None = None,
                 raw: bytes | None = None, headers: dict[str, str] | None = None,
                 allow_404: bool = False) -> tuple[int, bytes]:
        request_headers = {"Authorization": f"token {self._token}", "Accept": "application/json"}
        data: bytes | None = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        elif raw is not None:
            data = raw
        request_headers.update(headers or {})
        request = urllib.request.Request(f"{self._api}{path}", data=data, method=method, headers=request_headers)
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code == 404 and allow_404:
                return 404, detail.encode("utf-8")
            raise GiteaError(f"Gitea 请求失败：{method} {path} → HTTP {error.code}：{detail}") from error
        except urllib.error.URLError as error:
            raise GiteaError(f"无法连接 Gitea（{self._api}{path}）：{error.reason}") from error

    def _json(self, method: str, path: str, **kwargs: object) -> tuple[int, object]:
        status, body = self._request(method, path, **kwargs)  # type: ignore[arg-type]
        return status, json.loads(body) if body else {}

    def release_for_tag(self, tag: str) -> dict | None:
        status, body = self._json("GET", f"/releases/tags/{tag}", allow_404=True)
        return body if status == 200 else None  # type: ignore[return-value]

    def create_release(self, tag: str, name: str, body: str) -> dict:
        _, release = self._json("POST", "/releases", payload={
            "tag_name": tag, "name": name, "body": body, "draft": False, "prerelease": False,
        })
        return release  # type: ignore[return-value]

    def update_release(self, release_id: int, name: str, body: str) -> None:
        self._json("PATCH", f"/releases/{release_id}", payload={"name": name, "body": body})

    def list_assets(self, release_id: int) -> list[dict]:
        _, assets = self._json("GET", f"/releases/{release_id}/assets")
        return assets  # type: ignore[return-value]

    def delete_asset(self, release_id: int, asset_id: int) -> None:
        self._request("DELETE", f"/releases/{release_id}/assets/{asset_id}")

    def upload_asset(self, release_id: int, filename: str, data: bytes) -> None:
        boundary = uuid.uuid4().hex
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="attachment"; filename="{filename}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode("utf-8")
        self._request("POST", f"/releases/{release_id}/assets", raw=body,
                      headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})


def parse_checksums(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.strip().split(maxsplit=1)
        if len(parts) == 2 and len(parts[0]) == 64:
            result[parts[1].removeprefix("*")] = parts[0].lower()
    return result


def collect_assets(release_dir: Path, version: str) -> list[Path]:
    paths = [release_dir / name.format(version=version) for name in REQUIRED]
    missing = [path.name for path in paths if not path.is_file()]
    if missing:
        raise SystemExit(f"发布资产不齐：{', '.join(missing)}；完整资产就绪前不发布")
    checksums = parse_checksums(paths[-1].read_text(encoding="utf-8"))
    for path in paths[:-1]:
        expected = checksums.get(path.name)
        if expected is None:
            raise SystemExit(f"{CHECKSUMS} 未列出 {path.name}；拒绝发布")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f"{path.name} 与 {CHECKSUMS} 不一致；拒绝发布")
    descriptor = json.loads(paths[2].read_text(encoding="utf-8"))
    descriptor_version = descriptor.get("version")
    if not isinstance(descriptor_version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", descriptor_version):
        raise SystemExit("更新描述缺少有效的版本字段")
    if descriptor.get("platforms"):
        raise SystemExit("更新描述含非 windows-amd64 平台，拒绝发布半套资产")
    if not re.search(rf"^#\s+{re.escape(version)}\s*$", str(descriptor.get("notes", "")), re.MULTILINE):
        raise SystemExit(f"更新描述缺少当前版本 {version} 的一级标题")
    release_url = f"https://gitea.test/qinyuanj/kacha/releases/download/v{version}/kacha-setup-{version}-amd64.exe"
    validate_release_assets({
        "version": descriptor_version,
        "platform": "windows-amd64",
        "url": release_url,
        "signature": "present",
        "notes": "# " + descriptor_version,
    }, version)
    return paths


def release_body(repo_root: Path, version: str) -> str:
    path = repo_root / "docs" / "release" / f"release-notes-{version}.md"
    if not path.is_file():
        raise SystemExit(f"缺少发布说明：{path}；发布前必须有当前版本的更新描述")
    return path.read_text(encoding="utf-8").rstrip()


def upload_replace(api: ReleaseApi, release_id: int, filename: str, data: bytes) -> None:
    for asset in api.list_assets(release_id):
        if asset["name"] == filename:
            api.delete_asset(release_id, int(asset["id"]))
    api.upload_asset(release_id, filename, data)


def publish(api: ReleaseApi, release_dir: Path, version: str, body: str, paths: list[Path]) -> None:
    tag = f"v{version}"
    release = api.release_for_tag(tag)
    if release is None:
        release = api.create_release(tag, version, body)
    else:
        api.update_release(int(release["id"]), version, body)
    release_id = int(release["id"])
    # 重复发布先撤下旧的更新描述：半套资产期间客户端看不到 ready 标记。
    for asset in api.list_assets(release_id):
        if asset["name"] == DESCRIPTOR:
            api.delete_asset(release_id, int(asset["id"]))
    for path in paths:
        if path.name != DESCRIPTOR:
            upload_replace(api, release_id, path.name, path.read_bytes())
    upload_replace(api, release_id, DESCRIPTOR, paths[2].read_bytes())


def main(argv: list[str] | None = None, *, repo_root: Path = REPO_ROOT,
         client_factory: type[ReleaseApi] | object = GiteaClient) -> int:
    parser = argparse.ArgumentParser(description="把完整 Windows 发布资产上传到 Gitea Release")
    parser.add_argument("--release-dir", default=str(repo_root / "release"))
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--repo", default=OWNER_REPO)
    args = parser.parse_args(argv)

    token = os.environ.get("GITEA_TOKEN", "").strip()
    if not token:
        raise SystemExit("缺少环境变量 GITEA_TOKEN：发布脚本只从环境变量读取 token")
    version = desktop_version(repo_root)
    release_dir = Path(args.release_dir)
    paths = collect_assets(release_dir, version)
    body = release_body(repo_root, version)
    api = client_factory(args.base_url, token, args.repo)  # type: ignore[operator]
    try:
        publish(api, release_dir, version, body, paths)
    except GiteaError as error:
        raise SystemExit(str(error)) from error
    print(f"发布完成：{args.base_url.rstrip('/')}/{args.repo}/releases/tag/v{version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())