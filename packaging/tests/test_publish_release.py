"""Gitea 发布编排：本地资产门禁、幂等替换与更新描述最后可见。"""

import contextlib
import hashlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import publish_release  # noqa: E402


VERSION = "1.5.0"
TAG = "v" + VERSION
ASSETS = {
    "kacha-setup-1.5.0-amd64.exe": b"installer",
    "kacha-setup-1.5.0-amd64.exe.sig": b"signature",
    "update-windows-amd64.json": ('{"version":"1.5.0","notes":"# 1.5.0","platforms":{}}' ).encode(),
}


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


class PublishCoordinatorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.release_dir = self.root / "release"
        self.release_dir.mkdir()
        (self.root / "mygo.config.ts").write_text('export default {\n  version: "1.5.0",\n};\n', encoding="utf-8")
        notes = self.root / "docs" / "release"
        notes.mkdir(parents=True)
        (notes / "release-notes-1.5.0.md").write_text("# 1.5.0\n\n发布说明。\n", encoding="utf-8")
        self.gitea = FakeGitea()

    def tearDown(self):
        self.temp.cleanup()

    def write_assets(self):
        for name, data in ASSETS.items():
            (self.release_dir / name).write_bytes(data)
        checksums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in ASSETS.items())
        (self.release_dir / "SHA256SUMS").write_text(checksums, encoding="utf-8")

    def run_publish(self, token="token"):
        env = dict(os.environ)
        env.pop("GITEA_TOKEN", None)
        if token is not None:
            env["GITEA_TOKEN"] = token
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(out):
            try:
                result = publish_release.main(
                    ["--release-dir", str(self.release_dir), "--base-url", "http://gitea.test", "--repo", "qinyuanj/kacha"],
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


if __name__ == "__main__":
    unittest.main()