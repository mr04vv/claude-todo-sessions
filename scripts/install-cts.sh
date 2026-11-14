#!/bin/sh

set -eu

repo_root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
install_dir="${CTS_INSTALL_DIR:-${HOME}/.local/bin}"
source_bin="$repo_root/target/release/cts"
target_bin="$install_dir/cts"

cargo build --release -p cts --manifest-path "$repo_root/Cargo.toml"
mkdir -p "$install_dir"
install -m 755 "$source_bin" "$target_bin"

echo "Installed cts to $target_bin"
