"""反馈跨语言契约同步：TS 的界面常量和 Go 的直连服务常量必须一致。

这些值无法在两种语言间共享编译期符号；这个测试就是显式的同步护栏。
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "client" / "src" / "core" / "feedback.ts"
SERVICE = ROOT / "desktop" / "internal" / "feedbackservice" / "feedbackservice.go"
REDACTION = ROOT / "desktop" / "internal" / "redaction" / "redaction.go"
DIALOG = ROOT / "client" / "src" / "ui" / "FeedbackDialog.tsx"
REDACTION_SAMPLES = ROOT / "contracts" / "redaction-samples.json"
REDACTION_PARITY_GO = ROOT / "desktop" / "internal" / "redaction" / "parity_test.go"
REDACTION_PARITY_TS = ROOT / "client" / "src" / "ui" / "redaction.parity.test.ts"


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def go_string(source: str, name: str) -> str:
    match = re.search(rf'\b{name}\s*=\s*"([^"]+)"', source)
    if not match:
        raise AssertionError(f"missing Go constant {name}")
    return match.group(1)


def go_int(source: str, name: str) -> int:
    match = re.search(rf'\b{name}\s*=\s*(\d+)', source)
    if not match:
        raise AssertionError(f"missing Go integer constant {name}")
    return int(match.group(1))


class FeedbackContractSyncTest(unittest.TestCase):
    def test_screenshot_limits_match_go(self) -> None:
        ui = text(CLIENT)
        go = text(SERVICE)
        self.assertEqual(go_int(ui, "FEEDBACK_MAX_SCREENSHOTS"), go_int(go, "MaxScreenshots"))
        match = re.search(r"FEEDBACK_MAX_SCREENSHOT_BYTES\s*=\s*([0-9\s*]+)", ui)
        self.assertIsNotNone(match)
        ui_bytes = eval(match.group(1), {"__builtins__": {}}, {})  # digits and * only
        shift = re.search(r"MaxScreenshotBytes\s*=\s*(\d+)\s*<<\s*(\d+)", go)
        self.assertIsNotNone(shift)
        go_bytes = int(shift.group(1)) << int(shift.group(2))
        self.assertEqual(ui_bytes, 10 * 1024 * 1024)
        self.assertEqual(ui_bytes, go_bytes)

    def test_category_codes_and_labels_match_service(self) -> None:
        ui = re.findall(r'\{\s*code:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}', text(CLIENT))
        expected = [
            ("bug", "缺陷"),
            ("feature", "需求"),
            ("suggestion", "建议"),
            ("other", "其他"),
        ]
        self.assertEqual(ui, expected)
        service = text(SERVICE)
        valid_block = re.search(r"var validCategories = map\[string\]bool\{(.*?)\}", service, re.S)
        label_block = re.search(r"var categoryLabel = map\[string\]string\{(.*?)\}", service, re.S)
        self.assertIsNotNone(valid_block)
        self.assertIsNotNone(label_block)
        codes = re.findall(r'"([^"]+)":\s*true', valid_block.group(1))
        labels = dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', label_block.group(1)))
        self.assertEqual(codes, [code for code, _ in expected])
        self.assertEqual(labels, {code: label for code, label in expected})

    def test_failure_messages_match_service_constants(self) -> None:
        expected = {
            "unreachable": "Gitea 不可达，请稍后再试",
            "unauthorized": "Gitea token 无效或权限不足",
            "rejected": "Gitea 提交失败，请稍后再试",
            "invalid": "反馈内容不合法，请修改后重试",
            "too_large": "反馈内容过大，请精简后重试",
            "unavailable": "反馈暂不可用",
        }
        ui = text(CLIENT)
        block = re.search(r"export const FEEDBACK_FAILURE_MESSAGES = \{(.*?)\} as const;", ui, re.S)
        self.assertIsNotNone(block)
        ui_messages = dict(re.findall(r'(\w+):\s*"([^"]+)"', block.group(1)))
        go = text(SERVICE)
        go_names = {
            "unreachable": "MessageUnreachable",
            "unauthorized": "MessageUnauthorized",
            "rejected": "MessageRejected",
            "invalid": "MessageInvalid",
            "too_large": "MessageTooLarge",
            "unavailable": "MessageUnavailable",
        }
        for key, value in expected.items():
            self.assertEqual(ui_messages[key], value)
            self.assertEqual(go_string(go, go_names[key]), value)


    def test_redaction_patterns_match_js(self) -> None:
        """#216 项4：Go 共享脱敏与 JS 预览脱敏用同一组密钥/凭据模式，防止两端漂移。"""
        go = text(REDACTION)
        js = text(DIALOG)
        secret = r"sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}"
        credential = r"api[_-]?key|gateway[_-]?key|token|secret|authorization|bearer"
        # #229：裸 40 位十六进制 Gitea token 与裸占位符，两端必须用同一组模式。
        bare_hex = r"\b[0-9a-f]{40}\b"
        placeholder = r"\{\{SECRET_[A-Za-z0-9_]+\}\}"
        # 鉴权头的 Bearer 串：缺这一条时 "Authorization: Bearer <token>" 只会把 "Bearer" 遮掉，
        # 真正的 token 原样留下（跨语言样本里那条 Bearer 用例就是这么抓到前端漏规则的）。
        bearer = r"bearer\s+"
        for pattern in (secret, credential, bare_hex, placeholder, bearer):
            self.assertIn(pattern, go, "Go 共享脱敏缺少模式")
            self.assertIn(pattern, js, "JS 预览脱敏模式与 Go 不同步")

    def test_redaction_samples_cover_every_known_drift_class(self) -> None:
        """#227 复审判断题 6：两端脱敏模式只能人工对齐，所以用同一批样本锁住行为。

        样本只存在一份（contracts/redaction-samples.json）。这里守夹具本身的两件事：
        覆盖必须包含已知会漂移的几类输入，且两端用例都读这份夹具，不是各写一份样本表。
        """
        fixture = json.loads(REDACTION_SAMPLES.read_text(encoding="utf-8"))
        samples = fixture["samples"]
        names = " ".join(sample["name"] for sample in samples)
        for kind in ("裸 40 位十六进制", "大小写混合", "{{SECRET_", "Bearer", "key=value", "本机"):
            self.assertIn(kind, names, f"样本没有覆盖 {kind}")
        self.assertTrue(any(not sample["hidden"] for sample in samples), "缺少「没有秘密」的对照样本")
        self.assertIn("redaction-samples.json", text(REDACTION_PARITY_GO))
        self.assertIn("contracts/redaction-samples.json", text(REDACTION_PARITY_TS))

    def test_token_scope_notice_lists_permissions(self) -> None:
        """#216 项3：预览必须说明 token 权限范围（建 issue、评论、打标签、上传附件）。"""
        block = re.search(r'export const FEEDBACK_TOKEN_SCOPE\s*=\s*"([^"]+)"', text(CLIENT))
        self.assertIsNotNone(block, "缺少 FEEDBACK_TOKEN_SCOPE")
        scope = block.group(1)
        for capability in ("建 issue", "评论", "打标签", "上传附件"):
            self.assertIn(capability, scope)


if __name__ == "__main__":
    unittest.main()
