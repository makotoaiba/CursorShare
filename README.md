# CursorShare

自分のPC画面（と音声）を共有しながら、参加者のマウスカーソルを **色付き・名前付き** で表示するWindowsアプリです。
参加者のカーソルはホストのデスクトップにも重ねて表示されるので、「ここ」「このセリフ」と指し示しながら打ち合わせできます。
参加者の操作がホストのPCに送られることはありません（見るだけ・指し示すだけ）。

## ダウンロード

[Releases](../../releases/latest) から `CursorShare-x.x.x-win.zip` をダウンロードして解凍し、`CursorShare.exe` を起動してください。
参加する人はインストール不要で、ホストから届いたURLを Chrome / Edge で開くだけです。

> 初回起動で「Windows によって PC が保護されました」と出たら「詳細情報」→「実行」。
> ファイアウォールの許可を聞かれたら「プライベート ネットワーク」を許可してください。

## できること

- 参加者ごとに色分けされたカーソル（名前ラベル付き）を、共有映像とホストのデスクトップに表示
- デスクトップ表示はクリックを素通りし、共有映像にも映らない
- クリック位置に波紋、リアクション（キー 1〜6）、チャット（カーソル横の吹き出し・デスクトップ右下の通知）
- 音声の共有。共有したい音を鳴らすと、拾えている音源を自動で選択
- 同じLAN内はもちろん、Cloudflare のクイックトンネルで離れた人とも共有（ボタン1つ、ポート開放不要）
- 参加URLには合言葉が付き、起動ごとに変わる

## 使い方

1. `CursorShare.exe` を起動
2. 「画面共有を開始」→ 共有する画面を選ぶ（同時に、共有したい音を鳴らすと音声も自動で選ばれます）
3. 「LAN用URLをコピー」または「インターネット公開」→「インターネット用URLをコピー」で参加者に送る

詳しくは配布 zip 内の `README.txt` を参照してください。

## 設定（config.json）

| 項目 | 内容 |
|---|---|
| `port` | 使うポート番号（使用中なら自動で次の番号） |
| `accessKey` | 参加URLの合言葉。空なら起動ごとにランダム |
| `videoMaxBitrate` | 参加者1人あたりの映像ビットレート上限（bps） |
| `iceServers` | STUN / TURN サーバー。離れた人の映像が届かない時は TURN を追加 |

## 仕組み

- 映像・音声：WebRTC でホストから各参加者へ直接送信
- カーソル・チャット：内蔵サーバー（Node.js + WebSocket）が中継
- アプリ本体：Electron。デスクトップ表示は透明・クリック透過・キャプチャ除外のウィンドウ

## 開発

```bash
npm install
npm run app      # アプリ版を起動
npm start        # ブラウザ版（ホスト画面を http://localhost:8787/host で開く）
```

インターネット公開を試すには、`cloudflared.exe` をプロジェクト直下に置いてください。

## リリース手順

1. `package.json` の `version` を上げてコミット
2. 同じバージョンのタグを付けて push（例：`git tag v1.2.0 && git push origin v1.2.0`）
3. GitHub Actions が Windows 版をビルドし、Releases に zip を公開します

## ライセンス

MIT License。同梱ソフトウェア：Electron / Chromium、[cloudflared](https://github.com/cloudflare/cloudflared)（Apache License 2.0）、[ws](https://github.com/websockets/ws)（MIT）。
