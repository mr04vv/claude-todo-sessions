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

左のサイドバーから Todo・セッション・PR・通知の4つの画面を切り替えます。⌘K で操作（issue の取り込み、ちょっと Claude、今すぐ同期、画面の移動）と todo の検索、⌘N で todo の追加ができます。

- Todo：ボード（Todo / Doing / Review / Done の4列）とリストを切り替えられます
  - 「リポジトリ」でまとめると、最初のリポジトリ（またはグループ）ごとにレーンが分かれます。リポジトリのない todo は「リポジトリなし」レーンに入ります
  - 「親タスク」でまとめると、親 todo ごとのレーンと、親のない todo の「親なし」レーンに分かれます。リストでは「親なし」の行から親を設定できます
  - カードを列のあいだで動かすと status が変わります。各列の「＋ 新規」でその場で todo を追加できます（親タスクのレーンではサブタスクになります）
  - 上に入力待ちのセッションが並びます。「入力待ちだけ」「Done は直近3件」で絞り込めます
- セッション：todo に紐づいたものも紐づいていないものも一覧にします。選ぶと、最後のメッセージ・コンテキストのトークン数・モデル・直近の操作が見られます
  - 紐づいていないセッションは、ここで todo を作るか既存の todo に紐づけます
  - 上の「起動待ち」がキューです。ループを止めたり、順番や起動方法を変えたりできます
- PR：自分へのレビュー依頼（`gh search prs --review-requested @me`）と自分の PR（`--author @me`）を並べます
  - 「/review で開始」で、レビュー用の todo を作ってセッションを始めます。「todo にする」で PR を todo にします
  - 選んだ PR は右半分のアプリ内ブラウザで開きます
- 通知：入力待ち・作業が終わったときの通知の一覧です。未読に印が付きます
- サイドバーのリポジトリをクリックするとそのリポジトリだけに絞り込み、↗ で GitHub のリポジトリを開きます。左下に Claude の使用量（5時間・週間・モデルごと）が出ます
- カードをクリックするとサイドパネルが開きます。タイトル・ステータス・場所・親・issue / PR・フォルダ・メモ・リンクはその場で編集できます
  - issue / PR はタブでアプリ内ブラウザに開きます。パネル右上の ↗ は PR、issue、リポジトリの順に GitHub を開きます
  - 「新しいセッション」で最初のプロンプトを書き、スキル（過去によく使ったものが先）・起動先・モデル・effort を選んで始めます
  - 起動先は Cloud・Web（claude.ai をアプリ内ブラウザで開く。既定）/ Cloud・Desktop / Local・Desktop / herdr / キューです。モデルと effort は Cloud と herdr で効きます
  - 紐づいたセッションの「開く」は、Cloud ならアプリ内の Web、Local なら herdr の pane（なければ Desktop）で開きます。▾ でほかの開き方を選べます。閉じたセッションは、herdr では `claude --resume` で再開します
- 「issue を取り込む」（⌘K）で、自分に割り当てられた GitHub issue（`gh search issues --assignee @me`）を todo にします。作業フォルダは ghq の配置（`<ghq root>/github.com/<owner>/<repo>`）にあれば自動で入ります
- 「ちょっと Claude」（⌘K、セッション画面）で、todo に紐づけずに herdr でホームフォルダの claude を開きます

### 自動で行うこと

- クラウドセッションを30秒ごとに同期します
- GitHub は1分ごと（ウインドウを前に出したときと「今すぐ同期」でも）に同期します
  - `claude/todo-<id>-` ブランチの PR、またはセッションの作業ブランチでセッション開始後に作られた PR を todo に紐づけます
  - PR にレビュー依頼が入るか Approve されると Review、修正依頼で Doing、マージで Done にします。マージ時は、紐づいた issue が開いていれば close します
  - issue が close されたら Done にします
- サブタスクが全部 Done になると、親の todo も Done にします
- 紐づいたセッションが入力待ちになったときや、作業が終わったときに通知します。通知をクリックするとそのセッションが開き、アプリの通知一覧でも既読になります
- ウインドウを閉じてもメニューバーに常駐します。メニューバーのアイコンから、入力待ち・待機中のセッションを開いたり、アプリを終了したりできます

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
