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
cd app && pnpm tauri dev                     # アプリを開発起動（ブラウザペインは動かない。下を参照）
cd app && pnpm tauri build                   # target/release/bundle/macos/Shosai.app（まだ Chromium が入っていない）
scripts/bundle-cef.sh                        # その .app に Chromium とヘルパーアプリを入れる（引数 debug で debug 版）
```

- アプリのビルドには `cmake` と `ninja`（cef クレートの `libcef_dll_wrapper` 用。無ければ `nix shell nixpkgs#cmake nixpkgs#ninja -c …`）と、CEF のバイナリ置き場 `CEF_PATH`（既定 `~/.local/share/cef`。cef-rs の `cargo run -p export-cef-dir -- --force $HOME/.local/share/cef` で作る。`cef` クレートと同じバージョンのもの）が要る。
- `.cargo/config.toml` でリンカと CC・CXX を `/usr/bin/cc` に固定している（nix の gcc だと `-liconv` が見つからない）。
- ビルドした `.app` は利用者が自分で `/Applications` に入れ替える。コマンドは `pkill -x todo-sessions-app; sleep 1; rm -rf "/Applications/Todo Sessions.app" "/Applications/Shosai.app" && cp -R target/release/bundle/macos/Shosai.app /Applications/ && open /Applications/Shosai.app`（`sleep 1` がないと起動時に -600 になる。`open -a Shosai` だとビルドしたフォルダの同じ名前の .app を開くことがあるので、場所で開く。古い名前の `Todo Sessions.app` も消す）。.app の名前は Shosai だが、中のバイナリ（とプロセス名）は `todo-sessions-app` のまま。
- アプリ（`app/`）の実装が終わったら、`cd app && pnpm tauri build` と `scripts/bundle-cef.sh` でビルドし、上の入れ替えコマンドを `cp -R` のパスを絶対パスにして `pbcopy` でクリップボードにコピーしておく。入れ替え（アプリの終了と再起動）は利用者が貼り付けて実行する。
- `crates/cts` を変えたら `plugin/.claude-plugin/plugin.json` の version を上げる。上げないと `claude plugin update todo-sessions@claude-todo-sessions` で新しいバイナリがキャッシュに入らない。

## 全体像

3つのバイナリが1つの SQLite（WAL）を共有する。DB は `~/Library/Application Support/claude-todo-sessions/db.sqlite`（`CTS_DB` で変更可）。

- `crates/core`（`cts-core`）: DB と外部連携のロジック。`lib.rs` が todo / input / theme / category / session / link / notification のスキーマ・マイグレーション・クエリ、`cloud.rs` がクラウドセッション API（使用量と events も）、`launch.rs` が Desktop のディープリンク・起動プロンプト・モデルと effort（`StartOptions`）、`usage.rs` が使用量の解釈、`transcript.rs` がセッションの最後のメッセージ・コンテキスト・直近の操作の抽出（ローカルの jsonl とクラウドの events で共通。テーマのノートの URL もここで探す）、`skills.rs` がスキルの発見と並び替え、`herdr.rs` / `agents.rs` / `desktop.rs` がローカルセッションの発見、`github.rs` が GraphQL の一括状態取得、`ogp.rs` がリンクの OGP 取得（`fetch_text` はページ本文のフォールバック）、`study.rs` が学びのプロンプトと答えの解釈（振り分け・次に読むもの・復習の質問・ノートへの書き込み）、`feynman.rs` が復習の採点（プロンプト・JSON スキーマ・理解度と復習間隔）。
- `crates/cts`: Claude Code プラグインから呼ばれる CLI。`cts mcp`（rmcp の stdio MCP サーバー。todo の CRUD と紐づけ）、`cts hook <event>`（セッション状態の記録と `[todo:N]` マーカーでの紐づけ）、`cts cloud sync`。
- `app/src-tauri`（`todo-sessions-app`）: Tauri 2 のアプリ本体。`main.rs` 1ファイルに Tauri コマンドとバックグラウンドスレッドがある。
  - `sync_loop`: クラウドセッションの同期
  - `watch_loop`: トレイ（入力待ち・待機中）、通知（`notifications` に記録してアプリ内で一覧）、`claude agents --json` と herdr からのセッション発見（herdr の状態を優先）
  - `issue_sync_loop`: PR の発見と issue / PR 状態の同期
  - `queue_loop`: キューに入った todo の自動起動
  - アプリ内ブラウザは Chromium（CEF）。WKWebView（Safari と同じ WebKit）は claude.ai で一番下までスクロールできず戻る（Safari でも起きる）ので使わない。`cef_browser.rs` が、メインウインドウの contentView の上に、タブごとに CEF の NSView を重ねる（`browser_open` / `browser_bounds` が置き、`browser_hide` が隠す）。サイズ指定つきの新規ウインドウ（ログインのポップアップ）はそのまま開かせ、それ以外はタブにする。GitHub は iframe に埋め込めないため。
    - CEF は `external_message_pump` で、Tauri のメインスレッドから動かす（`start_pump` が `on_schedule_message_pump_work` と 1/30 秒ごとに `do_message_loop_work` を呼ばせる）。他のスレッドからは `on_main` を通す。`CefApplication`（NSApplication のサブクラス）は Tauri が NSApplication を作るより前に作る必要があり、`main` の最初で `cef_browser::init()` を呼ぶ。
    - `.app` の中に `Chromium Embedded Framework.framework` と、`todo-sessions-app Helper (GPU)` などのヘルパーアプリ（`src/bin/helper.rs` のバイナリのコピー）が要る。Tauri のバンドラーは作らないので `scripts/bundle-cef.sh` が入れる。無いとき（`cargo run` や `pnpm tauri dev`）は `init()` が false を返し、アプリは動くがブラウザペインは「Chromium が入っていません」になる。
    - プロファイル（Cookie など。ログインが再起動後も残る）は DB と同じフォルダの `cef/`。終了時（`RunEvent::Exit`）に `cef_browser::shutdown` が閉じて書き出す。同じフォルダを2つ目のインスタンスが開くと `initialize` が失敗する（`CTS_DB` を変えれば別のフォルダになる）。
    - ページのスクリプト（`browser_page.js`）は、ヘルパーの `on_context_created` が全ページ・全フレームで、ページのスクリプトより前に動かす。ページからアプリへの連絡は `console.debug("todo-sessions://…")` で、ブラウザプロセスの `on_console_message` が拾って `page_message` で処理する（昔はこのスキームへのナビゲーションを止めていた）。アプリからページへは `cef_browser::eval`（main frame の `execute_java_script`）。
    - Chromium は Cookie の鍵を Keychain の "Chromium Safe Storage"（account "Chromium"）から読む。名前は CEF の中で決まっていて変えられず、ほかの Chromium 系のアプリ（Chrome for Testing・Lightroom など）と同じ項目を使う（消すとそれらの保存したログインが読めなくなる）。Shosai はその ACL に入っていないので、初めは起動時に「許可しますか」が2回（ACL と、チームの partition）出て、答えるまでページの読み込みが止まる。「常に許可」をクリックすれば以後は出ない（署名がビルドをまたいで同じなので、ACL には証明書の要件で入る）。パスワードを入れて Return を押すと既定の「許可」（今回だけ）になる。記録されたかは `log show --predicate 'process == "securityd"'` に `user approved 'always allow'` が出るかで分かる（「許可」だけなら `user approved 'allow'`）。
    - ズームは ⌘= ⌘- ⌘0 だけ（`set_zoom_level`）。ページの本文は `frame.text`（`browser_text`）。
  - 端末ペイン（お試し）は `terminal.rs`（portable-pty で PTY を開き、出力を base64 の `term-output` イベントで送る）と `app/src/Terminal.tsx`（xterm.js。端末はビューより長生きするようにモジュールで持つ）。ブラウザペインのタブの1種類（`BrowserTab.term`）として出す。起動するコマンドは herdr と共通の `prepare_terminal` / `quick_run` / `resume_run` が組み立てる。シェルは `$SHELL -l -i -c` で、`.zshrc` の PATH や `claude` 関数がそのまま効く。外すときは、この2ファイルと `app/src/kitty.ts`、`main.rs` の `mod terminal` と `terminal_*` コマンド、`App.tsx` の `TerminalContext` まわりとサイドバーの「ターミナル」を消す。
    - 見た目とキーは Ghostty に合わせる。`ghostty_config` が Ghostty の設定とテーマを、`ghostty_keybinds` が `ghostty +list-keybinds` の `text:` / `esc:` / `csi:` を返す。WebKit はページにシステムのフォントしか使わせない（`~/Library/Fonts` のフォントを名前で指定しても別のフォントになる）ので、`user_font` がファイルを渡し、`FontFace` で読み込んでから端末を開く。
    - xterm.js はトラックパッドの小さな移動を 0.3 倍にし、ホイールを受け取るアプリ（Claude Code・herdr）にはイベント1回で1段しか送らないので遅い。`attachCustomWheelEventHandler` で行数を出し、1行ごとに大きな `deltaY` の合成イベントを投げ直している。
    - xterm.js は ⌘ の組み合わせを送らず、kitty keyboard protocol も持たない。`kitty.ts` が `CSI > u` などでプログラム（herdr）が立てたフラグを追い、立っている間は ⌥ と ⌘ / ⌃ の組み合わせ（herdr の `cmd+alt+[` など）を CSI u で送る。⌘ だけの組み合わせはアプリとシステムに残す。
- `app/src`: React 19。UI はほぼ `App.tsx` に集約（画面は Todo・Doing（Todo の画面で Doing の todo だけを並べたもの。今日やるものを Doing にする運用のため）・セッション・PR・成果物・Slack・学び）、`api.ts` が Tauri コマンドと型の写し。
- 署名: `scripts/bundle-cef.sh` が `SHOSAI_SIGNING_IDENTITY`（無ければ最初の "Apple Development:" の証明書、それも無ければ ad hoc）で、framework・ヘルパー・本体の順に署名する。Hardened Runtime（`--options runtime`。`SHOSAI_HARDENED=0` で外す）で、entitlements は `app/src-tauri/entitlements/`（CEF の JIT、マイクとカメラ）。証明書で署名すると designated requirement がビルドをまたいで同じになり、Keychain の「常に許可」が残る。
- `plugin/`: hooks・`.mcp.json`・skill。`.claude-plugin/marketplace.json` で手元から入れる。

### セッションと todo の紐づけ

- 最初のプロンプトに `[todo:N]` を入れて起動し、hook（ローカル）か cloud sync（クラウド）が拾って紐づける。プロンプトが `/` で始まる場合（`/grilling` など）はマーカーを末尾に置く（`launch::start_prompt`）。
- ターミナル起動は `claude --session-id <uuid>` で先に DB に登録してから herdr の新しいワークスペースで動かす。閉じたセッションの herdr ボタンは `claude --resume` で再開する。サイドバーの「ターミナル」がアプリ内なら、同じコマンドを herdr の新しいワークスペースで動かし、端末ペインのタブはその herdr のセッションに attach する（`terminal_start` / `terminal_quick` / `terminal_resume` が `via_herdr` を通す。herdr が止まっていればタブで直接動かす。herdr で動いているセッションは herdr を前に出す）。「開く」も従い、タブ → herdr（pane を focus して `herdr session attach <name>` をタブで動かす。herdr のセッションごとに1タブ。herdr は入れ子の起動を拒むので、PTY では `HERDR_*` の環境変数を消している）→ Desktop で動いているなら Desktop → `claude --resume` の順。メニューバーと macOS 通知からは、設定を `set_in_app_terminal` でバックエンドに伝えておき、`open-local` イベントでフロントに開かせる。ちょっと Claude も `--session-id` をこちらで決めて、タブを見つけられるようにしている。
- Codex（`Agent::Codex`、`sessions.agent`）は herdr の中だけ。`--session-id` を渡せないので先に登録せず、`discover_sessions` が herdr の agent list（codex も返す）で見つけ、`~/.codex/sessions` の rollout の最初のプロンプト（`codex::first_prompt`）で名前と `[todo:N]` の紐づけをする（`name_from_prompt`、一度だけ `marker_checked`）。プロンプトは `launch::codex_body`（Claude のスキルと AskUserQuestion の文を外す）。再開は `codex resume`。
- Desktop への遷移: アーカイブされていなければ `claude://code/continue?session=local_…`、アーカイブ済みなら `claude://resume?session=<uuid>`（アーカイブも解除される）。クラウドは `claude://code/cse_…`。
- クラウドの Web は `https://claude.ai/code/session_…`（`cse_` を `session_` に置き換える。フロントは `api.ts` の `cloudWebUrl`、Rust は `launch::web_url`）。「開く」はサイドバーの「Cloud を開く」（Web / Desktop）に従う。メニューバーと macOS 通知からは `open-cloud` イベントでフロントに開かせる。

### 学び（テーマ）

- 画面の「学び」はカテゴリ → テーマ → 読むもの（input）の3段。カテゴリ（`categories`）はテーマを束ねるだけで名前しか持たない。テーマ（`themes`。名前・目標・claude.ai のノートの URL・`category_id`）は一つの概念（OIDC・CSP）で、ノートと復習と理解度はテーマごと。昔のテーマは広い分野だったので、`category_id` の無い `themes` から開いたときに `migrate` がカテゴリへ移す（読むものは未分類へ戻し、テーブルを作り直す）。テーマの id は使い回さない（`AUTOINCREMENT`。学ぶ時間のページを id で保存しているため）。
- input は todo ではない。`inputs` / `input_links` テーブル（`Db::create_input` など）にあり、ステータス・親子・セッションの紐づけを持たない（`done` と `theme_id` だけ）。`theme_id` が無いものが「まだテーマにないもの」。ページのリンクを ⌥ クリックするか、⌘⇧D（`AddToThemeDialog`）か、学びの画面に URL を貼ると入る。昔は kind が `input` の todo だったので、`migrate` の最後で id のまま移す。
- Claude には `claude -p --output-format json --json-schema …` で聞く（`ask.rs`）。振り分け（`sort_unsorted`。新しいテーマのカテゴリか、新しいカテゴリも提案する）・次に読むもの（`next_reads`。前回の復習であいまいだったところから）は sonnet。プロンプトは core の `study.rs`、コマンドはアプリの `study.rs`。
- 学ぶ時間（画面の名前。コードでは focus mode：`focusMode`・`FocusMode`・`FOCUS_*` のまま）はテーマごとの「スペース」（`InputSpace`。左にテーマのページのタブ、右に LLM。右は `RIGHT_KINDS` の ChatGPT か Claude で、会話はテーマのもの）。キーは `subjectKey`（`h<id>`、テーマなしは `FREE_SPACE`）。タブは `BrowserTab.focus` と `space` で、右のページは `kind` と `rightTabId(space, kind)` の id。終えてもスペースは隠すだけで残す。localStorage の `inputSpaces`（`SavedSpace`。左右のページの URL）に保存し、再起動後は保存した URL から開き直す。開くときにテーマのページで足りないものは左に足す。
- テーマにノートがあれば、学ぶ時間は復習から始まる（`ReviewPanel`）。`review_questions` がノートを Claude Docs のツールで読んで 2〜3 問作り、`review_grade` が `feynman::grade_prompt` で採点して `feynman_attempts`（subject_kind `theme`）に残す。次の復習どき（`feynman::review_after_days`）は通知せず、`Board.feynman` からサイドバーとテーマの一覧に「復習」と出す。
- 「読み終わった」（`finish_reading`）は、左のページの本文（`browser_text` が CEF の `frame.text` で読む。タブに無ければ `page_text`）と右の会話を、Mac の Claude（`claude -p`、Claude Docs のコネクタ）にテーマのノートへ書き足させる。初回はノートを作らせ、最後の `NOTE_URL:` の行（`transcript::note_url`）から URL を取って、テーマと成果物に残す。終わったら `theme-doc-written` イベント。
- 学びの画面のキーは `keymap.ts` の「学びの画面」。一覧の J K / H L / Enter は `useRowCursor`（行は `themes.ts` の `themeRows`）、読むものの ⇧J ⇧K と残りのキーはページの keydown。
- `src-tauri/Info.plist` にマイクの許可説明がある（右の ChatGPT の音声モード用。ブラウザペインはページのマイク許可を通す作り（`PagePermission`）。ヘルパーアプリの Info.plist にも同じ説明が要る（`scripts/bundle-cef.sh`））。

### クラウド（非公開 API）

- `GET /v1/code/sessions` と `POST /v1/sessions`（`anthropic-beta: ccr-byoc-2025-07-29`、`x-organization-uuid`）を使う。仕様は予告なく変わりうる。
- リポジトリなしのセッション（sources / outcomes が空）も作れる。ブランチは `claude/todo-<id>-<suffix>`。
- モデルと effort は作成時の `session_context.model` / `effort_level` に入れる（一覧では `config.model` / `config.effort_level` として見える）。既定のままなら送らない。
- 使用量は `GET /api/oauth/usage`（`anthropic-beta: oauth-2025-04-20`）の `limits`。頻繁に呼ぶと 429 になるので、フロントは取れたら5分おきに取り直す。
- アーカイブは `POST /v1/code/sessions/{cse_…}/archive`（CLI と同じ。アーカイブ済みでも 200 か 409）。sync のあと、Done の todo の Cloud セッションをターンが終わっていればアーカイブする（`Db::cloud_sessions_to_archive`）。Desktop の Local セッションは外からアーカイブする手段がない（Desktop が自分のファイルをメモリに持っている）ので扱わない。
- PR のレビューは todo を作らない。Cloud なら `create_review_session`（紐づけなし、ブランチは `claude/review-…`）、Local は `quick_run` にリポジトリのフォルダを渡す。
- アプリ内ブラウザのログイン保存と Slack のトークンは、Security.framework（`security-framework` クレート、`logins.rs` の `load_secret` / `save_secret`）で Keychain に置く。service はログインが `shosai-login`（account はホスト）、Slack が `shosai-slack`。作ったアプリ（Shosai）だけが ACL に入り、partition はチーム ID なので、ほかのプログラムが読もうとすると確認が出る。昔は `/usr/bin/security` で `todo-sessions-login` / `todo-sessions-slack` に置いていて（誰でも確認なしに読めた）、起動時の `migrate` が移して読み戻してから古いほうを消す。移るまでは古いほうからも読む。ページのスクリプトは送信時に `todo-sessions://login-captured` で知らせ、`on_page_load` が保存済みのホストにだけ `__todoSessionsFill` を呼ぶ。
- Claude の認証情報は Keychain の "Claude Code-credentials" を `/usr/bin/security` 経由で読み書きする（`cloud.rs`）。この項目の ACL には `/usr/bin/security` が入っていて（partition は `apple-tool:`）、Shosai は入っていないので、Security.framework で直接読むと確認が出る。

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
- Claude Code の中（`!` の入れ替えコマンドなど）から `open` したアプリは、そのセッションの `CLAUDECODE` や `CLAUDE_CODE_*` を受け継ぐ。そのまま `claude` を起動すると親セッションの子として動き、transcript が `~/.claude/projects` に出ない（ノートが見つからない）ので、`main` の最初で消している（`inherited_session_vars`）。
