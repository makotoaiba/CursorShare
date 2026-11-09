import {
  CursorLayer, contentRect, renderPeople, waitIceGathering, wsUrl,
  REACTIONS, appendChat, bindChatInput, startMeter,
} from '/common.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const stage = $('#stage');
const layer = new CursorLayer($('#layer'), video);
const people = new Map();
const chatList = $('#chatList');

let ws = null;
let me = null;
let pc = null;
let myName = '';
let chain = Promise.resolve();
let lastPos = null; // 映像上の自分の最後のカーソル位置
let unread = 0;
let iceServers = [];
let fatal = false;
const accessKey = new URLSearchParams(location.search).get('k') || '';

// ---------- 参加 ----------
const nameInput = $('#name');
try { nameInput.value = localStorage.getItem('cursorshare.name') || ''; } catch {}
nameInput.focus();
$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  myName = nameInput.value.trim();
  if (!myName) return;
  try { localStorage.setItem('cursorshare.name', myName); } catch {}
  $('#join').hidden = true;
  wantAudio = true; // 「参加する」のクリックで自動再生の許可が得られるので、最初から音声オン
  connect();
});

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'viewer', name: myName, key: accessKey }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    chain = chain.then(() => handle(m)).catch(console.error);
  };
  ws.onclose = () => {
    me = null;
    closePc();
    layer.clear();
    people.clear();
    refreshPeople();
    if (fatal) return;
    setStatus('接続が切れました。再接続しています…');
    setTimeout(connect, 2000);
  };
}

function send(m) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
}
function setStatus(t) { $('#status').textContent = t; }
function refreshPeople() { renderPeople($('#people'), people); }

async function handle(m) {
  switch (m.type) {
    case 'welcome':
      me = { id: m.id, name: m.name, color: m.color };
      iceServers = m.iceServers || [];
      people.clear();
      people.set(m.id, { name: `${m.name}（自分）`, color: m.color });
      layer.setPerson(m.id, `${m.name}（自分）`, m.color);
      for (const p of m.peers) {
        people.set(p.id, p);
        layer.setPerson(p.id, p.name, p.color);
      }
      refreshPeople();
      hostState(m.host);
      break;
    case 'join':
      people.set(m.id, m);
      layer.setPerson(m.id, m.name, m.color);
      refreshPeople();
      break;
    case 'leave':
      people.delete(m.id);
      layer.removePerson(m.id);
      refreshPeople();
      break;
    case 'host': hostState(m); break;
    case 'cursor': layer.move(m.id, m.x, m.y); break;
    case 'click': if (m.id !== (me && me.id)) layer.click(m.id, m.x, m.y); break;
    case 'hide': layer.hide(m.id); break;
    case 'react': layer.react(m.id, m.emoji, m.x, m.y); break;
    case 'chat':
      appendChat(chatList, m, me && me.id);
      if (!me || m.id !== me.id) {
        layer.say(m.id, m.text);
        if (!chatOpen()) setUnread(unread + 1);
      }
      break;
    case 'signal': await onSignal(m.from, m.data); break;
    case 'error':
      if (m.fatal) fatal = true;
      setStatus(m.message);
      break;
  }
}

function hostState(h) {
  if (!h.online) setStatus('ホストが未接続です');
  else if (!h.sharing) setStatus('画面共有の開始を待っています');
  else setStatus('共有中');
  if (!h.online || !h.sharing) {
    closePc();
    layer.clear();
  }
  $('#empty').hidden = !!(h.online && h.sharing);
  $('#reactions').hidden = !(h.online && h.sharing);
  $('#reactions').hidden = !(h.online && h.sharing);
}

// ---------- 映像の受信 ----------
async function onSignal(from, data) {
  if (!data || !data.sdp || data.sdp.type !== 'offer') return;
  closePc();
  const conn = new RTCPeerConnection({ iceServers });
  pc = conn;
  conn.ontrack = (ev) => {
    if (video.srcObject !== ev.streams[0]) video.srcObject = ev.streams[0];
    if (ev.track.kind === 'audio') {
      applyAudio();
      stopRx();
      stopRx = startMeter(ev.streams[0], $('#rxMeter'));
    }
  };
  conn.onconnectionstatechange = () => {
    if (conn.connectionState === 'failed') setStatus('映像を受信できません。回線の相性の可能性があります（READMEのTURN設定を参照）');
  };
  await conn.setRemoteDescription(data.sdp);
  const answer = await conn.createAnswer();
  // Opusをステレオ・高ビットレートで受け取る
  answer.sdp = answer.sdp.replace(/(a=fmtp:\d+ .*useinbandfec=1)/g, '$1;stereo=1;sprop-stereo=1;maxaveragebitrate=160000');
  await conn.setLocalDescription(answer);
  await waitIceGathering(conn);
  send({ type: 'signal', to: from, data: { sdp: conn.localDescription } });
}

let stopRx = () => {};
function closePc() {
  stopRx();
  stopRx = () => {};
  if (pc) pc.close();
  pc = null;
  video.srcObject = null;
}

// ---------- 自分のカーソルを送る ----------
let pending = null;
let raf = 0;
let outside = true;

function queue(m) {
  pending = m;
  if (!raf) raf = requestAnimationFrame(() => {
    raf = 0;
    if (pending) send(pending);
    pending = null;
  });
}
function norm(e) {
  const b = video.getBoundingClientRect();
  const r = contentRect(video);
  const x = (e.clientX - b.left - r.x) / r.w;
  const y = (e.clientY - b.top - r.y) / r.h;
  return { x, y, inside: video.videoWidth > 0 && x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}
function leave() {
  stage.classList.remove('own-cursor');
  if (outside) return;
  outside = true;
  pending = null;
  if (me) layer.hide(me.id);
  send({ type: 'hide' });
}

const onDock = (e) => !!e.target.closest('.react-dock');
stage.addEventListener('pointermove', (e) => {
  if (!me) return;
  if (onDock(e)) return leave();
  if (e.target.closest('.dock')) return leave(); // リアクションバーの上では送らない
  const p = norm(e);
  if (p.inside) {
    outside = false;
    lastPos = { x: p.x, y: p.y };
    // 自分のカーソルは手元で即描画（他の人にどう見えているかを確認できる）
    stage.classList.add('own-cursor');
    layer.move(me.id, p.x, p.y);
    queue({ type: 'cursor', x: p.x, y: p.y });
  } else leave();
});
stage.addEventListener('pointerleave', leave);
stage.addEventListener('pointerdown', (e) => {
  if (!me || e.target.closest('.dock')) return;
  const p = norm(e);
  if (!p.inside) return;
  layer.click(me.id, p.x, p.y);
  send({ type: 'click', x: p.x, y: p.y });
});

// ---------- リアクション ----------
function sendReaction(emoji) {
  if (!me || !video.videoWidth) return;
  const pos = lastPos || { x: 0.5, y: 0.5 };
  send({ type: 'react', emoji, x: pos.x, y: pos.y });
}
const reactBox = $('#reactions');
REACTIONS.forEach((emoji, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<span class="dock-emoji"></span><kbd>${i + 1}</kbd>`;
  b.querySelector('.dock-emoji').textContent = emoji;
  b.title = `キー ${i + 1}`;
  b.dataset.key = i + 1;
  b.setAttribute('aria-label', `${emoji} リアクション（キー${i + 1}）`);
  b.addEventListener('click', () => sendReaction(emoji));
  reactBox.appendChild(b);
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= REACTIONS.length) sendReaction(REACTIONS[n - 1]);
});

// ---------- チャット ----------
bindChatInput($('#chatForm'), $('#chatInput'), (text) => send({ type: 'chat', text }));
const chatOpen = () => !$('#main').classList.contains('chat-closed');
function setUnread(n) {
  unread = n;
  $('#unread').hidden = n === 0;
  $('#unread').textContent = n;
}
$('#chatBtn').addEventListener('click', () => {
  const closed = $('#main').classList.toggle('chat-closed');
  $('#chatBtn').setAttribute('aria-pressed', String(!closed));
  if (!closed) {
    setUnread(0);
    chatList.scrollTop = chatList.scrollHeight;
  }
});

// ---------- 全画面（映像＋チャット） ----------
$('#fsBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#main').requestFullscreen().catch(() => {});
});

// ---------- 音声 ----------
let wantAudio = false;
const muteBtn = $('#muteBtn');
const vol = $('#vol');
try { vol.value = localStorage.getItem('cursorshare.volume') ?? vol.value; } catch {}
video.volume = Number(vol.value);

function updateMuteBtn() {
  const on = !video.muted;
  muteBtn.textContent = on ? '🔊 音声オン' : '🔇 音声オフ';
  muteBtn.setAttribute('aria-pressed', String(on));
}
function applyAudio() {
  video.muted = !wantAudio;
  video.play().catch(() => {
    // 自動再生がブロックされた場合はミュートで映像だけ流し、ボタンで再開してもらう
    video.muted = true;
    wantAudio = false;
    video.play().catch(() => {});
    updateMuteBtn();
  });
  updateMuteBtn();
}
function toggleAudio() {
  wantAudio = video.muted;
  applyAudio();
}
muteBtn.addEventListener('click', toggleAudio);
vol.addEventListener('input', () => {
  video.volume = Number(vol.value);
  try { localStorage.setItem('cursorshare.volume', vol.value); } catch {}
  if (video.muted && Number(vol.value) > 0) { wantAudio = true; applyAudio(); }
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'm' || e.key === 'M') toggleAudio();
});
updateMuteBtn();
