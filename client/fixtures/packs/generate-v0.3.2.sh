#!/usr/bin/env bash
# 用 tag v0.3.2 的 Rust 壳代码（board_pack.rs + store.rs）生成桌面版 v0.3.x 画板包夹具。
# 源数据见 v0.3.2-source.ts。产物 v0.3.2-flash-layers.ugcpack 已提交，服务端 cargo test 与 web e2e 共用。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

node "$here/v0.3.2-source.ts" "$work/root" "$work/elsewhere/猫.png" "$work/spec.json"

mkdir -p "$work/gen/src"
git -C "$repo" show v0.3.2:client/src-tauri/src/board_pack.rs > "$work/gen/src/board_pack.rs"
git -C "$repo" show v0.3.2:client/src-tauri/src/store.rs > "$work/gen/src/store.rs"
cat > "$work/gen/Cargo.toml" <<'EOF'
[package]
name = "kacha-pack-v032"
version = "0.0.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
zip = { version = "8", default-features = false, features = ["deflate"] }
EOF
cat > "$work/gen/src/main.rs" <<'EOF'
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
EOF
cp "$repo/server/Cargo.lock" "$work/gen/Cargo.lock"
cargo run --offline --quiet --manifest-path "$work/gen/Cargo.toml" -- "$work/root" "$work/spec.json" "$work/out.ugcpack"
cp "$work/out.ugcpack" "$here/v0.3.2-flash-layers.ugcpack"
echo "已生成 $here/v0.3.2-flash-layers.ugcpack"
