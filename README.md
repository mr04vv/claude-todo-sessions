# claude-todo-sessions

todo や GitHub issue を Claude Code のセッションに紐づけるローカルツールです。紐づけ先は Claude Desktop の Code タブのセッションでも CLI のセッションでも構いません。

- セッション内から MCP ツールで todo を操作できます（一覧・作成・更新・紐づけ）
- 起動時のプロンプトに `[todo:<id>]` を入れておくと、そのセッションが自動で todo に紐づきます
- hook がセッションの状態（running / needs_input / idle / ended）を記録します

設計は [設計書](https://claude.ai/code/artifact/8574c0b4-3336-416f-b00d-bd6769bf6b8c) にまとめています。

## 構成

| パス | 役割 |
| --- | --- |
| `crates/core` | SQLite に todo とセッションを保存するロジック |
| `crates/cts` | `cts mcp`（stdio の MCP サーバー）と `cts hook <event>`（hook の受け口）を持つ CLI |
| `plugin/` | Claude Code プラグイン（hooks・MCP 設定・skill） |
| `.claude-plugin/marketplace.json` | 手元のリポジトリからプラグインを入れるためのマーケットプレイス定義 |

## ビルド

```sh
cargo build --release
cargo test
```

nix の gcc が `cc` になっている環境では、リンク時に `-liconv` が見つからずビルドに失敗します。その場合は macOS 標準のコンパイラを指定してください。

```sh
export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/cc CC=/usr/bin/cc
```

## インストール

```sh
cargo build --release
claude plugin marketplace add /path/to/claude-todo-sessions
claude plugin install todo-sessions@claude-todo-sessions
```

インストール時には `target/release/cts` がプラグインのキャッシュにコピーされます。ビルドし直した場合は、`plugin/.claude-plugin/plugin.json` の version を上げてからプラグインを更新してください。

開発中は、インストールせずに次のように直接読み込むこともできます。

```sh
claude --plugin-dir ./plugin
```

## 使い方

- セッションの中で「この作業を todo #3 に紐づけて」「todo を一覧して」のように頼むと、Claude が MCP ツールを使って操作します
- todo に紐づけた状態で新しいセッションを始めたいときは、最初のプロンプトに `[todo:<id>]` を含めます
  - Desktop から始める場合は `open "claude://code/new?folder=<cwd>&q=%5Btodo%3A<id>%5D"` を使います。プロンプトが入力欄に入った状態で開きます
- `cts cloud sync` を実行すると、クラウドのセッションの状態を取り込み、最初のプロンプトに `[todo:<id>]` があるセッションを紐づけます
  - 非公開 API（`/v1/code/sessions`）を使うため、仕様が予告なく変わる可能性があります
  - Keychain の "Claude Code-credentials" を読みます。トークンの期限が切れていれば更新して書き戻します
- 既存のセッションを Desktop で開くには `open "claude://resume?session=<session_id>"` を使います

## データ

- DB：`~/Library/Application Support/claude-todo-sessions/db.sqlite`（環境変数 `CTS_DB` で変更できます）
- エラーログ：DB と同じディレクトリの `cts.log`
