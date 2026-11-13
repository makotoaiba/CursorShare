import {
  CursorLayer, contentRect, renderPeople, waitIceGathering, wsUrl,
  REACTIONS, appendChat, bindChatInput, startMeter, micIcon,
} from '/common.js';
import { ViewerVoice } from '/view-voice.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const stage = $('#stage');
const layer = new CursorLayer($('#layer'), video);
const people = new Map(); // id -> { name, color, mic, speaking }
const chatList = $('#chatList');

let ws = null;
let me = null;
let pc = null;
let shareStream = null; // 共有映像＋共有音
let hostInfo = { online: false, sharing: false, guard: false };
let toldGuard = false;
let myName = '';
let chain = Promise.resolve();
let lastPos = null; // 映像上の自分の最後のカーソル位置
let unread = 0;
let iceServers = [];
let fatal = false;
let sameMachine = false; // ホストと同じPCで開いている（一人での動作確認）
const accessKey = new URLSearchParams(location.search).get('k') || '';

// ホストと同じPCでLAN用URL（http）を開いた時は、localhost のURLへ移る。
// http のままだとブラウザの制限でマイクを使えないが、localhost なら使える（一人での動作確認用）
if (!window.isSecureContext) {
  fetch('/whoami').then((r) => r.json()).then((j) => {
    if (j && j.sameMachine) location.replace(`http://localhost${location.port ? `:${location.port}` : ''}/${location.search}`);
  }).catch(() => {});
}

// ---------- お知らせ（数秒で消える） ----------
let noticeTimer = 0;
function notice(text) {
  const el = $('#notice');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 7000);
}

// ---------- ボイス ----------
const voice = new ViewerVoice({
  audioEl: $('#voiceAudio'),
  onState: () => {
    renderMic();
    reportVoice();
  },
  onLevel: (lv) => { $('#micMeter i').style.width = `${Math.round(lv * 100)}%`; },
  onNotice: notice,
});

// 自分のマイクの状態を全員に知らせる（声そのものはホストへ直接送られる）
function reportVoice() {
  if (!me) return;
  const p = people.get(me.id);
  if (p) {
    p.mic = voice.mic;
    p.speaking = voice.speaking;
    refreshPeople();
  }
  layer.setSpeaking(me.id, voice.speaking);
  send({ type: 'voice', mic: voice.mic, speaking: voice.speaking });
}

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

function setPerson(p, label) {
  people.set(p.id, { name: label || p.name, color: p.color, mic: p.mic || 'off', speaking: !!p.speaking });
  layer.setPerson(p.id, label || p.name, p.color);
  layer.setSpeaking(p.id, !!p.speaking);
}

async function handle(m) {
  switch (m.type) {
    case 'welcome':
      me = { id: m.id, name: m.name, color: m.color };
      iceServers = m.iceServers || [];
      people.clear();
      setPerson({ id: m.id, color: m.color, mic: voice.mic, speaking: voice.speaking }, `${m.name}（自分）`);
      for (const p of m.peers) setPerson(p);
      refreshPeople();
      if (m.sameMachine && !sameMachine) {
        // このPCで鳴らした共有音をホストがまた拾い、音が回り続けてしまうので、最初はオフにしておく
        wantAudio = false;
        notice('ホストと同じPCで開いています。音が回り続ける（ハウリングする）のを防ぐため、共有音はオフにしてあります。');
      }
      sameMachine = !!m.sameMachine;
      hostState(m.host);
      applyAudio();
      reportVoice(); // つなぎ直した時も、今のマイクの状態を伝える
      break;
    case 'join':
      setPerson(m);
      refreshPeople();
      break;
    case 'leave':
      people.delete(m.id);
      layer.removePerson(m.id);
      refreshPeople();
      break;
    case 'voice': {
      const p = people.get(m.id);
      if (!p) break;
      p.mic = m.mic;
      p.speaking = !!m.speaking;
      layer.setSpeaking(m.id, p.speaking);
      refreshPeople();
      break;
    }
    case 'mute':
      if (voice.mute()) notice('ホストがあなたのマイクをミュートしました。話す時はマイクのボタンで解除できます。');
      break;
    case 'host': hostState(m); break;
    case 'cursor': layer.move(m.id, m.x, m.y); break;
    case 'click': if (m.id !== (me && me.id)) layer.click(m.id, m.x, m.y); break;
    case 'hide': layer.hide(m.id); break;
    case 'stroke': layer.stroke(m.id, m.sid, m.pts, m.end); break;
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
  hostInfo = { online: !!h.online, sharing: !!h.sharing, guard: !!h.guard };
  const live = hostInfo.online && hostInfo.sharing;
  // ホスト側でハウリング防止が働いている時は、発言中に共有音が止まることを知らせておく
  const guarded = live && hostInfo.guard;
  $('#rxMeter').classList.toggle('guarded', guarded);
  $('#rxMeter').title = guarded ? 'ハウリング防止のため、だれかが話している間は共有音が止まります' : '受信中の共有音のレベル';
  if (guarded && !toldGuard) {
    toldGuard = true;
    notice('ホストの環境では、ハウリングを防ぐため、だれかが話している間は共有音が止まります。話さない時はマイクをミュートにしておくと、音が途切れにくくなります。');
  }
  if (!hostInfo.online) setStatus('ホストが未接続です');
  else if (!hostInfo.sharing) setStatus('画面共有の開始を待っています');
  else setStatus('共有中');
  if (!hostInfo.online) closePc(); // ホストがいなければ接続も声もない
  if (!live) layer.clear();
  showShare();
  $('#empty').hidden = live;
  $('#reactions').hidden = !live;
}

// 共有中だけ映像を出す（共有していない間は、止まった最後の画面を見せない）
function showShare() {
  const want = hostInfo.online && hostInfo.sharing ? shareStream : null;
  if (video.srcObject === want) return;
  video.srcObject = want;
  if (want) applyAudio();
}

// ---------- ホストとの接続（映像・共有音の受信 ＋ ボイスの送受信） ----------
// 参加している間は、画面共有の有無にかかわらずつながったままにする（共有の前後でも声で話せる）
async function onSignal(from, data) {
  if (!data || !data.sdp || data.sdp.type !== 'offer') return;
  closePc();
  const mids = data.mids || {};
  const conn = new RTCPeerConnection({ iceServers });
  pc = conn;
  const stream = new MediaStream();
  shareStream = stream;
  conn.ontrack = (ev) => {
    if (pc !== conn) return;
    if (mids.voice != null && ev.transceiver.mid === mids.voice) {
      voice.setRemote(ev.track); // 他の参加者の声
      return;
    }
    stream.addTrack(ev.track);
    if (ev.track.kind === 'audio') {
      stopRx();
      stopRx = startMeter(new MediaStream([ev.track]), $('#rxMeter'));
    }
  };
  let retry = 0;
  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    if (conn.connectionState === 'connected') hostState(hostInfo); // 状態表示を戻す
    if (conn.connectionState !== 'failed') return;
    setStatus('ホストと接続できません。回線の相性の可能性があります（READMEのTURN設定を参照）');
    clearTimeout(retry);
    retry = setTimeout(() => { if (pc === conn) send({ type: 'signal', to: from, data: { renegotiate: true } }); }, 3000);
  };
  await conn.setRemoteDescription(data.sdp);
  // ボイス用の口：受け取るだけでなく、自分のマイクも送れるようにしておく
  const vt = conn.getTransceivers().find((t) => mids.voice != null && t.mid === mids.voice);
  if (vt) {
    vt.direction = 'sendrecv';
    await voice.setSender(vt.sender);
  }
  const answer = await conn.createAnswer();
  answer.sdp = stereoFor(answer.sdp);
  await conn.setLocalDescription(answer);
  await waitIceGathering(conn);
  if (pc !== conn) return;
  // n：どの接続への返事かをホストが見分ける番号（古い接続への返事が紛れ込まないように）
  send({ type: 'signal', to: from, data: { sdp: conn.localDescription, n: data.n } });
  showShare();
}

// 共有音（音楽・SE）を、Opusのステレオ・高ビットレートで受け取れるようにする。
// 1本の接続の中では、同じコーデックの設定を音声の通り道ごとに変えられない決まりなので、
// 共有音・ボイスの両方に同じ指定を付ける（ボイス側のビットレートは、ホストが送る時に低く抑える）
function stereoFor(sdp) {
  return sdp.replace(/(a=fmtp:\d+ .*useinbandfec=1)/g, '$1;stereo=1;sprop-stereo=1;maxaveragebitrate=160000');
}

let stopRx = () => {};
function closePc() {
  stopRx();
  stopRx = () => {};
  if (pc) pc.close();
  pc = null;
  shareStream = null;
  video.srcObject = null;
  voice.setSender(null);
  voice.setRemote(null);
}

// ---------- 自分のカーソルを送る ----------
let pending = null;
let raf = 0;
let outside = true;

// カーソル位置は約30回/秒にまとめて送る（画面の描画とは切り離して、裏に隠れても止まらないようにする）
function queue(m) {
  pending = m;
  if (!raf) raf = setTimeout(() => {
    raf = 0;
    if (pending) send(pending);
    pending = null;
  }, 33);
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

// ---------- 右ドラッグで線を描く（数秒で消える） ----------
let drawing = null; // { sid, pending, last, timer, pointerId }
let strokeSeq = Math.floor(Math.random() * 1000);

function sendStroke(end) {
  if (!drawing) return;
  clearTimeout(drawing.timer);
  drawing.timer = 0;
  const pts = drawing.pending.splice(0);
  if (pts.length || end) send({ type: 'stroke', sid: drawing.sid, pts, end: !!end });
}
function addInk(p) {
  const x = Math.round(Math.min(1, Math.max(0, p.x)) * 1e4) / 1e4;
  const y = Math.round(Math.min(1, Math.max(0, p.y)) * 1e4) / 1e4;
  const l = drawing.last;
  if (l && Math.hypot(x - l[0], y - l[1]) < 0.002) return; // ほとんど動いていない点は省く
  drawing.last = [x, y];
  drawing.pending.push([x, y]);
  layer.stroke(me.id, drawing.sid, [[x, y]], false); // 自分の画面にはすぐ描く
  if (drawing.pending.length >= 32) sendStroke(false);
  else if (!drawing.timer) drawing.timer = setTimeout(() => sendStroke(false), 40); // 少しずつまとめて送る
}
function endInk(e) {
  if (!drawing) return;
  if (e && e.clientX != null) addInk(norm(e));
  sendStroke(true);
  layer.stroke(me.id, drawing.sid, [], true);
  try { stage.releasePointerCapture(drawing.pointerId); } catch {}
  drawing = null;
}
stage.addEventListener('contextmenu', (e) => e.preventDefault()); // 映像の上では右クリックメニューを出さない
window.addEventListener('blur', () => endInk());

stage.addEventListener('pointermove', (e) => {
  if (!me) return;
  if (drawing) {
    if (!(e.buttons & 2)) endInk(e); // 右ボタンを離したのを取りこぼした
    else addInk(norm(e));
  }
  if (onDock(e)) return leave(); // リアクションバーの上では送らない
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
  if (!me || onDock(e)) return;
  const p = norm(e);
  if (!p.inside) return;
  if (e.button === 2) {
    // 右ボタン：線を描き始める
    e.preventDefault();
    endInk();
    strokeSeq = (strokeSeq + 1) % 1e9;
    drawing = { sid: strokeSeq, pending: [], last: null, timer: 0, pointerId: e.pointerId };
    try { stage.setPointerCapture(e.pointerId); } catch {} // 映像の外まで引っぱっても描き続ける
    addInk(p);
    return;
  }
  if (e.button !== 0) return;
  layer.click(me.id, p.x, p.y);
  send({ type: 'click', x: p.x, y: p.y });
});
stage.addEventListener('pointerup', (e) => { if (drawing && e.button === 2) endInk(e); });
stage.addEventListener('pointercancel', () => endInk());

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
  b.textContent = emoji;
  b.title = `キー ${i + 1}`;
  b.dataset.key = i + 1; // 右下に小さく出すキー番号（表示はCSS）
  b.setAttribute('aria-label', `${emoji} リアクション（キー${i + 1}）`);
  b.addEventListener('click', () => sendReaction(emoji));
  reactBox.appendChild(b);
});
// 文字入力中（名前・チャット・音量つまみ等）はショートカットを効かせない
const typing = (e) => !!(e.target && e.target.closest && e.target.closest('input, textarea, select'));
document.addEventListener('keydown', (e) => {
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
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

// ---------- 共有音（ホストのPCの音） ----------
let wantAudio = false;
const muteBtn = $('#muteBtn');
const vol = $('#vol');
try { vol.value = localStorage.getItem('cursorshare.volume') ?? vol.value; } catch {}
video.volume = Number(vol.value);

function updateMuteBtn() {
  const on = wantAudio;
  muteBtn.textContent = on ? '🔊 共有音オン' : '🔇 共有音オフ';
  muteBtn.setAttribute('aria-pressed', String(on));
}
function applyAudio() {
  video.muted = !wantAudio;
  if (video.srcObject) {
    video.play().catch(() => {
      // 自動再生がブロックされた場合はミュートで映像だけ流し、ボタンで再開してもらう
      video.muted = true;
      wantAudio = false;
      video.play().catch(() => {});
      updateMuteBtn();
    });
  }
  updateMuteBtn();
}
function toggleAudio() {
  wantAudio = !wantAudio;
  applyAudio();
}
muteBtn.addEventListener('click', toggleAudio);
vol.addEventListener('input', () => {
  video.volume = Number(vol.value);
  try { localStorage.setItem('cursorshare.volume', vol.value); } catch {}
  if (!wantAudio && Number(vol.value) > 0) { wantAudio = true; applyAudio(); }
});
updateMuteBtn();

// ---------- マイク（自分の声）と、他の参加者の声の音量 ----------
const micBtn = $('#micBtn');
const micMenuBtn = $('#micMenuBtn');
const micMenu = $('#micMenu');
const voiceVol = $('#voiceVol');
try { voiceVol.value = localStorage.getItem('cursorshare.voiceVolume') ?? voiceVol.value; } catch {}
voice.setVolume(Number(voiceVol.value));
voiceVol.addEventListener('input', () => {
  voice.setVolume(Number(voiceVol.value));
  try { localStorage.setItem('cursorshare.voiceVolume', voiceVol.value); } catch {}
});

function renderMic() {
  const s = voice.mic;
  const label = { off: 'マイクを使う', on: 'マイク オン', muted: 'ミュート中', na: 'マイク不可' }[s];
  micBtn.innerHTML = `${micIcon(s === 'muted' || s === 'na')}<span></span>`;
  micBtn.lastElementChild.textContent = label;
  micBtn.dataset.state = s;
  micBtn.setAttribute('aria-pressed', String(s === 'on'));
  micBtn.setAttribute('aria-label', s === 'on' ? 'マイク オン（押すとミュート）' : s === 'muted' ? 'ミュート中（押すと解除）' : label);
  micBtn.classList.toggle('speaking', voice.speaking);
  const using = s === 'on' || s === 'muted';
  micMenuBtn.hidden = !using;
  $('#micMeter').hidden = !using;
  if (!using) closeMicMenu();
}
micBtn.addEventListener('click', async () => {
  $('#notice').hidden = true;
  const was = voice.mic;
  await voice.toggle();
  if (sameMachine && was === 'off' && voice.mic === 'on') {
    notice('ホストと同じPCでマイクを使うと、スピーカーから出た自分の声をマイクが拾ってハウリングします。ヘッドホンを使うか、ホスト画面の「ボイス」の音量を0にしてください。');
  }
});

function closeMicMenu() {
  micMenu.hidden = true;
  micMenuBtn.setAttribute('aria-expanded', 'false');
}
// ▾：使うマイクの選択と、マイクを完全に切る
micMenuBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!micMenu.hidden) return closeMicMenu();
  const devices = await voice.devices();
  micMenu.replaceChildren();
  devices.forEach((d, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pop-item';
    b.textContent = d.label || `マイク ${i + 1}`;
    if (d.deviceId === voice.deviceId) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', async () => {
      closeMicMenu();
      const wasMuted = voice.mic === 'muted';
      if (await voice.enable(d.deviceId) && wasMuted) voice.set('muted'); // ミュート中に切り替えたらミュートのまま
    });
    micMenu.appendChild(b);
  });
  const off = document.createElement('button');
  off.type = 'button';
  off.className = 'pop-item pop-sep';
  off.textContent = 'マイクを切る';
  off.addEventListener('click', () => {
    closeMicMenu();
    voice.disable();
  });
  micMenu.appendChild(off);
  micMenu.hidden = false;
  micMenuBtn.setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', (e) => { if (!e.target.closest('.mic-group')) closeMicMenu(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMicMenu();
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const k = String(e.key).toLowerCase();
  if (k === 'm') toggleAudio();
  // V：マイクのオン⇔ミュート（まだマイクを使っていない時は、誤操作防止のためボタンから）
  if (k === 'v' && (voice.mic === 'on' || voice.mic === 'muted')) voice.toggle();
});
renderMic();

// 動作確認用（開発者ツールから状態を見られるように）
window.__cs = { voice, people, layer, get pc() { return pc; } };
