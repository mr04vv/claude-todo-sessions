# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

todo や GitHub issue を Claude Code のセッション（CLI・Desktop の Code タブ・クラウド）に紐づけるローカルツール。macOS 専用。

## コマンド

```sh
cargo test                                   # 全テスト（core の unit + crates/core/tests/db.rs）
cargo test -p cts-core --test db <name>      # db.rs のテストを1つ
cargo test -p cts-core <name>                # core の unit テストを1つ
cargo build --release -p cts                 # plugin/bin/cts はこれへのシンボリックリンク
cd app && pnpm build                         # tsc -b で型チェック + vite build（フロントにテストはない）
cd app && pnpm tauri dev                     # アプリを開発起動
cd app && pnpm tauri build                   # target/release/bundle/macos/Todo Sessions.app
```

- `.cargo/config.toml` でリンカと CC を `/usr/bin/cc` に固定している（nix の gcc だと `-liconv` が見つからない）。
- ビルドした `.app` は利用者が自分で `/Applications` に入れ替える。コマンドは `pkill -x todo-sessions-app; sleep 1; rm -rf "/Applications/Todo Sessions.app" && cp -R target/release/bundle/macos/"Todo Sessions.app" /Applications/ && open -a "Todo Sessions"`（`sleep 1` がないと起動時に -600 になる）。
- アプリ（`app/`）の実装が終わったら、`cd app && pnpm tauri build` でビルドし、上の入れ替えコマンドを `cp -R` のパスを絶対パスにして `pbcopy` でクリップボードにコピーしておく。入れ替え（アプリの終了と再起動）は利用者が貼り付けて実行する。
- `crates/cts` を変えたら `plugin/.claude-plugin/plugin.json` の version を上げる。上げないと `claude plugin update todo-sessions@claude-todo-sessions` で新しいバイナリがキャッシュに入らない。

## 全体像

3つのバイナリが1つの SQLite（WAL）を共有する。DB は `~/Library/Application Support/claude-todo-sessions/db.sqlite`（`CTS_DB` で変更可）。

- `crates/core`（`cts-core`）: DB と外部連携のロジック。`lib.rs` が todo / session / link / notification のスキーマ・マイグレーション・クエリ、`cloud.rs` がクラウドセッション API（使用量と events も）、`launch.rs` が Desktop のディープリンク・起動プロンプト・モデルと effort（`StartOptions`）、`usage.rs` が使用量の解釈、`transcript.rs` がセッションの最後のメッセージ・コンテキスト・直近の操作の抽出（ローカルの jsonl とクラウドの events で共通）、`skills.rs` がスキルの発見と並び替え、`herdr.rs` / `agents.rs` / `desktop.rs` がローカルセッションの発見、`github.rs` が GraphQL の一括状態取得、`ogp.rs` がリンクの OGP 取得、`relevance.rs` がフォーカスモードで開こうとしたページの関連度判定（`claude -p --safe-mode` の引数・プロンプト・結果の読み取り。`--safe-mode` がないとこのプラグインの hook が判定をセッションとして記録してしまう）。
- `crates/cts`: Claude Code プラグインから呼ばれる CLI。`cts mcp`（rmcp の stdio MCP サーバー。todo の CRUD と紐づけ）、`cts hook <event>`（セッション状態の記録と `[todo:N]` マーカーでの紐づけ）、`cts cloud sync`。
- `app/src-tauri`（`todo-sessions-app`）: Tauri 2 のアプリ本体。`main.rs` 1ファイルに Tauri コマンドとバックグラウンドスレッドがある。
  - `sync_loop`: クラウドセッションの同期
  - `watch_loop`: トレイ（入力待ち・待機中）、通知（`notifications` に記録してアプリ内で一覧）、`claude agents --json` と herdr からのセッション発見（herdr の状態を優先）
  - `issue_sync_loop`: PR の発見と issue / PR 状態の同期
  - `queue_loop`: キューに入った todo の自動起動
  - アプリ内ブラウザは `tauri` の `unstable` 機能で、main ウインドウに子 WebView を重ねる。タブごとに1つ（label `browser-<tab id>`）で、表示中以外は hide。サイズ指定つきの新規ウインドウ（ログインのポップアップ）はそのまま開かせ、それ以外はタブにする。GitHub は iframe に埋め込めないため。子 WebView を足すと main は「webview window」でなくなり `get_webview_window("main")` が None を返すので、`get_window` を使う。
  - 端末ペイン（お試し）は `terminal.rs`（portable-pty で PTY を開き、出力を base64 の `term-output` イベントで送る）と `app/src/Terminal.tsx`（xterm.js。端末はビューより長生きするようにモジュールで持つ）。ブラウザペインのタブの1種類（`BrowserTab.term`）として出す。起動するコマンドは herdr と共通の `prepare_terminal` / `quick_run` / `resume_run` が組み立てる。シェルは `$SHELL -l -i -c` で、`.zshrc` の PATH や `claude` 関数がそのまま効く。外すときは、この2ファイル、`main.rs` の `mod terminal` と `terminal_*` コマンド、`App.tsx` の `TerminalContext` まわりとサイドバーの「ターミナル」を消す。
    - 見た目とキーは Ghostty に合わせる。`ghostty_config` が Ghostty の設定とテーマを、`ghostty_keybinds` が `ghostty +list-keybinds` の `text:` / `esc:` / `csi:` を返す。WebKit はページにシステムのフォントしか使わせない（`~/Library/Fonts` のフォントを名前で指定しても別のフォントになる）ので、`user_font` がファイルを渡し、`FontFace` で読み込んでから端末を開く。
    - xterm.js はトラックパッドの小さな移動を 0.3 倍にし、ホイールを受け取るアプリ（Claude Code・herdr）にはイベント1回で1段しか送らないので遅い。`attachCustomWheelEventHandler` で行数を出し、1行ごとに大きな `deltaY` の合成イベントを投げ直している。
- `app/src`: React 19。UI はほぼ `App.tsx` に集約（画面は Todo・セッション・PR・通知）、`api.ts` が Tauri コマンドと型の写し。
- `plugin/`: hooks・`.mcp.json`・skill。`.claude-plugin/marketplace.json` で手元から入れる。

### セッションと todo の紐づけ

- 最初のプロンプトに `[todo:N]` を入れて起動し、hook（ローカル）か cloud sync（クラウド）が拾って紐づける。プロンプトが `/` で始まる場合（`/grilling` など）はマーカーを末尾に置く（`launch::start_prompt`）。
- ターミナル起動は `claude --session-id <uuid>` で先に DB に登録してから herdr の新しいワークスペースで動かす。閉じたセッションの herdr ボタンは `claude --resume` で再開する。サイドバーの「ターミナル」がアプリ内なら、同じコマンドを端末ペインのタブで動かす（`terminal_start` / `terminal_quick` / `terminal_resume`。herdr で動いているセッションは herdr を前に出す）。「開く」も従い、タブ → herdr（pane を focus して `herdr session attach <name>` をタブで動かす。herdr のセッションごとに1タブ。herdr は入れ子の起動を拒むので、PTY では `HERDR_*` の環境変数を消している）→ Desktop で動いているなら Desktop → `claude --resume` の順。メニューバーと macOS 通知からは、設定を `set_in_app_terminal` でバックエンドに伝えておき、`open-local` イベントでフロントに開かせる。ちょっと Claude も `--session-id` をこちらで決めて、タブを見つけられるようにしている。
- Desktop への遷移: アーカイブされていなければ `claude://code/continue?session=local_…`、アーカイブ済みなら `claude://resume?session=<uuid>`（アーカイブも解除される）。クラウドは `claude://code/cse_…`。
- クラウドの Web は `https://claude.ai/code/session_…`（`cse_` を `session_` に置き換える。フロントは `api.ts` の `cloudWebUrl`、Rust は `launch::web_url`）。「開く」はサイドバーの「Cloud を開く」（Web / Desktop）に従う。メニューバーと macOS 通知からは `open-cloud` イベントでフロントに開かせる。

### クラウド（非公開 API）

- `GET /v1/code/sessions` と `POST /v1/sessions`（`anthropic-beta: ccr-byoc-2025-07-29`、`x-organization-uuid`）を使う。仕様は予告なく変わりうる。
- リポジトリなしのセッション（sources / outcomes が空）も作れる。ブランチは `claude/todo-<id>-<suffix>`。
- モデルと effort は作成時の `session_context.model` / `effort_level` に入れる（一覧では `config.model` / `config.effort_level` として見える）。既定のままなら送らない。
- 使用量は `GET /api/oauth/usage`（`anthropic-beta: oauth-2025-04-20`）の `limits`。頻繁に呼ぶと 429 になるので、フロントは取れたら5分おきに取り直す。
- アーカイブは `POST /v1/code/sessions/{cse_…}/archive`（CLI と同じ。アーカイブ済みでも 200 か 409）。sync のあと、Done の todo の Cloud セッションをターンが終わっていればアーカイブする（`Db::cloud_sessions_to_archive`）。Desktop の Local セッションは外からアーカイブする手段がない（Desktop が自分のファイルをメモリに持っている）ので扱わない。
- PR のレビューは todo を作らない。Cloud なら `create_review_session`（紐づけなし、ブランチは `claude/review-…`）、Local は `quick_run` にリポジトリのフォルダを渡す。
- 認証情報は Keychain の "Claude Code-credentials" を `/usr/bin/security` 経由で読み書きする。Security.framework を直接使うと、再ビルドのたびに Keychain の許可ダイアログが出る。

### GitHub 連携の自動化（`issue_sync_loop`）

- PR の発見は2通り: `claude/todo-<id>-` ブランチの PR、またはセッションの作業ブランチの PR。後者は `sessions.started_at` 以降に作られた PR だけを採用する（他人の古い PR を拾って誤って Done にしないため）。
- 状態遷移: PR が review_requested / approved で Review、changes_requested で Doing、merged で Done（未 close の issue も close）。issue が closed でも Done。
- サブタスクが全部 Done になると親も Done（`Db::finish_parent`）。階層は1段だけ。GitHub リポジトリを2つ以上持つ todo は計画用（`is_orchestrator`）で、Local の計画セッションが MCP で子 todo を作る。

## 変更時の注意

- todos に列を足すときは `TODOS_TABLE`・`TODO_TABLE_COLS`・`TODO_COLS`・`todo_from_row` のインデックス・`migrate` の列リストをそろえて直す。古い DB は `ALTER TABLE` で列を足し、CHECK 制約の変更はテーブルを作り直す（`migrate` 末尾）。後から足した整数列は TEXT 型で入っている DB があるので、`TODO_COLS` で `CAST(... AS INTEGER)` している。
- マイグレーションを足したら、古いスキーマから開くテストを `crates/core/tests/db.rs` に足す。
- notifications の `url` はレビュー依頼の PR（そのときの `session_id` は空文字）。画面は未読だけを出すが、同じ PR を二度通知しないように既読の行も消さずに残す（`add_review_notice`）。初めての確認では、来ているレビュー依頼を既読で記録するだけにする。
- フロントは3秒ごとに board を取り直す。その場で編集する入力欄は非制御（`defaultValue` + `key`）にしてある。制御コンポーネントにすると、IME の変換中に文字が消えることがある。
- Enter の判定は `isEnter` を使う。WebKit では、変換確定の Enter の時点で `isComposing` がもう false になっているので、keyCode 229 も見ている。
- Tauri の WebView では `window.confirm` が true を返さない。確認はインラインで出す。
