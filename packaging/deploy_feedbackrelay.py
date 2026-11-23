#!/usr/bin/env python3
"""把版本化反馈中继安装/重启为 Windows nssm 服务。

中继不再持有统一 Gitea 写 token；提交者 token 随每次请求进入服务进程，不写入 nssm 环境。
部署动作全部经 runner 注入，便于测试断言参数、服务名、端口与失败语义。
"""

from __future__ import annotations

import argparse
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

SERVICE_NAME = "kacha-feedbackrelay"
DEFAULT_GITEA_URL = "http://lzxsvn:3000"
DEFAULT_GITEA_REPO = "qinyuanj/kacha-feedback"
DEFAULT_LISTEN_ADDRESS = ":3005"
DEFAULT_NSSM = "nssm.exe"


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class CommandRunner(Protocol):
    def __call__(self, args: list[str]) -> CommandResult: ...


@dataclass(frozen=True)
class DeployOptions:
    relay_binary: Path
    gitea_base_url: str = DEFAULT_GITEA_URL
    gitea_repo: str = DEFAULT_GITEA_REPO
    listen_address: str = DEFAULT_LISTEN_ADDRESS
    service_name: str = SERVICE_NAME
    nssm: str = DEFAULT_NSSM


def process_runner(args: list[str]) -> CommandResult:
    """真实 runner：命令不存在时转成 SystemExit，失败细节不回显。"""
    try:
        done = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except OSError as error:
        raise SystemExit(f"无法运行 nssm 命令 {args[1] if len(args) > 1 else args[0]}：{error}") from error
    return CommandResult(done.returncode, done.stdout or "", done.stderr or "")


def _invoke(runner: CommandRunner, args: list[str]) -> CommandResult:
    try:
        return runner(args)
    except OSError as error:
        raise SystemExit(f"无法运行 nssm 命令 {args[1] if len(args) > 1 else args[0]}：{error}") from error


def _checked(runner: CommandRunner, args: list[str]) -> CommandResult:
    result = _invoke(runner, args)
    if result.returncode != 0:
        # 不回显 stdout/stderr：nssm 输出可能含本机部署细节。
        raise SystemExit(f"nssm {args[1]} 失败（退出码 {result.returncode}），服务未更新")
    return result


def deploy_relay(options: DeployOptions, *, runner: CommandRunner) -> None:
    """幂等安装或升级服务：已安装的旧版本也重新指向本次的版本化二进制。"""
    if not options.listen_address.startswith(":"):
        raise SystemExit(f"监听地址必须形如 :3005，当前是 {options.listen_address!r}")
    binary = options.relay_binary
    if not binary.is_file():
        raise SystemExit(f"反馈中继二进制不存在：{binary}")

    nssm = options.nssm
    service = options.service_name
    status = _invoke(runner, [nssm, "status", service])
    installed = status.returncode == 0
    if installed and "SERVICE_RUNNING" in status.stdout:
        _checked(runner, [nssm, "stop", service])
    if not installed:
        _checked(runner, [nssm, "install", service, str(binary)])

    # nssm 的 AppEnvironment 是 REG_MULTI_SZ：每个参数本身必须是 KEY=VALUE，
    # 交替传 key 与 value 只会得到一堆没有等号、服务读不到的环境项。
    _checked(runner, [nssm, "set", service, "Application", str(binary)])
    _checked(runner, [nssm, "set", service, "AppDirectory", str(binary.parent)])
    _checked(runner, [
        nssm, "set", service, "AppEnvironment",
        f"FEEDBACK_GITEA_URL={options.gitea_base_url}",
        f"FEEDBACK_GITEA_REPO={options.gitea_repo}",
        f"FEEDBACK_ADDR={options.listen_address}",
    ])
    _checked(runner, [nssm, "start", service])


def main(argv: list[str] | None = None, *, runner: CommandRunner | None = None) -> int:
    parser = argparse.ArgumentParser(description="安装或重启 kacha 反馈中继 nssm 服务")
    parser.add_argument("--relay-binary", required=True, help="版本化反馈中继 exe 的路径")
    parser.add_argument("--gitea-base-url", default=DEFAULT_GITEA_URL)
    parser.add_argument("--gitea-repo", default=DEFAULT_GITEA_REPO)
    parser.add_argument("--listen-address", default=DEFAULT_LISTEN_ADDRESS)
    parser.add_argument("--service-name", default=SERVICE_NAME)
    parser.add_argument("--nssm", default=DEFAULT_NSSM)
    args = parser.parse_args(argv)

    options = DeployOptions(
        relay_binary=Path(args.relay_binary),
        gitea_base_url=args.gitea_base_url,
        gitea_repo=args.gitea_repo,
        listen_address=args.listen_address,
        service_name=args.service_name,
        nssm=args.nssm,
    )
    deploy_relay(options, runner=runner or process_runner)
    print(f"反馈中继服务已就绪：{options.service_name}（{options.listen_address}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
