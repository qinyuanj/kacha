#!/usr/bin/env python3
"""用 tag v0.3.2 的 Rust 壳代码（board_pack.rs + store.rs）生成桌面版 v0.3.x 画板包夹具。

源数据见 v0.3.2-source.ts。产物 v0.3.2-flash-layers.ugcpack 已提交，服务端 cargo test 与 web e2e 共用。
需要 node、git 与 cargo（离线，使用 server/Cargo.lock 已下载的依赖）。用法：python client/fixtures/packs/generate-v0.3.2.py
"""

from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUTPUT = HERE / "v0.3.2-flash-layers.ugcpack"

CARGO_TOML = """\
[package]
name = "kacha-pack-v032"
version = "0.0.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
zip = { version = "8", default-features = false, features = ["deflate"] }
"""

MAIN_RS = """\
#![allow(dead_code)]
mod board_pack;
mod store;
use std::path::Path;
use std::sync::atomic::AtomicBool;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let spec: board_pack::ExportSpec = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
    let report = board_pack::export(Path::new(&a[1]), &spec, Path::new(&a[3]), &|_, _| {}, &AtomicBool::new(false)).unwrap();
    println!("{report:?}");
}
"""


def run(command: list[str]) -> None:
    # 按 PATH 与 PATHEXT 解析命令，Windows 上也能找到 .cmd 形式的工具。
    executable = shutil.which(command[0])
    if executable is None:
        raise SystemExit(f"找不到命令：{command[0]}")
    subprocess.run([executable, *command[1:]], check=True)


def show_at_tag(path: str) -> bytes:
    return subprocess.run(["git", "-C", str(REPO), "show", f"v0.3.2:{path}"], check=True, capture_output=True).stdout


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        run(["node", str(HERE / "v0.3.2-source.ts"), str(work / "root"), str(work / "elsewhere" / "猫.png"), str(work / "spec.json")])

        src = work / "gen" / "src"
        src.mkdir(parents=True)
        for name in ("board_pack.rs", "store.rs"):
            (src / name).write_bytes(show_at_tag(f"client/src-tauri/src/{name}"))
        (work / "gen" / "Cargo.toml").write_text(CARGO_TOML, encoding="utf-8")
        (src / "main.rs").write_text(MAIN_RS, encoding="utf-8")
        shutil.copy2(REPO / "server" / "Cargo.lock", work / "gen" / "Cargo.lock")
        out = work / "out.ugcpack"
        run(["cargo", "run", "--offline", "--quiet", "--manifest-path", str(work / "gen" / "Cargo.toml"), "--", str(work / "root"), str(work / "spec.json"), str(out)])
        shutil.copyfile(out, OUTPUT)
    print(f"已生成 {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
