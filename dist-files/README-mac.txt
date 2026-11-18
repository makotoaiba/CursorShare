CursorShare（Mac版）
自分の画面と音声を共有し、参加者のマウスカーソルを色付き・名前付きで表示するアプリです。
機能は Windows 版と同じです（使い方の詳細は Windows 版の README と共通。下の「Mac で違うところ」だけ読めばOK）。

■ どちらをダウンロードする？
- Apple シリコン（M1 / M2 / M3 / M4 …）の Mac … CursorShare-x.x.x-mac-arm64.zip
- Intel の Mac … CursorShare-x.x.x-mac-x64.zip
  （ メニュー →「この Mac について」の「チップ」に Apple と出ていれば Apple シリコン）

■ インストール
1. zip を開くと「CursorShare」フォルダができます
2. 中の CursorShare.app を「アプリケーション」フォルダに移します
   （config.json を使う場合は、CursorShare.app と同じフォルダに置いてください）

■ 初めて開くとき（署名のない自作アプリのため、Mac が止めます）
1. CursorShare.app をダブルクリック →「開けません」「Apple は検証できません」と出たら「完了」で閉じる
2. 「システム設定」→「プライバシーとセキュリティ」を開き、下の方の
   「"CursorShare" は…ブロックされました」の横の「このまま開く」を押す（パスワードを入力）
3. もう一度 CursorShare.app を開く →「開く」
   ※ うまくいかない時は、ターミナルで次を実行してから開いてください：
     xattr -dr com.apple.quarantine /Applications/CursorShare.app

■ 許可（最初の1回だけ）
- 画面収録：「画面共有を開始」を押すと許可を求められます。
  「システム設定」→「プライバシーとセキュリティ」→「画面収録とシステムオーディオ録音」で
  CursorShare をオンにし、アプリを再起動してください（画面の選択画面にもボタンがあります）
- システムオーディオ録音（PCの音を共有する時）：初めて「PCの音声」を使う時に許可を求められます
- マイク（オーディオインターフェースなどの入力を共有する時）：初めて使う時に許可を求められます
- ファイアウォールの確認が出たら「許可」（LANで参加者を受け付けるのに必要です）

■ Mac で違うところ
- 「PCの音声」（Macで再生している音）の共有は macOS 13 以降で使えます（14.2 以降を推奨）。
  古い macOS では、BlackHole などの仮想オーディオ機器を「入力」として選ぶと共有できます
- インターネット公開用の cloudflared はアプリに同梱済みです（別途インストール不要）
- 終了は ⌘Q。チャットでは ⌘C / ⌘V でコピー・貼り付けできます
- デスクトップ表示（参加者のカーソル等）は、全画面表示のアプリの上にも出ます

■ 参加する人
Mac・Windows どちらでも、受け取ったURLを Chrome か Edge で開くだけです（Safari は非推奨）。

■ 同梱ソフトウェア
Electron / Chromium（LICENSE, LICENSES.chromium.html）、cloudflared（Cloudflare, Inc. / Apache License 2.0）、
ws（MIT）。cloudflared と ws のライセンス全文は licenses フォルダにあります。
