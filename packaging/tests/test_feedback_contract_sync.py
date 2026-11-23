"""反馈跨语言契约同步：TS 的界面常量和 Go 的客户端/中继常量必须一致。

这些值无法在两种语言间共享编译期符号；这个测试就是显式的同步护栏。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "client" / "src" / "core" / "feedback.ts"
SERVICE = ROOT / "desktop" / "internal" / "feedbackservice" / "feedbackservice.go"
RELAY = ROOT / "desktop" / "internal" / "feedbackrelay" / "feedbackrelay.go"
REDACTION = ROOT / "desktop" / "internal" / "redaction" / "redaction.go"
DIALOG = ROOT / "client" / "src" / "ui" / "FeedbackDialog.tsx"


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def ts_string(source: str, name: str) -> str:
    match = re.search(rf'export const {name}\s*=\s*"([^"]+)"', source)
    if not match:
        raise AssertionError(f"missing TS constant {name}")
    return match.group(1)


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
    def test_default_relay_url_matches_go(self) -> None:
        ui = ts_string(text(CLIENT), "DEFAULT_FEEDBACK_RELAY_URL")
        go = go_string(text(SERVICE), "DefaultRelayURL")
        self.assertEqual(ui, "http://lzxsvn:3005")
        self.assertEqual(ui, go)

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
        relay = text(RELAY)
        relay_count = re.search(r"cfg\.MaxScreenshots\s*=\s*(\d+)", relay)
        relay_shift = re.search(r"cfg\.MaxScreenshotBytes\s*=\s*(\d+)\s*<<\s*(\d+)", relay)
        self.assertIsNotNone(relay_count)
        self.assertIsNotNone(relay_shift)
        self.assertEqual(ui_bytes, int(relay_shift.group(1)) << int(relay_shift.group(2)))
        self.assertEqual(go_int(ui, "FEEDBACK_MAX_SCREENSHOTS"), int(relay_count.group(1)))

    def test_category_codes_and_labels_match_relay(self) -> None:
        ui = re.findall(r'\{\s*code:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}', text(CLIENT))
        expected = [
            ("bug", "缺陷"),
            ("feature", "需求"),
            ("suggestion", "建议"),
            ("other", "其他"),
        ]
        self.assertEqual(ui, expected)
        relay = text(RELAY)
        valid_block = re.search(r"var validCategories = map\[string\]bool\{(.*?)\}", relay, re.S)
        label_block = re.search(r"var categoryLabel = map\[string\]string\{(.*?)\}", relay, re.S)
        self.assertIsNotNone(valid_block)
        self.assertIsNotNone(label_block)
        codes = re.findall(r'"([^"]+)":\s*true', valid_block.group(1))
        labels = dict(re.findall(r'"([^"]+)":\s*"([^"]+)"', label_block.group(1)))
        self.assertEqual(codes, [code for code, _ in expected])
        self.assertEqual(labels, {code: label for code, label in expected})

    def test_failure_messages_match_service_constants(self) -> None:
        expected = {
            "unreachable": "反馈中继不可达，请稍后再试",
            "unauthorized": "Gitea token 无效或权限不足",
            "rejected": "反馈被中继拒绝，请稍后再试",
            "invalid": "反馈内容不合法，请修改后重试",
            "too_large": "反馈内容过大，请精简后重试",
            "unavailable": "反馈暂不可用：未配置中继地址",
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
        for pattern in (secret, credential, bare_hex, placeholder):
            self.assertIn(pattern, go, "Go 共享脱敏缺少模式")
            self.assertIn(pattern, js, "JS 预览脱敏模式与 Go 不同步")

    def test_token_scope_notice_lists_permissions(self) -> None:
        """#216 项3：预览必须说明 token 权限范围（建 issue、评论、打标签、上传附件）。"""
        block = re.search(r'export const FEEDBACK_TOKEN_SCOPE\s*=\s*"([^"]+)"', text(CLIENT))
        self.assertIsNotNone(block, "缺少 FEEDBACK_TOKEN_SCOPE")
        scope = block.group(1)
        for capability in ("建 issue", "评论", "打标签", "上传附件"):
            self.assertIn(capability, scope)


if __name__ == "__main__":
    unittest.main()
