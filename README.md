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

左のサイドバーから Todo カンバン・Todo リスト・セッション・PR・通知の画面を切り替えます。⌘K で操作（issue の取り込み、ちょっと Claude、今すぐ同期、画面の移動）と todo の検索、⌘N で todo の追加ができます。

- Todo：カンバン（Todo / Doing / Review / Pending / Done の5列）とリストの2つがあります。Pending は外部の返事待ちなどで止めている todo です
  - 「リポジトリ」でまとめると、最初のリポジトリ（またはグループ）ごとにレーンが分かれます。リポジトリのない todo は「リポジトリなし」レーンに入ります
  - 「親タスク」でまとめると、親 todo ごとのレーンと、親のない todo の「親なし」レーンに分かれます。リストでは「親なし」の行から親を設定できます
  - レーンは左の ▾ で折りたたみます。親タスクのレーンは、タイトルをクリックすると親の todo が開きます
  - 親が Done になった todo のサブタスクは表示しません（親は Done の列に残ります）
  - カードを列のあいだで動かすと status が変わります。各列の「＋ 新規」でその場で todo を追加できます（親タスクのレーンではサブタスクになります）
  - キーボードだけで操作できます（? で一覧）。j k / ↑↓ で移動（カンバンは h l / ←→ で左右の列、リストは h l でレーンの折りたたみ）、Enter でパネル（開いている間はカーソルに付いてきます）、Esc で閉じる、s でステータス、⇧h ⇧l（カンバン）でカードを左右の列へ、o でセッション（⌥Enter で開き方を選ぶ）、p で PR / issue、u で親の todo（リストの親のレーンは見出しで Enter でも）、c でその場所に todo を追加、/ で絞り込み欄へ
  - 上に入力待ちのセッションが並びます。「入力待ちだけ」「Done は直近3件」で絞り込めます
  - 「絞り込み」欄でタイトル・メモの言葉、「フィルター」でステータス・場所・入力待ちを指定できます（カンバンとリストで別々に持ち、アプリを閉じても残ります）。「保存…」で名前を付けると、サイドバーの「フィルター」と ⌘K から、保存したときのページ（カンバンかリスト）で呼び出せます
- セッション：todo に紐づいたものも紐づいていないものも一覧にします。行をクリックすると「開く」と同じくセッションを開き、右端の … で詳細（最後のメッセージ・コンテキストのトークン数・モデル・直近の操作）を出します
  - ↑↓ か j / k で行を選び、Enter で開きます。⌥Enter で開き方を選ぶメニューが出ます（メニューの中も ↑↓ / j k と Enter で選べます）
  - 紐づいていないセッションは、ここで todo を作るか既存の todo に紐づけます
  - 上の「起動待ち」がキューです。ループを止めたり、順番や起動方法を変えたりできます
  - Cloud のセッションはアーカイブできます（claude.ai でアーカイブするのと同じです）。「開く」の ▾、セッションのパネル、上の「待機中の Cloud をアーカイブ」（待機中のものをまとめて）から行えます
- PR：自分へのレビュー依頼（`gh search prs --review-requested @me`）と自分の PR（`--author @me`）を並べます
  - 「/review で開始」で、todo を作らずにレビューのセッションを始めます（日本語で依頼し、提出前に確認します）。▾ から始めると、指摘の有無に応じて Request changes / Comment / Approve を自動で提出します。セッションを始める場所は上のプルダウンで選びます。「todo にする」で自分の PR を todo にします
  - 選んだ PR は右側のアプリ内ブラウザで開きます。↑↓ か j / k で行を選びます。レビュー依頼で Enter を押すと、自動で提出するか提出前に確認するかを選んでレビューを始めます。自分の PR と ⌥Enter は PR を開きます
- 通知：入力待ち・作業が終わったとき・レビューを頼まれたときの通知のうち、まだ見ていないものが並びます。「開く」（レビュー依頼は「/review で開始」でレビューを始めます）か ✕ で消えます。↑↓ か j / k で選び、Enter でセッションを開きます（レビュー依頼は、自動で提出するか提出前に確認するかを選んで始めます）。⌥Enter で行を開きます（レビュー依頼は PR、ほかは todo）
- アプリ内ブラウザは右側に開き、画面を切り替えても開いたままです。サイドバーの「ブラウザ」でいつでも表示・非表示を切り替えられ（隠してもタブは残ります）、⌘T で新しいタブを開けます。issue / PR のチップ、PR の行、Cloud セッションの「開く」はタブで開きます（開いているページならそのタブに切り替えます）。ページが新しいウインドウで開くリンクもタブになります。ログインはブラウザごとに一度必要で、アプリを再起動しても保たれます。⌘L でアドレス欄を編集（Esc でやめる）、⌘R で再読み込み、⌘[ ⌘] で戻る・進む、⌘⇧[ ⌘⇧] でタブを切り替えられます。⌘W で表示中のタブを閉じます。右クリックで選択範囲やページを Google 翻訳で訳せます（⌥ + 右クリックで標準のメニュー）
  - ChatGPT と Claude Code（claude.ai/code）は、タブ列の左端とサイドバーに常駐し、⌘K からも開けます。閉じないので、開いたページの状態が保たれます
  - claude.ai の Cloud セッションのページでは、⌘⇧A かアドレス欄横の「アーカイブ」で、そのセッションをアーカイブしてタブを閉じます
  - サイドバー左下の「Cloud を開く」で、Cloud セッションの「開く」（メニューバーと通知からも）を Web（アプリ内ブラウザ）にするか Claude Desktop にするか選べます
  - サイドバー左下の「リンクを開く」を Dia にすると、これらのページはアプリ内ではなく Dia（ふだんのログイン状態のまま）で開きます。アプリ内ブラウザの「Dia で開く」で、今のページだけ Dia に移すこともできます
- サイドバーのリポジトリをクリックするとそのリポジトリだけに絞り込み、↗ で GitHub のリポジトリを開きます。左下に Claude の使用量（5時間・週間・モデルごと）が出ます
- カードをクリックするとサイドパネルが開きます。タイトル・ステータス・場所・親・issue / PR・フォルダ・メモ・リンクはその場で編集できます
  - issue / PR のリンクはアプリ内ブラウザで開きます。パネル右上の ↗ は PR、issue、リポジトリの順にいつものブラウザで GitHub を開きます
  - 「新しいセッション」で最初のプロンプトを書き、スキル（過去によく使ったものが先）・起動先・モデル・effort を選んで始めます
  - 起動先は Cloud・Web（claude.ai をアプリ内ブラウザで開く。既定）/ Cloud・Desktop / Local・Desktop / herdr / キューです。モデルと effort は Cloud と herdr で効きます
  - 紐づいたセッションの「開く」は、Cloud ならアプリ内の Web、Local なら herdr の pane（なければ Desktop）で開きます。▾ でほかの開き方を選べます。閉じたセッションは、herdr では `claude --resume` で再開します
- 「issue を取り込む」（⌘K）で、自分に割り当てられた GitHub issue（`gh search issues --assignee @me`）を todo にします。作業フォルダは ghq の配置（`<ghq root>/github.com/<owner>/<repo>`）にあれば自動で入ります
- 「ちょっと Claude」（⌘K、セッション画面）で、todo に紐づけずに herdr でホームフォルダの claude を開きます
- サイドバー左下の「ターミナル」で、Local のセッションを動かす場所を Ghostty（herdr。既定）かアプリ内にするか選べます。アプリ内にすると、起動先 herdr（表示は「ターミナル」）、PR の /review、ちょっと Claude、閉じたセッションの再開が、右側のペインのターミナルタブ（`$` 付き）で動きます。Local のセッションの「開く」（通知画面・メニューバー・macOS の通知からも）は、そのセッションのターミナルタブ、herdr（pane を選んだ状態で herdr のセッションをターミナルタブに attach）、Claude Desktop（Desktop で動いているセッション）の順に探し、どこにもなければターミナルタブで `claude --resume` します。タブを切り替えたりペインを隠したりしても出力は残り、タブを閉じると中の claude も終わります。お試しの機能です
  - 見た目とキーは Ghostty の設定に合わせます。フォント（`~/Library/Fonts` のもの）・サイズ・余白・テーマ・カーソルを Ghostty の設定から読み、キーは `ghostty +list-keybinds` の内容（⌘← ⌘→ で行頭・行末、⌘⌫ で行の削除、⇧Enter で改行など）を送ります
  - スクロールは Ghostty と同じく、トラックパッドで動かした分だけ行が進みます。変換中の日本語は端末のマス目に沿って表示します

### 自動で行うこと

- クラウドセッションを30秒ごとに同期します
- GitHub は1分ごと（ウインドウを前に出したときと「今すぐ同期」でも）に同期します
  - `claude/todo-<id>-` ブランチの PR、またはセッションの作業ブランチでセッション開始後に作られた PR を todo に紐づけます
  - PR にレビュー依頼が入るか Approve されると Review、修正依頼で Doing、マージで Done にします。マージ時は、紐づいた issue が開いていれば close します
  - issue が close されたら Done にします
- サブタスクが全部 Done になると、親の todo も Done にします
- Done になった todo の Cloud セッションを、ターンが終わっていればアーカイブします
- 紐づいたセッションが入力待ちになったときや、作業が終わったときに通知します。通知をクリックするとそのセッションが開き、アプリの通知一覧からも消えます
- 自分へのレビュー依頼が新しく来たら通知します。通知をクリックすると PR が開きます
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
