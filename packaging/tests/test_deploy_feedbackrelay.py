"""反馈中继部署脚本：参数传递、服务名/端口、幂等与失败语义。测试不接触真实 nssm 或凭据。"""

import contextlib
import io
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import deploy_feedbackrelay as deploy  # noqa: E402


@dataclass
class Result:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class FakeRunner:
    """记录命令并模拟 nssm 服务状态；不启动任何进程。"""

    def __init__(self, *, installed: bool = False, failing: str | None = None):
        self.commands: list[list[str]] = []
        self.status = Result(0, "SERVICE_RUNNING", "") if installed else Result(1, "", "missing")
        self.failing = failing

    def __call__(self, args: list[str]) -> Result:
        self.commands.append(list(args))
        if self.failing and self.failing in args:
            return Result(1, "", "模拟失败")
        if args[1] == "status":
            return self.status
        if args[1] == "install":
            self.status = Result(0, "SERVICE_STOPPED")
        elif args[1] == "stop":
            self.status = Result(0, "SERVICE_STOPPED")
        elif args[1] == "start":
            self.status = Result(0, "SERVICE_RUNNING")
        return Result(0, "ok")


class DeployScriptTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "kacha-feedbackrelay-1.6.5-windows-amd64.exe"
        self.binary.write_bytes(b"relay")

    def run_main(self, runner: FakeRunner, *extra: str):
        argv = [
            "--relay-binary", str(self.binary),
            "--gitea-base-url", "http://gitea.test",
            "--gitea-repo", "team/feedback",
            "--listen-address", ":3005",
            "--nssm", "nssm-test",
            *extra,
        ]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = deploy.main(argv, runner=runner, env={})
        self.assertEqual(code, 0)
        self.assertNotIn("environment-only", out.getvalue())

    def test_installs_a_new_service_with_all_relay_environment_parameters(self):
        runner = FakeRunner()
        self.run_main(runner)
        commands = runner.commands
        self.assertEqual(commands[0], ["nssm-test", "status", "kacha-feedbackrelay"])
        self.assertIn(["nssm-test", "install", "kacha-feedbackrelay", str(self.binary)], commands)
        env_command = next(c for c in commands if c[1:3] == ["set", "kacha-feedbackrelay"] and "AppEnvironment" in c)
        self.assertEqual(env_command[3], "AppEnvironment")
        self.assertEqual(env_command[4:], [
            "FEEDBACK_GITEA_URL", "http://gitea.test",
            "FEEDBACK_GITEA_REPO", "team/feedback",
            "FEEDBACK_ADDR", ":3005",
        ])
        self.assertIn(["nssm-test", "start", "kacha-feedbackrelay"], commands)

    def test_reuses_service_name_and_custom_listen_address_on_redeploy(self):
        runner = FakeRunner(installed=True)
        self.run_main(runner, "--service-name", "relay-custom", "--listen-address", ":3105")
        commands = runner.commands
        self.assertNotIn(["nssm-test", "install", "relay-custom", str(self.binary)], commands)
        self.assertIn(["nssm-test", "stop", "relay-custom"], commands)
        self.assertIn(["nssm-test", "start", "relay-custom"], commands)
        env_command = next(c for c in commands if "AppEnvironment" in c)
        self.assertEqual(env_command[4:][-2:], ["FEEDBACK_ADDR", ":3105"])
        self.assertTrue(all(c[2] == "relay-custom" for c in commands if c[1] != "status"))

    def test_redeploy_is_idempotent_without_a_second_install(self):
        runner = FakeRunner()
        self.run_main(runner)
        first_len = len(runner.commands)
        self.run_main(runner)
        installs = [c for c in runner.commands if c[1] == "install"]
        self.assertEqual(len(installs), 1)
        self.assertGreater(len(runner.commands), first_len)
        self.assertEqual(runner.commands[first_len], ["nssm-test", "status", "kacha-feedbackrelay"])

    def test_deploy_does_not_configure_a_server_token(self):
        runner = FakeRunner()
        self.run_main(runner)
        args = [arg for command in runner.commands for arg in command]
        self.assertFalse(any("FEEDBACK_GITEA_TOKEN" in arg for arg in args))
        self.assertFalse(any("TEST_RELAY_TOKEN" in arg for arg in args))

    def test_token_parameter_is_not_accepted(self):
        runner = FakeRunner()
        with self.assertRaises(SystemExit):
            deploy.main(["--relay-binary", str(self.binary), "--token-env", "TEST_RELAY_TOKEN"], runner=runner, env={})
        self.assertEqual(runner.commands, [])

    def test_missing_relay_binary_fails_before_any_command(self):
        self.binary.unlink()
        runner = FakeRunner()
        with self.assertRaises(SystemExit) as caught:
            deploy.main(["--relay-binary", str(self.binary)], runner=runner, env={})
        self.assertIn("relay", str(caught.exception).lower())
        self.assertEqual(runner.commands, [])

    def test_command_failure_stops_the_deploy(self):
        runner = FakeRunner(failing="start")
        with self.assertRaises(SystemExit) as caught:
            self.run_main(runner)
        self.assertIn("nssm", str(caught.exception))
