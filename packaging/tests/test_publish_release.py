"""Gitea 发布编排：本地资产门禁、幂等替换与更新描述最后可见。"""

import base64
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import publish_release  # noqa: E402


VERSION = "1.5.0"
TAG = "v" + VERSION
BASE_URL = "http://gitea.test"
REPO = "qinyuanj/kacha"
INSTALLER = f"kacha-setup-{VERSION}-amd64.exe"
PACKAGE_URL = f"{BASE_URL}/{REPO}/releases/download/{TAG}/{INSTALLER}"
# 64 字节的签名（Ed25519 的长度）；真正的验签在 Go 侧，这里的值只要形状对。
SIGNATURE = base64.b64encode(bytes(range(64))).decode()
NOTES = "# 1.5.0\n\n## 改进\n\n- 一条。\n"


def descriptor(**overrides: object) -> dict[str, object]:
    """真安装器签名工具生成的更新描述（字段与客户端 updateservice.Manifest 一致）。"""
    data: dict[str, object] = {
        "version": VERSION,
        "platform": "windows-amd64",
        "url": PACKAGE_URL,
        "size": len(b"installer"),
        "signature": SIGNATURE,
        "notes": NOTES,
    }
    data.update(overrides)
    return data


def assets(desc: dict[str, object] | None = None, *, omit_signature: bool = False) -> dict[str, bytes]:
    files = {
        INSTALLER: b"installer",
        INSTALLER + ".sig": (str((desc or descriptor())["signature"]) + "\n").encode(),
        "update-windows-amd64.json": (json.dumps(desc or descriptor(), ensure_ascii=False, indent=2) + "\n").encode(),
    }
    if omit_signature:
        del files[INSTALLER + ".sig"]
    return files


ASSETS = assets()



class FakeGitea:
    def __init__(self):
        self.releases = {}
        self.assets = {}
        self.blobs = {}
        self.calls = []
        self._release_id = 1
        self._asset_id = 1

    def factory(self, base_url, token, owner_repo):
        self.calls.append(("factory", base_url, token, owner_repo))
        return self

    def release_for_tag(self, tag):
        self.calls.append(("release_for_tag", tag))
        return self.releases.get(tag)

    def create_release(self, tag, name, body):
        self.calls.append(("create_release", tag))
        release = {"id": self._release_id, "tag_name": tag, "name": name, "body": body}
        self._release_id += 1
        self.releases[tag] = release
        self.assets[release["id"]] = {}
        return release

    def update_release(self, release_id, name, body):
        self.calls.append(("update_release", release_id))
        self.releases_by_id()[release_id]["body"] = body

    def releases_by_id(self):
        return {r["id"]: r for r in self.releases.values()}

    def list_assets(self, release_id):
        return [dict(a) for a in self.assets[release_id].values()]

    def download_url(self, url):
        return self.blobs[url]

    def delete_asset(self, release_id, asset_id):
        self.calls.append(("delete_asset", release_id, asset_id))
        asset = self.assets[release_id].pop(asset_id)
        self.blobs.pop(asset["browser_download_url"], None)

    def upload_asset(self, release_id, filename, data):
        self.calls.append(("upload_asset", filename))
        if filename == "fail.me":
            raise publish_release.GiteaError("upload failed")
        url = f"https://gitea.test/assets/{self._asset_id}"
        self.assets[release_id][self._asset_id] = {
            "id": self._asset_id, "name": filename, "browser_download_url": url,
        }
        self.blobs[url] = data
        self._asset_id += 1

    def names(self, release_id):
        return sorted(a["name"] for a in self.assets[release_id].values())

    def data(self, release_id, name):
        for asset in self.assets[release_id].values():
            if asset["name"] == name:
                return self.blobs[asset["browser_download_url"]]
        raise KeyError(name)


class RepoFixture(unittest.TestCase):
    """最小仓库：唯一版本清单 + 唯一更新说明；发布目录里放真实生成的那套资产。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release_dir = self.root / "release"
        self.release_dir.mkdir()
        (self.root / "mygo.config.ts").write_text('export default {\n  version: "1.5.0",\n};\n', encoding="utf-8")
        changelog = self.root / "docs" / "release"
        changelog.mkdir(parents=True)
        (changelog / "changelog.md").write_text(
            "# 1.5.0\n\n## 改进\n\n- 一条。\n\n# 1.4.0\n\n## 修复\n\n- 旧的一条。\n", encoding="utf-8")
        self.signature_ok = mock.patch.object(publish_release, "verify_release_signature", lambda *a, **k: None)

    def write_assets(self, files: dict[str, bytes] | None = None):
        files = ASSETS if files is None else files
        for name, data in files.items():
            (self.release_dir / name).write_bytes(data)
        checksums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in files.items())
        (self.release_dir / "SHA256SUMS").write_text(checksums, encoding="utf-8")


class ReleaseAssetGateTest(RepoFixture):
    """发布资产门禁：只有真实生成的更新描述能过，写死的清单与假签名不行。"""

    def setUp(self):
        super().setUp()
        # 验签本身在 Go 侧跑（与客户端同一条路径），这里只验编排：真验签在 SignatureCheckTest 与 Go 测试里。
        self.signature_ok.start()
        self.addCleanup(self.signature_ok.stop)

    def collect(self) -> list[Path]:
        return publish_release.collect_assets(self.release_dir, VERSION, BASE_URL, REPO)

    def assert_rejected(self, files: dict[str, bytes] | None = None, *, words: str) -> str:
        self.write_assets(files)
        with self.assertRaises(SystemExit) as caught:
            self.collect()
        message = str(caught.exception)
        self.assertIn(words, message)
        return message

    def test_accepts_the_real_descriptor_with_the_signature_asset(self):
        self.write_assets()
        paths = self.collect()
        self.assertEqual([p.name for p in paths], [INSTALLER, INSTALLER + ".sig", "update-windows-amd64.json", "SHA256SUMS"])

    def test_rejects_another_platform(self):
        self.assert_rejected(assets(descriptor(platform="linux-amd64")), words="平台")

    def test_rejects_a_package_url_on_another_host(self):
        self.assert_rejected(
            assets(descriptor(url=f"https://elsewhere.example/{REPO}/releases/download/{TAG}/{INSTALLER}")),
            words="包地址",
        )

    def test_rejects_a_package_url_for_another_version(self):
        self.assert_rejected(
            assets(descriptor(url=f"{BASE_URL}/{REPO}/releases/download/v1.4.0/{INSTALLER}")),
            words="URL",
        )

    def test_rejects_a_signature_that_does_not_match_the_signature_asset(self):
        files = assets()
        files[INSTALLER + ".sig"] = (base64.b64encode(b"other" * 12).decode() + "\n").encode()
        # 描述与 .sig 对不上：这是半套资产，哈希齐了也不能发。
        self.assert_rejected(files, words="签名")

    def test_rejects_a_missing_signature_asset(self):
        files = assets(omit_signature=True)
        self.write_assets(files)
        with self.assertRaises(SystemExit) as caught:
            self.collect()
        message = str(caught.exception)
        self.assertIn(".sig", message)

    def test_rejects_a_descriptor_without_notes_for_the_current_version(self):
        self.assert_rejected(assets(descriptor(notes="# 1.4.0\n")), words="描述")


class ReleaseNotesSourceTest(RepoFixture):
    """发布说明只有 changelog.md 这一份（ADR 0024）。"""

    def test_body_is_the_current_section_of_the_changelog(self):
        body = publish_release.release_body(self.root, VERSION)
        self.assertTrue(body.startswith("# 1.5.0"), body)
        self.assertIn("- 一条。", body)
        self.assertNotIn("旧的一条", body)

    def test_missing_section_names_the_changelog(self):
        (self.root / "docs" / "release" / "changelog.md").write_text("# 1.4.0\n\n## 修复\n\n- 旧的一条。\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            publish_release.release_body(self.root, VERSION)
        self.assertIn("changelog.md", str(caught.exception))

    def test_a_second_release_notes_file_is_not_read(self):
        (self.root / "docs" / "release" / f"release-notes-{VERSION}.md").write_text("# 1.5.0\n\n另一份来源。\n", encoding="utf-8")
        self.assertNotIn("另一份来源", publish_release.release_body(self.root, VERSION))


class SignatureCheckTest(RepoFixture):
    """签名校验走客户端同一条路径：调 desktop/cmd/verifyrelease，本脚本不另写一份验签。"""

    def test_invokes_the_release_tool_with_the_installer_and_descriptor(self):
        installer = self.release_dir / INSTALLER
        desc = self.release_dir / "update-windows-amd64.json"
        installer.write_bytes(b"installer")
        desc.write_text(json.dumps(descriptor()), encoding="utf-8")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(publish_release.subprocess, "run", return_value=completed) as run:
            publish_release.verify_release_signature(installer, desc, repo_root=self.root)
        command = run.call_args.args[0]
        self.assertIn("./desktop/cmd/verifyrelease", command)
        self.assertIn(str(installer), command)
        self.assertIn(str(desc), command)
        self.assertEqual(run.call_args.kwargs["cwd"], self.root)

    def test_a_failing_check_stops_the_publish(self):
        installer = self.release_dir / INSTALLER
        desc = self.release_dir / "update-windows-amd64.json"
        installer.write_bytes(b"installer")
        desc.write_text(json.dumps(descriptor()), encoding="utf-8")
        failed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="签名对不上")
        with mock.patch.object(publish_release.subprocess, "run", return_value=failed):
            with self.assertRaises(SystemExit) as caught:
                publish_release.verify_release_signature(installer, desc, repo_root=self.root)
        self.assertIn("签名对不上", str(caught.exception))


class PublishCoordinatorTest(RepoFixture):
    def setUp(self):
        super().setUp()
        self.signature_ok.start()
        self.addCleanup(self.signature_ok.stop)
        self.gitea = FakeGitea()

    def run_publish(self, token="token"):
        env = dict(os.environ)
        env.pop("GITEA_TOKEN", None)
        if token is not None:
            env["GITEA_TOKEN"] = token
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(out):
            try:
                result = publish_release.main(
                    ["--release-dir", str(self.release_dir), "--base-url", BASE_URL, "--repo", REPO],
                    repo_root=self.root,
                    client_factory=self.gitea.factory,
                )
            except SystemExit as error:
                result = str(error)
            return result, out.getvalue()

    def test_requires_token_before_any_remote_write(self):
        self.write_assets()
        code, _ = self.run_publish(token=None)
        self.assertIn("GITEA_TOKEN", str(code))
        self.assertEqual(self.gitea.calls, [])

    def test_requires_every_asset_and_matching_checksum_before_remote_write(self):
        self.write_assets()
        (self.release_dir / "update-windows-amd64.json").unlink()
        code, _ = self.run_publish()
        self.assertIn("update-windows-amd64.json", str(code))
        self.assertEqual(self.gitea.calls, [])

    def test_publishes_descriptor_last_and_republishes_idempotently(self):
        self.write_assets()
        self.assertEqual(self.run_publish()[0], 0)
        release = self.gitea.releases[TAG]
        self.assertEqual(self.gitea.names(release["id"]), sorted([*ASSETS, "SHA256SUMS"]))
        self.assertEqual(self.gitea.data(release["id"], "update-windows-amd64.json"), ASSETS["update-windows-amd64.json"])
        uploads = [c[1] for c in self.gitea.calls if c[0] == "upload_asset"]
        self.assertEqual(uploads[-1], "update-windows-amd64.json")
        self.assertEqual(self.run_publish()[0], 0)
        self.assertEqual(len(self.gitea.releases), 1)
        self.assertIn(("delete_asset", release["id"], mock.ANY), self.gitea.calls)
        self.assertEqual(self.gitea.names(release["id"]), sorted([*ASSETS, "SHA256SUMS"]))

    def test_retry_after_failure_keeps_old_tag_and_completes_assets(self):
        self.write_assets()
        self.gitea.releases[TAG] = {"id": 7, "tag_name": TAG, "name": "old"}
        self.gitea.assets[7] = {}
        self.gitea.calls.append(("create_release", "historical"))
        self.assertEqual(self.gitea.names(7), [])
        self.assertEqual(self.run_publish()[0], 0)
        self.assertEqual(self.gitea.names(7), sorted([*ASSETS, "SHA256SUMS"]))


@unittest.skipUnless(shutil.which("go"), "需要 Go 工具链才能跑发布验签")
class BuiltInKeyGateTest(unittest.TestCase):
    """签名私钥与内置发布者公钥不是一对时，发布必须拒绝：客户端装不上不是发布者签的包。

    仓库现在内置了真实发布者公钥，所以「完全没有内置公钥」这种状态在装配层不再出现；
    那一种拒绝由 Go 侧的 TestWithoutPublisherKeyUpdatesAreUnavailable 与 verifyrelease
    的空公钥预检用例覆盖，这里只守内置了公钥之后仍必须挡住错配签名。
    """

    def test_publishing_is_refused_when_the_signature_is_not_from_the_built_in_publisher(self):
        with tempfile.TemporaryDirectory() as tmp:
            installer = Path(tmp) / INSTALLER
            desc = Path(tmp) / "update-windows-amd64.json"
            installer.write_bytes(b"installer")
            desc.write_text(json.dumps(descriptor()), encoding="utf-8")
            with self.assertRaises(SystemExit) as caught:
                publish_release.verify_release_signature(installer, desc)
            self.assertIn("发布者签名", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
