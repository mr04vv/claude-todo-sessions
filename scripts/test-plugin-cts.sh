#!/bin/sh

set -eu

repo_root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
launcher="$repo_root/plugin/bin/cts"

if [ -L "$launcher" ]; then
  echo "plugin/bin/cts must be a regular file, not a symbolic link" >&2
  exit 1
fi

if [ ! -x "$launcher" ]; then
  echo "plugin/bin/cts must be executable" >&2
  exit 1
fi

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM

fake_cts="$test_dir/cts"
output="$test_dir/args"

# Keep variable expansion in the generated script, not in this test process.
# shellcheck disable=SC2016
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$@" > "$CTS_TEST_OUTPUT"' > "$fake_cts"
chmod +x "$fake_cts"

CTS_BIN="$fake_cts" CTS_TEST_OUTPUT="$output" "$launcher" hook stop codex

expected="$(printf '%s\n' hook stop codex)"
actual="$(cat "$output")"

if [ "$actual" != "$expected" ]; then
  echo "plugin/bin/cts did not forward arguments" >&2
  exit 1
fi

codex_manifest="$repo_root/plugin/.codex-plugin/plugin.json"
codex_hooks="$repo_root/plugin/hooks/codex.json"

if rg -q 'CLAUDE_PLUGIN_ROOT' "$codex_manifest" "$codex_hooks"; then
  echo "Codex plugin files must use PLUGIN_ROOT, not CLAUDE_PLUGIN_ROOT" >&2
  exit 1
fi

codex_mcp="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["mcpServers"])' "$codex_manifest")"
codex_mcp_path="$repo_root/plugin/${codex_mcp#./}"

if ! rg -q '\$\{PLUGIN_ROOT\}/bin/cts' "$codex_mcp_path" "$codex_hooks"; then
  echo "Codex MCP and hooks must resolve cts through PLUGIN_ROOT" >&2
  exit 1
fi
