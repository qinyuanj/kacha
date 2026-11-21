#!/usr/bin/env python3
"""把版本化反馈中继安装/重启为 Windows nssm 服务。

凭据只从 --token-env 指定的环境变量读取；脚本本身不打印 token，也不把凭据写进仓库。
部署动作全部经 runner 注入，便于测试断言参数、服务名、端口与失败语义。
"""

from __future__ import annotations

import argparse
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol

SERVICE_NAME = "kacha-feedbackrelay"
DEFAULT_GITEA_URL = "http://lzxsvn:3000"
DEFAULT_GITEA_REPO = "qinyuanj/kacha-feedback"
DEFAULT_LISTEN_ADDRESS = ":3005"
DEFAULT_TOKEN_ENV = "FEEDBACK_GITEA_TOKEN"
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
    token_env: str = DEFAULT_TOKEN_ENV
    nssm: str = DEFAULT_NSSM


def process_runner(args: list[str]) -> CommandResult:
    """真实 runner：命令不存在时转成 SystemExit，失败细节不回显（可能含 token）。"""
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
        # 不回显 stdout/stderr：nssm set AppEnvironment 的失败输出可能带 token。
        raise SystemExit(f"nssm {args[1]} 失败（退出码 {result.returncode}），服务未更新")
    return result


def deploy_relay(options: DeployOptions, *, runner: CommandRunner,
                 env: Mapping[str, str]) -> None:
    """幂等安装或重启服务；命令由 runner 记录，token 只留在进程内存与 nssm 配置中。"""
    token = env.get(options.token_env, "").strip()
    if not token:
        raise SystemExit(f"缺少环境变量 {options.token_env}：部署脚本只从环境变量读取 Gitea 写 token")
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

    _checked(runner, [nssm, "set", service, "AppDirectory", str(binary.parent)])
    _checked(runner, [
        nssm, "set", service, "AppEnvironment",
        "FEEDBACK_GITEA_URL", options.gitea_base_url,
        "FEEDBACK_GITEA_REPO", options.gitea_repo,
        "FEEDBACK_GITEA_TOKEN", token,
        "FEEDBACK_ADDR", options.listen_address,
    ])
    _checked(runner, [nssm, "start", service])


def main(argv: list[str] | None = None, *, runner: CommandRunner | None = None,
         env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="安装或重启 kacha 反馈中继 nssm 服务")
    parser.add_argument("--relay-binary", required=True, help="版本化反馈中继 exe 的路径")
    parser.add_argument("--gitea-base-url", default=DEFAULT_GITEA_URL)
    parser.add_argument("--gitea-repo", default=DEFAULT_GITEA_REPO)
    parser.add_argument("--listen-address", default=DEFAULT_LISTEN_ADDRESS)
    parser.add_argument("--service-name", default=SERVICE_NAME)
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV, help="保存 Gitea 写 token 的环境变量名")
    parser.add_argument("--nssm", default=DEFAULT_NSSM)
    args = parser.parse_args(argv)

    options = DeployOptions(
        relay_binary=Path(args.relay_binary),
        gitea_base_url=args.gitea_base_url,
        gitea_repo=args.gitea_repo,
        listen_address=args.listen_address,
        service_name=args.service_name,
        token_env=args.token_env,
        nssm=args.nssm,
    )
    deploy_relay(options, runner=runner or process_runner, env=os.environ if env is None else env)
    print(f"反馈中继服务已就绪：{options.service_name}（{options.listen_address}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
