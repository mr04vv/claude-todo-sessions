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

`.cargo/config.toml` で、リンカと C コンパイラに macOS 標準の `/usr/bin/cc` を指定しています。nix の gcc が `cc` になっている環境では、`-liconv` が見つからずビルドに失敗するためです。

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

## アプリ

`app/` は Tauri + React のデスクトップアプリです。

```sh
cd app
pnpm install
pnpm tauri dev      # 開発用に起動
pnpm tauri build    # target/release/bundle/macos/Todo Sessions.app を作成
```

ビルドした `.app` は `/Applications` に置いて使います（ビルドし直したら入れ替えます）。

```sh
pkill -x todo-sessions-app; sleep 1; rm -rf "/Applications/Todo Sessions.app" && cp -R "target/release/bundle/macos/Todo Sessions.app" /Applications/ && open -a "Todo Sessions"
```

### 画面

- ボード：Todo / Doing / Review / Done の4列のカンバンと、未紐づけのセッションを並べる受信箱の列があります
  - 「リポジトリ」表示ではリポジトリ（またはグループ）ごとに、「親タスク」表示では親 todo ごとにレーンが分かれます
  - カードを列のあいだで動かすと status が変わり、受信箱のセッションをカードに落とすと紐づきます
  - 各列の「＋ 新規」でその場で todo を追加できます。親タスクのレーンではサブタスクになります
- リスト、バックログ（リポジトリ未設定の todo）、受信箱、キューの画面があります
- 左のサイドバーのリポジトリをクリックすると、そのリポジトリだけに絞り込みます
- カードをクリックするとサイドパネルが開きます。タイトル・メモ・リポジトリなどはその場で編集できます
  - サブタスクの追加、リンク（URL）の添付（OGP のタイトルと画像を表示）、GitHub の issue / PR の紐づけもここで行います
  - 「セッションを開始」で、Cloud（Desktop で開く）/ Local（Desktop）/ Local（ターミナル＝herdr）/ キューのどこで始めるかを選べます
  - リポジトリのない todo（調査など）も Cloud で始められます
  - 紐づいたセッションは Desktop か herdr で開けます。閉じたセッションは、herdr では `claude --resume` で再開します
- 「issue を取り込む」で、自分に割り当てられた GitHub issue（`gh search issues --assignee @me`）を todo にします。作業フォルダは ghq の配置（`<ghq root>/github.com/<owner>/<repo>`）にあれば自動で入ります
- 「ちょっと Claude」で、todo に紐づけずに herdr でホームフォルダの claude を開きます

### 自動で行うこと

- クラウドセッションを30秒ごとに同期します
- GitHub は1分ごと（ウインドウを前に出したときと「今すぐ同期」でも）に同期します
  - `claude/todo-<id>-` ブランチの PR、またはセッションの作業ブランチでセッション開始後に作られた PR を todo に紐づけます
  - PR にレビュー依頼が入るか Approve されると Review、修正依頼で Doing、マージで Done にします。マージ時は、紐づいた issue が開いていれば close します
  - issue が close されたら Done にします
- サブタスクが全部 Done になると、親の todo も Done にします
- 紐づいたセッションが入力待ちになったときや、作業が終わったときに通知します。通知をクリックするとそのセッションが開きます
- ウインドウを閉じてもメニューバーに常駐します。メニューバーのアイコンから、入力待ちのセッションを開いたり、アプリを終了したりできます

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
