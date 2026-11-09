import { CursorLayer, renderPeople, waitIceGathering, wsUrl, appendChat, bindChatInput, startMeter } from '/common.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const layer = new CursorLayer($('#layer'), video);
const people = new Map(); // 参加者のみ
const pcs = new Map(); // 参加者id -> RTCPeerConnection
const chatList = $('#chatList');

let ws = null;
let myId = null;
let stream = null;
let fatal = false;
let chain = Promise.resolve();
let unread = 0;
let hasAudio = false;
let iceServers = [];
let videoMaxBitrate = 6_000_000;

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'host' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    chain = chain.then(() => handle(m)).catch(console.error);
  };
  ws.onclose = () => {
    myId = null;
    for (const id of [...pcs.keys()]) closePeer(id);
    if (fatal) return;
    setStatus('サーバーとの接続が切れました。再接続しています…');
    setTimeout(connect, 2000);
  };
}

function send(m) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
}
function setStatus(t) { $('#status').textContent = t; }
function refresh() {
  renderPeople($('#people'), people);
  if (!myId) return;
  if (!stream) return setStatus(`待機中・参加者 ${people.size} 人`);
  setStatus(`共有中（${hasAudio ? '音声あり' : '音声なし'}）・参加者 ${people.size} 人`);
}

async function handle(m) {
  switch (m.type) {
    case 'welcome':
      myId = m.id;
      iceServers = m.iceServers || [];
      videoMaxBitrate = m.videoMaxBitrate || videoMaxBitrate;
      renderUrls(m.urls);
      renderTunnel(m.tunnel);
      document.title = `画面共有（ホスト） CursorShare ${m.version || ''}`;
      people.clear();
      for (const v of m.viewers) addPerson(v);
      if (stream) {
        send({ type: 'share', sharing: true });
        for (const id of people.keys()) offerTo(id).catch(console.error);
      }
      refresh();
      break;
    case 'join':
      addPerson(m);
      refresh();
      if (stream) await offerTo(m.id);
      break;
    case 'tunnel':
      renderTunnel(m);
      renderUrls(m.urls);
      break;
    case 'leave':
      people.delete(m.id);
      layer.removePerson(m.id);
      closePeer(m.id);
      refresh();
      break;
    case 'cursor': layer.move(m.id, m.x, m.y); break;
    case 'click': layer.click(m.id, m.x, m.y); break;
    case 'hide': layer.hide(m.id); break;
    case 'react': layer.react(m.id, m.emoji, m.x, m.y); break;
    case 'chat':
      appendChat(chatList, m, myId);
      if (m.id !== myId) {
        layer.say(m.id, m.text);
        if (!chatOpen()) setUnread(unread + 1);
      }
      break;
    case 'signal': {
      const pc = pcs.get(m.from);
      if (pc && m.data && m.data.sdp && m.data.sdp.type === 'answer') {
        await pc.setRemoteDescription(m.data.sdp);
      }
      break;
    }
    case 'error':
      if (m.fatal) fatal = true;
      setStatus(m.message);
      break;
  }
}

function addPerson(p) {
  people.set(p.id, { name: p.name, color: p.color });
  layer.setPerson(p.id, p.name, p.color);
}

// ---------- 映像の送信 ----------
async function offerTo(id) {
  if (!stream) return;
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers });
  pcs.set(id, pc);
  for (const t of stream.getTracks()) pc.addTrack(t, stream);
  await pc.setLocalDescription(await pc.createOffer());
  await waitIceGathering(pc);
  if (pcs.get(id) !== pc) return; // 途中で閉じられた
  send({ type: 'signal', to: id, data: { sdp: pc.localDescription } });
  // 文字（漫画のセリフなど）が潰れにくいようビットレート上限を上げる
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== 'video') continue;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) continue;
    p.encodings[0].maxBitrate = videoMaxBitrate;
    s.setParameters(p).catch((e) => console.warn(e));
  }
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== 'audio') continue;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) continue;
    p.encodings[0].maxBitrate = 160_000;
    s.setParameters(p).catch((e) => console.warn(e));
  }
}

function closePeer(id) {
  const pc = pcs.get(id);
  if (pc) pc.close();
  pcs.delete(id);
}

// ---------- アプリ版：共有する画面を選ぶ ----------
const appApi = window.cursorShareApp || null; // Electronアプリ内なら存在
const picker = $('#picker');

function pickSource() {
  return new Promise((resolve) => {
    const fill = (box, list) => {
      box.replaceChildren(...list.map((src) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pick-item';
        const img = document.createElement('img');
        img.src = src.thumbnail;
        img.alt = '';
        const cap = document.createElement('span');
        cap.textContent = src.name;
        b.append(img, cap);
        b.addEventListener('click', () => {
          const audio = probe.pick;
          try { localStorage.setItem('cursorshare.audio', audio); } catch {}
          picker.close('picked');
          resolve({ id: src.id, audio });
        });
        return b;
      }));
    };
    $('#pickScreens').replaceChildren();
    $('#pickWindows').replaceChildren();
    picker.onclose = () => {
      stopProbe();
      if (picker.returnValue !== 'picked') resolve(null);
    };
    picker.returnValue = '';
    picker.showModal(); // 先に開いて、一覧は後から埋める
    appApi.getSources().then((sources) => {
      fill($('#pickScreens'), sources.filter((x) => x.isScreen));
      fill($('#pickWindows'), sources.filter((x) => !x.isScreen));
      startProbe(sources.find((x) => x.isScreen)).catch(console.error);
    });
  });
}

// ---------- 音声の自動検出 ----------
// 候補（PCの音声＋全入力デバイス）を同時に開いてレベルを測り、音を拾えたものを自動で選ぶ
const probe = { pick: 'system', userPicked: false, rows: new Map(), streams: [], stops: [], timer: 0, gen: 0 };

function addAudioRow(value, label, withMeter) {
  const row = document.createElement('label');
  row.className = 'audio-row';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'audioPick';
  radio.value = value;
  radio.checked = probe.pick === value;
  radio.addEventListener('change', () => {
    probe.pick = value;
    probe.userPicked = true;
    $('#audioNote').textContent = '';
  });
  const name = document.createElement('span');
  name.className = 'audio-name';
  name.textContent = label;
  row.append(radio, name);
  let meter = null;
  if (withMeter) {
    meter = document.createElement('span');
    meter.className = 'meter';
    meter.appendChild(document.createElement('i'));
    row.appendChild(meter);
  }
  $('#audioList').appendChild(row);
  // マイクは話し声で反応してしまうので、自動選択では後回し
  const isMic = /マイク|microphone|\bmic\b|headset|ヘッドセット|webcam|camera/i.test(label);
  const info = { row, radio, meter, level: 0, heard: false, weight: isMic ? 0.4 : 1 };
  probe.rows.set(value, info);
  return info;
}

function selectAudio(value) {
  probe.pick = value;
  for (const [v, r] of probe.rows) {
    r.radio.checked = v === value;
    r.row.classList.toggle('picked', v === value);
  }
}

async function startProbe(screenSource) {
  stopProbe();
  const gen = ++probe.gen;
  try { probe.pick = localStorage.getItem('cursorshare.audio') || 'system'; } catch { probe.pick = 'system'; }
  probe.userPicked = false;
  $('#audioList').replaceChildren();
  $('#audioNote').textContent = '音を確認しています…';
  probe.rows.clear();

  addAudioRow('none', '共有しない', false);
  const watch = (value, stream) => {
    if (gen !== probe.gen) { stream.getTracks().forEach((t) => t.stop()); return; }
    probe.streams.push(stream);
    const r = probe.rows.get(value);
    probe.stops.push(startMeter(stream, r.meter, (lv) => {
      r.level = r.level * 0.9 + lv * 0.1; // なめらかに
      if (lv > 0.12) r.heard = true;
      r.row.classList.toggle('active', lv > 0.08);
    }));
  };

  // PCの音声（Windowsの再生デバイスのループバック）
  addAudioRow('system', 'PCの音声（Windowsで再生している音）', true);
  if (screenSource) {
    try {
      await appApi.chooseSource(screenSource.id, true);
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
      if (s.getAudioTracks().length) watch('system', s);
    } catch (e) { console.warn(e); }
  }

  // 入力デバイス（オーディオインターフェースのループバック、ステレオミキサー、マイク等）
  try {
    const tmp = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    tmp.getTracks().forEach((t) => t.stop());
  } catch {}
  if (gen !== probe.gen) return;
  const inputs = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  for (const d of inputs) {
    const value = `input:${d.deviceId}`;
    addAudioRow(value, d.label || '入力デバイス', true);
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: d.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }).then((s) => watch(value, s)).catch(() => probe.rows.get(value)?.row.classList.add('unavailable'));
  }
  if (!probe.rows.has(probe.pick)) probe.pick = 'system';
  selectAudio(probe.pick);
  $('#audioNote').textContent = 'Premiere や DAW で音を再生してみてください';

  // 一番大きく鳴っているものを自動で選ぶ（自分で選んだ後は触らない）
  const started = performance.now();
  probe.timer = setInterval(() => {
    if (probe.userPicked) return;
    let best = null;
    const score = (r) => r.level * r.weight;
    for (const [v, r] of probe.rows) if (r.meter && r.heard && (!best || score(r) > score(best[1]))) best = [v, r];
    if (best) {
      const cur = probe.rows.get(probe.pick);
      if (best[0] !== probe.pick && (!cur || !cur.heard || score(best[1]) > score(cur) + 0.1)) selectAudio(best[0]);
      $('#audioNote').textContent = `音を拾えています：${probe.rows.get(probe.pick).row.querySelector('.audio-name').textContent}`;
      $('#audioNote').className = 'audio-note ok';
    } else if (performance.now() - started > 8000) {
      $('#audioNote').className = 'audio-note warn';
      $('#audioNote').textContent = 'どれも反応しません。音を出しているソフト（Premiere・DAW等）のオーディオ出力が ASIO の場合、'
        + '出力をWindowsのデバイス（MME / WASAPI）に変えると「PCの音声」で拾えるようになります。';
    }
  }, 300);
}

function stopProbe() {
  probe.gen++;
  clearInterval(probe.timer);
  probe.stops.forEach((f) => f());
  probe.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  probe.stops = [];
  probe.streams = [];
  $('#audioNote').className = 'audio-note';
}

async function startShare() {
  let choice = null;
  if (appApi) {
    choice = await pickSource();
    if (!choice) return;
    await appApi.chooseSource(choice.id, choice.audio === 'system');
  }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      // 音声は加工せずそのまま送る（エコー除去などは音楽・SEを劣化させるのでオフ）
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
    });
  } catch (e) {
    stream = null;
    setStatus(e.name === 'NotAllowedError' ? '画面共有がキャンセルされました' : `画面共有を開始できません：${e.message}`);
    return;
  }
  // 入力デバイスを音声に選んだ場合は別に取得して足す
  if (choice && choice.audio.startsWith('input:')) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: choice.audio.slice(6) },
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 2, sampleRate: 48000,
        },
      });
      stream.getAudioTracks().forEach((t) => { stream.removeTrack(t); t.stop(); });
      stream.addTrack(mic.getAudioTracks()[0]);
    } catch (e) {
      setStatus(`音声の入力デバイスを開けません：${e.message}`);
    }
  }
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'detail'; // 解像度（文字の読みやすさ）を優先
  track.addEventListener('ended', stopShare); // ブラウザ側の「共有を停止」にも対応
  hasAudio = stream.getAudioTracks().length > 0;
  startAudioMonitor();
  video.srcObject = stream;
  $('#empty').hidden = true;
  send({ type: 'share', sharing: true });
  for (const id of people.keys()) offerTo(id).catch(console.error);
  if (appApi) appApi.shareStarted();
  updateButton();
  refresh();
}

function stopShare() {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  hasAudio = false;
  stopAudioMonitor();
  video.srcObject = null;
  for (const id of [...pcs.keys()]) closePeer(id);
  layer.clear();
  $('#empty').hidden = false;
  send({ type: 'share', sharing: false });
  if (appApi) appApi.shareStopped();
  updateButton();
  refresh();
}

// ---------- 音声の監視：レベル表示と「無音」の警告 ----------
let stopMeter = () => {};
let silentSince = 0;
function startAudioMonitor() {
  stopAudioMonitor();
  const hint = $('#audioHint');
  if (!hasAudio) {
    hint.textContent = '音声なし：共有開始時に「音声」を選んでください';
    hint.hidden = false;
    return;
  }
  $('#audioBox').hidden = false;
  silentSince = performance.now();
  stopMeter = startMeter(stream, $('#audioMeter'), (level) => {
    if (level > 0.05) silentSince = performance.now();
    const silent = performance.now() - silentSince > 4000;
    if (silent && hint.hidden) {
      hint.textContent = '音が届いていません。ASIO等で鳴らしている音は「PCの音声」で拾えないので、入力デバイス（ループバック）を選び直してください';
      hint.hidden = false;
    } else if (!silent && !hint.hidden) hint.hidden = true;
  });
}
function stopAudioMonitor() {
  stopMeter();
  stopMeter = () => {};
  $('#audioBox').hidden = true;
  $('#audioHint').hidden = true;
}

function updateButton() {
  const b = $('#shareBtn');
  b.textContent = stream ? '共有を停止' : '画面共有を開始';
  b.classList.toggle('primary', !stream);
}
$('#shareBtn').addEventListener('click', () => (stream ? stopShare() : startShare()));

// ---------- デスクトップ表示（アプリ版のみ） ----------
if (appApi) {
  const ob = $('#overlayBtn');
  ob.hidden = false;
  let overlayOn = true;
  ob.addEventListener('click', async () => {
    overlayOn = !overlayOn;
    await appApi.setOverlay(overlayOn);
    ob.textContent = `デスクトップ表示：${overlayOn ? 'オン' : 'オフ'}`;
    ob.setAttribute('aria-pressed', String(overlayOn));
  });
}

// ---------- インターネット公開 ----------
let tunnelState = 'off';
function renderTunnel(t) {
  if (!t) return;
  tunnelState = t.state;
  const b = $('#tunnelBtn');
  b.textContent = {
    off: 'インターネット公開：オフ',
    starting: 'インターネット公開：準備中…',
    on: 'インターネット公開：オン',
    error: 'インターネット公開：失敗（再試行）',
  }[t.state];
  b.setAttribute('aria-pressed', String(t.state === 'on'));
  b.disabled = t.state === 'starting';
  if (t.message) setStatus(t.message);
}
$('#tunnelBtn').addEventListener('click', () => {
  send({ type: 'tunnel', on: tunnelState !== 'on' });
});

// ---------- 参加者用URL ----------
function copyButton(label, url) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'url-btn';
  b.title = url;
  b.textContent = label;
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      b.textContent = 'コピーしました';
    } catch {
      prompt('このURLを参加者に送ってください', url);
    }
    setTimeout(() => { b.textContent = label; }, 1500);
  });
  return b;
}

function renderUrls(urls) {
  const box = $('#urls');
  box.replaceChildren();
  if (!urls) return;
  if (urls.internet) box.appendChild(copyButton('インターネット用URLをコピー', urls.internet));
  const lan = urls.lan || [];
  if (!lan.length) return;
  // LANは一番それらしいアドレス1つだけ。他のネットワークアダプタ分は ▾ の中へ
  const group = document.createElement('div');
  group.className = 'url-group';
  group.appendChild(copyButton('LAN用URLをコピー', lan[0].url));
  if (lan.length > 1) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'url-more';
    more.textContent = '▾';
    more.title = '別のネットワークのURL';
    more.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.className = 'url-menu';
    menu.hidden = true;
    for (const u of lan.slice(1)) {
      const b = copyButton(`${new URL(u.url).hostname}（${u.name}）`, u.url);
      b.addEventListener('click', () => setTimeout(close, 900));
      menu.appendChild(b);
    }
    const close = () => { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); };
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      more.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', (e) => { if (!group.contains(e.target)) close(); });
    group.append(more, menu);
  }
  box.appendChild(group);
}

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

connect();
