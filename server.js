'use strict';
// CursorShare — 画面共有 + 参加者カーソル表示サーバー
// ・映像は WebRTC で ホスト→各参加者 に直接送る（このサーバーは接続の仲介だけ）
// ・参加者の声も WebRTC で 参加者→ホスト に届き、ホストが他の参加者へ配る
// ・カーソル座標やチャットは WebSocket でこのサーバーが中継する
// ・参加者の入力をホストPCに流し込む処理は一切ない（操作は奪われない）

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

// exe化した時は exe の置き場所、通常は server.js の場所
const BASE_DIR = process.env.CURSORSHARE_BASE || (process.pkg ? path.dirname(process.execPath) : __dirname);
const VERSION = require('./package.json').version;
const RUN_DIRECT = require.main === module;

// ---------- 設定（config.json があれば上書き） ----------
const CONFIG = (() => {
  const def = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    accessKey: '', // 空なら起動ごとにランダム生成
    videoMaxBitrate: 6000000, // 参加者1人あたり。ホストの上り回線 ÷ 人数 を目安に
    port: 8787,
    openBrowser: true,
  };
  try {
    return { ...def, ...JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'config.json'), 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('config.json を読み込めません：', e.message);
    return def;
  }
})();
const ACCESS_KEY = String(CONFIG.accessKey || crypto.randomBytes(9).toString('base64url'));
let tunnelUrl = null;

let PORT = Number(process.env.PORT) || Number(CONFIG.port) || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
// 白文字の名前ラベルが読める濃さの色だけ
const COLORS = ['#e5484d', '#0b84e3', '#d97f00', '#2f9e44', '#8e4ec6', '#d6409f', '#0d9488', '#c2410c'];

// LAN用アドレス：仮想アダプタ（WSL・Hyper-V・VirtualBox等）を後ろに回し、一番それらしいものを先頭に
const VIRTUAL_IF = /vEthernet|Hyper-V|WSL|VirtualBox|vbox|VMware|VMnet|Docker|Loopback|Bluetooth|ZeroTier|Npcap/i;
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      let score = o1 === 192 && o2 === 168 ? 30 : o1 === 10 ? 20 : o1 === 172 && o2 >= 16 && o2 <= 31 ? 15 : 5;
      if (VIRTUAL_IF.test(name)) score -= 100;
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
function lanUrls() {
  return lanAddresses().map((a) => `http://${a.address}:${PORT}/`);
}

function isLocal(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
// トンネル経由のアクセスも接続元は localhost になるので、転送ヘッダーがあれば外部扱い
function isLocalReq(req) {
  return isLocal(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];
}
// ホストと同じPCのブラウザから参加しているか（一人で動作確認する時）。
// 同じPCだと、ブラウザが鳴らした共有音をホストがまた拾って音が回り続けるので、参加者画面に知らせる
function isSameMachine(req) {
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) return false;
  if (isLocal(req.socket.remoteAddress)) return true;
  const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return Object.values(os.networkInterfaces()).some((addrs) => (addrs || []).some((a) => a.address === addr));
}
function joinUrls() {
  return {
    internet: tunnelUrl ? `${tunnelUrl}/?k=${ACCESS_KEY}` : null,
    lan: lanAddresses().map((a) => ({ name: a.name, url: `http://${a.address}:${PORT}/?k=${ACCESS_KEY}` })),
  };
}

// ---------- 静的ファイル ----------
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  // 参加者画面が「ホストと同じPCで開かれているか」を確かめるための問い合わせ
  if (pathname === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ sameMachine: isSameMachine(req) }));
  }
  if (pathname === '/') pathname = '/view.html';
  if (pathname === '/host') pathname = '/host.html';
  if (pathname === '/overlay') pathname = '/overlay.html';

  if ((pathname === '/host.html' || pathname === '/overlay.html') && !isLocalReq(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ホスト画面はこのサーバーを起動したPCからのみ開けます');
  }

  const file = path.join(PUBLIC_DIR, pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', () => {}); // listen エラーは server 側で処理する
const clients = new Map(); // id -> { id, ws, role, name, color }
let hostId = null;
let sharing = false;
let guardOn = false; // ホストがハウリング防止（発言中は共有音を止める）を使っている
let seq = 0;

function send(c, msg) {
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}
function broadcast(msg, exceptId) {
  for (const c of clients.values()) if (c.id !== exceptId) send(c, msg);
}
function viewerList() {
  return [...clients.values()]
    .filter((c) => c.role === 'viewer')
    .map(({ id, name, color, mic, speaking }) => ({ id, name, color, mic, speaking }));
}
function pickColor() {
  const used = new Set(viewerList().map((v) => v.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[seq % COLORS.length];
}
function cleanName(s) {
  s = String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
  return s || 'ゲスト';
}
const REACTIONS = ['👍', '👀', '😂', '❤️', '❓', '🎉'];
const MIC_STATES = ['off', 'on', 'muted', 'na'];
const HOST_COLOR = '#5c6672';
function cleanText(s) {
  return String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim().slice(0, 300);
}
function clamp01(n) {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

wss.on('connection', (ws, req) => {
  const id = String(++seq);
  const local = isLocalReq(req);
  let me = null;

  const reject = (message) => {
    ws.send(JSON.stringify({ type: 'error', fatal: true, message }));
    ws.close();
  };

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (!me) {
      if (m.type !== 'hello') return;
      if (m.role === 'overlay') {
        // デスクトップ表示用（このPCのアプリ内からのみ）。受信専用
        if (!local) return reject('このPCからのみ接続できます');
        me = { id, ws, role: 'overlay', name: '', color: null };
        clients.set(id, me);
        send(me, { type: 'welcome', id, viewers: viewerList() });
        return;
      }
      if (m.role === 'host') {
        if (!local) return reject('ホストはサーバーを起動したPCからのみ接続できます');
        if (hostId) return reject('ホスト画面はすでに別のタブで開かれています');
        me = { id, ws, role: 'host', name: 'ホスト', color: null };
        clients.set(id, me);
        hostId = id;
        sharing = false;
        guardOn = false;
        send(me, {
          type: 'welcome',
          id,
          viewers: viewerList(),
          urls: joinUrls(),
          iceServers: CONFIG.iceServers,
          videoMaxBitrate: CONFIG.videoMaxBitrate,
          tunnel: tunnelState,
          version: VERSION,
        });
        broadcast({ type: 'host', online: true, sharing: false, guard: false }, id);
      } else {
        if (String(m.key || '') !== ACCESS_KEY) return reject('参加用URLが正しくありません。ホストから届いたURLをそのまま開いてください');
        // mic: off=未使用 / on=発言できる / muted=ミュート中 / na=このURLでは使えない（http）
        me = { id, ws, role: 'viewer', name: cleanName(m.name), color: pickColor(), mic: 'off', speaking: false };
        clients.set(id, me);
        send(me, {
          type: 'welcome',
          id,
          name: me.name,
          color: me.color,
          peers: viewerList().filter((v) => v.id !== id),
          host: { online: !!hostId, sharing, guard: guardOn },
          iceServers: CONFIG.iceServers,
          sameMachine: isSameMachine(req),
        });
        broadcast({ type: 'join', id, name: me.name, color: me.color, mic: me.mic, speaking: false }, id);
      }
      return;
    }

    if (me.role === 'overlay') return;
    switch (m.type) {
      case 'signal': {
        // ホスト⇔参加者の間だけ中継
        const target = clients.get(String(m.to));
        if (!target || target.role === me.role) return;
        send(target, { type: 'signal', from: id, data: m.data });
        break;
      }
      case 'cursor':
      case 'click': {
        if (me.role !== 'viewer') return;
        const x = clamp01(m.x);
        const y = clamp01(m.y);
        if (x === null || y === null) return;
        broadcast({ type: m.type, id, x, y }, id);
        break;
      }
      case 'hide':
        if (me.role === 'viewer') broadcast({ type: 'hide', id }, id);
        break;
      case 'stroke': {
        // 右ドラッグで描いた線（数秒で消える）。点は少しずつまとめて届く
        if (me.role !== 'viewer') return;
        const sid = Number(m.sid);
        if (!Number.isInteger(sid) || sid < 0 || sid > 1e9) return;
        const pts = (Array.isArray(m.pts) ? m.pts : []).slice(0, 64)
          .map((pt) => [clamp01(pt && pt[0]), clamp01(pt && pt[1])])
          .filter(([x, y]) => x !== null && y !== null)
          .map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
        if (!pts.length && !m.end) return;
        broadcast({ type: 'stroke', id, sid, pts, end: !!m.end }, id);
        break;
      }
      case 'react': {
        if (me.role !== 'viewer' || !REACTIONS.includes(m.emoji)) return;
        const x = clamp01(m.x);
        const y = clamp01(m.y);
        if (x === null || y === null) return;
        broadcast({ type: 'react', id, emoji: m.emoji, x, y }); // 送信者にも返す
        break;
      }
      case 'chat': {
        const text = cleanText(m.text);
        if (!text) return;
        broadcast({ type: 'chat', id, name: me.name, color: me.color || HOST_COLOR, text, time: Date.now() });
        break;
      }
      case 'voice': {
        // 参加者のマイク状態（音声そのものは WebRTC でホストへ直接届く。ここは表示用の状態だけ）
        if (me.role !== 'viewer') return;
        if (MIC_STATES.includes(m.mic)) me.mic = m.mic;
        me.speaking = me.mic === 'on' && !!m.speaking;
        broadcast({ type: 'voice', id, mic: me.mic, speaking: me.speaking }, id);
        break;
      }
      case 'mute': {
        // ホストが参加者のマイクをミュートさせる（本人はいつでも解除できる）
        if (me.role !== 'host') return;
        for (const c of clients.values()) {
          if (c.role === 'viewer' && (m.all || c.id === String(m.id))) send(c, { type: 'mute' });
        }
        break;
      }
      case 'tunnel':
        if (me.role !== 'host') return;
        if (m.on) startTunnel();
        else stopTunnel();
        break;
      case 'share':
        if (me.role !== 'host') return;
        sharing = !!m.sharing;
        if (!sharing) guardOn = false;
        broadcast({ type: 'host', online: true, sharing, guard: guardOn }, id);
        break;
      case 'guard':
        if (me.role !== 'host') return;
        guardOn = sharing && !!m.on;
        broadcast({ type: 'host', online: true, sharing, guard: guardOn }, id);
        break;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    clients.delete(id);
    if (me.role === 'host') {
      hostId = null;
      sharing = false;
      guardOn = false;
      broadcast({ type: 'host', online: false, sharing: false, guard: false });
    } else if (me.role === 'viewer') {
      broadcast({ type: 'leave', id });
    }
  });
});

// ---------- インターネット公開（Cloudflare クイックトンネル） ----------
let tunnelChild = null;
let tunnelState = { state: 'off', message: '' }; // off | starting | on | error

function setTunnel(state, message = '') {
  tunnelState = { state, message };
  send(clients.get(hostId), { type: 'tunnel', ...tunnelState, urls: joinUrls() });
}

function cloudflaredPath() {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const bundled = path.join(BASE_DIR, name);
  return fs.existsSync(bundled) ? bundled : 'cloudflared'; // 無ければPATHから
}

function startTunnel() {
  if (tunnelChild) return;
  console.log('インターネット用URLを発行しています…');
  setTunnel('starting');
  let child;
  try {
    child = spawn(cloudflaredPath(), ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  } catch {
    return setTunnel('error', 'cloudflared を起動できません');
  }
  tunnelChild = child;
  const giveUp = setTimeout(() => {
    if (!tunnelUrl && tunnelChild === child) {
      stopTunnel();
      setTunnel('error', 'URLを発行できませんでした。ネットワークを確認して再試行してください');
    }
  }, 30000);
  const onData = (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !tunnelUrl) {
      clearTimeout(giveUp);
      tunnelUrl = m[0];
      console.log(`  インターネット用URL: ${joinUrls().internet}`);
      setTunnel('on');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', () => {
    clearTimeout(giveUp);
    if (tunnelChild === child) tunnelChild = null;
    setTunnel('error', 'cloudflared.exe が見つかりません。このアプリと同じフォルダに置いてください');
  });
  child.on('exit', () => {
    clearTimeout(giveUp);
    if (tunnelChild !== child) return;
    tunnelChild = null;
    const wasOn = !!tunnelUrl;
    tunnelUrl = null;
    if (wasOn) console.log('インターネット公開を終了しました');
    if (tunnelState.state !== 'error') setTunnel(wasOn ? 'off' : 'error', wasOn ? '' : 'cloudflared が終了しました');
  });
}

function stopTunnel() {
  const child = tunnelChild;
  tunnelChild = null;
  tunnelUrl = null;
  if (child) { try { child.kill(); } catch {} }
  setTunnel('off');
}

process.on('exit', () => { if (tunnelChild) try { tunnelChild.kill(); } catch {} });
if (RUN_DIRECT) for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit());

function openBrowser(url) {
  if (!CONFIG.openBrowser || process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

// 使用中のポートなら次の番号を試す
let portTries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && portTries < 20) {
    portTries++;
    PORT++;
    return server.listen(PORT, '0.0.0.0');
  }
  console.error('起動できませんでした：', e.message);
  setTimeout(() => process.exit(1), 10000);
});

function printBanner() {
  console.log(`CursorShare ${VERSION} 起動しました`);
  console.log(`  ホスト画面（このPC）: http://localhost:${PORT}/host`);
  joinUrls().lan.forEach((u, i) => console.log(`  LAN用URL${i ? '（予備）' : '        '}    : ${u.url}  [${u.name}]`));
}

// アプリ（Electron）から使う時の入口
function start() {
  return new Promise((resolve) => {
    server.once('listening', () => {
      printBanner();
      resolve(PORT);
    });
    server.listen(PORT, '0.0.0.0');
  });
}

module.exports = { start, stopTunnel, VERSION };

// node server.js で直接起動した時（ブラウザ版）
if (RUN_DIRECT) {
  start().then((port) => {
    console.log('');
    console.log('このウィンドウを閉じると終了します');
    openBrowser(`http://localhost:${port}/host`);
    if (process.argv.includes('--tunnel')) startTunnel();
  });
}
