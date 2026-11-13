import { CursorLayer, renderPeople, waitIceGathering, wsUrl, appendChat, bindChatInput, startMeter } from '/common.js';
import { HostVoice } from '/host-voice.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const layer = new CursorLayer($('#layer'), video);
const people = new Map(); // 参加者のみ。id -> { name, color, mic, speaking }
const pcs = new Map(); // 参加者id -> { pc, video, audio, voice, n }（接続と、その中の3本の通り道）
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
let offerSeq = 0;

// 参加者のボイス（受け取り・配り直し・ハウリング防止）
const voice = new HostVoice({
  onChange: () => renderGuard(),
  // ハウリング防止の入/切で、参加者へ送る共有音声トラックが切り替わる
  onShareTrack: () => { for (const peer of pcs.values()) syncShare(peer); },
});

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
  renderPeople($('#people'), people, { onClick: (id) => send({ type: 'mute', id }) });
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
      for (const id of [...voice.outbound.keys()]) if (!people.has(id)) voice.removePeer(id);
      if (stream) {
        send({ type: 'share', sharing: true });
        guardSent = false; // サーバーとつなぎ直したので、ハウリング防止の状況も伝え直す
        renderGuard();
      }
      // 共有していなくても全員とつなぐ（共有の前後でも声で話せるように）
      for (const id of people.keys()) offerTo(id).catch(console.error);
      refresh();
      break;
    case 'join':
      addPerson(m);
      refresh();
      offerTo(m.id).catch(console.error);
      break;
    case 'voice': {
      const p = people.get(m.id);
      if (!p) break;
      p.mic = m.mic;
      p.speaking = !!m.speaking;
      layer.setSpeaking(m.id, p.speaking);
      refresh();
      break;
    }
    case 'tunnel':
      renderTunnel(m);
      renderUrls(m.urls);
      break;
    case 'leave':
      people.delete(m.id);
      layer.removePerson(m.id);
      closePeer(m.id);
      voice.removePeer(m.id);
      refresh();
      break;
    case 'cursor': layer.move(m.id, m.x, m.y); break;
    case 'click': layer.click(m.id, m.x, m.y); break;
    case 'hide': layer.hide(m.id); break;
    case 'stroke': layer.stroke(m.id, m.sid, m.pts, m.end); break;
    case 'react': layer.react(m.id, m.emoji, m.x, m.y); break;
    case 'chat':
      appendChat(chatList, m, myId);
      if (m.id !== myId) {
        layer.say(m.id, m.text);
        if (!chatOpen()) setUnread(unread + 1);
      }
      break;
    case 'signal': {
      const peer = pcs.get(m.from);
      const d = m.data || {};
      if (d.renegotiate) {
        // 参加者側で接続が切れた：つなぎ直す（連続では受けない）
        if (people.has(m.from) && (!peer || performance.now() - peer.at > 2500)) offerTo(m.from).catch(console.error);
      } else if (peer && d.sdp && d.sdp.type === 'answer' && d.n === peer.n) {
        await peer.pc.setRemoteDescription(d.sdp);
        tune(peer);
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
  people.set(p.id, { name: p.name, color: p.color, mic: p.mic || 'off', speaking: !!p.speaking });
  layer.setPerson(p.id, p.name, p.color);
  layer.setSpeaking(p.id, !!p.speaking);
}

// ---------- 参加者との接続 ----------
// 参加者1人につき1本の接続を、参加している間ずっと保つ。中の通り道は3本：
//   video … 共有映像（共有していない間は空）
//   audio … 共有音声（同上）
//   voice … ボイス。ホスト→参加者は「その人以外の全員の声」、参加者→ホストはその人のマイク
// 共有の開始・停止は、通り道に流すトラックを差し替えるだけ（つなぎ直さないので、声は途切れない）
async function offerTo(id) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers });
  const shareMs = new MediaStream(); // 映像と共有音声をひとまとめにして、音ズレを防ぐ
  const out = voice.out(id);
  const peer = {
    pc,
    n: ++offerSeq,
    at: performance.now(),
    video: pc.addTransceiver('video', { direction: 'sendonly', streams: [shareMs] }),
    audio: pc.addTransceiver('audio', { direction: 'sendonly', streams: [shareMs] }),
    voice: pc.addTransceiver(out.track, { direction: 'sendrecv', streams: [out.stream] }),
  };
  pcs.set(id, peer);
  voice.attachIn(id, peer.voice.receiver.track);
  await syncShare(peer);
  await pc.setLocalDescription(await pc.createOffer());
  await waitIceGathering(pc);
  if (pcs.get(id) !== peer) return; // 途中で閉じられた
  send({
    type: 'signal',
    to: id,
    data: { sdp: pc.localDescription, n: peer.n, mids: { video: peer.video.mid, audio: peer.audio.mid, voice: peer.voice.mid } },
  });
}

// いま共有している映像・音声を、その参加者への通り道に流す（共有していなければ空にする）
async function syncShare(peer) {
  const v = stream ? stream.getVideoTracks()[0] || null : null;
  const a = stream ? voice.shareTrack() : null;
  try {
    await Promise.all([peer.video.sender.replaceTrack(v), peer.audio.sender.replaceTrack(a)]);
  } catch (e) {
    console.warn(e);
  }
  tune(peer);
}

// 文字（漫画のセリフなど）が潰れにくいよう、ビットレートの上限を上げる
function tune(peer) {
  if (!peer.pc.currentRemoteDescription) return; // 接続の取り決めが済んでから
  const cap = (sender, bps) => {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length || p.encodings[0].maxBitrate === bps) return;
    p.encodings[0].maxBitrate = bps;
    sender.setParameters(p).catch((e) => console.warn(e));
  };
  cap(peer.video.sender, videoMaxBitrate);
  cap(peer.audio.sender, 160_000); // 共有音（音楽・SE）は高音質で
  cap(peer.voice.sender, 48_000); // 声は軽く
}

function closePeer(id) {
  const peer = pcs.get(id);
  if (peer) peer.pc.close();
  pcs.delete(id);
  voice.detachIn(id);
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
  // 音声は加工せずそのまま送る（エコー除去などは音楽・SEを劣化させるのでオフ）
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const capture = (extra) => navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    audio: { ...audio, ...extra },
    systemAudio: 'include',
  });
  try {
    try {
      // restrictOwnAudio：このアプリ自身が鳴らす音（＝参加者の声）を、PCの音声から除外する（Windows 11）
      stream = await capture({ restrictOwnAudio: true });
    } catch (e) {
      if (e.name === 'NotAllowedError') throw e; // 利用者が取り消した
      if (appApi && choice) await appApi.chooseSource(choice.id, choice.audio === 'system');
      stream = await capture({}); // 指定を受け付けない環境では、指定なしで取り直す
    }
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
  // 共有音声に参加者の声が混ざらないかを調べ、必要ならハウリング防止を入れる
  const kind = !hasAudio ? 'none' : choice && choice.audio.startsWith('input:') ? 'input' : 'system';
  try {
    await voice.setShare(stream.getAudioTracks()[0] || null, kind);
  } catch (e) {
    console.warn(e); // チェックに失敗しても、共有そのものは続ける
  }
  if (!stream) return; // 準備中に停止された
  send({ type: 'share', sharing: true });
  guardSent = false; // 共有を始め直したら、ハウリング防止の状況を伝え直す
  renderGuard();
  for (const peer of pcs.values()) syncShare(peer);
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
  voice.setShare(null);
  for (const peer of pcs.values()) syncShare(peer); // 接続は保ったまま、映像と共有音声だけ止める
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

// ---------- ボイス（参加者の声）の設定 ----------
const voicePanel = $('#voicePanel');
const voiceBtn = $('#voiceBtn');
const stored = (key, def) => { try { return localStorage.getItem(key) ?? def; } catch { return def; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

voice.volume = Number(stored('cursorshare.hostVoiceVolume', '1'));
voice.sinkId = stored('cursorshare.voiceSink', '');
voice.guard.mode = stored('cursorshare.guard', 'auto');
voice.init();
$('#voiceVol').value = voice.volume;
$('#guardMode').value = voice.guard.mode;
// ブラウザ版では、最初の操作があるまで音を出せないので、操作のたびに起こす
document.addEventListener('pointerdown', () => voice.resume());

$('#voiceVol').addEventListener('input', (e) => {
  voice.setVolume(Number(e.target.value));
  store('cursorshare.hostVoiceVolume', e.target.value);
});
$('#guardMode').addEventListener('change', (e) => {
  voice.setMode(e.target.value);
  store('cursorshare.guard', voice.guard.mode);
});
$('#muteAllBtn').addEventListener('click', () => send({ type: 'mute', all: true }));
$('#retestBtn').addEventListener('click', () => voice.retest());

// 声を鳴らす再生デバイス
async function fillSinks() {
  const sel = $('#voiceSink');
  const list = async () => (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  let devices = [];
  try {
    devices = await list();
    if (appApi && devices.length && devices.every((d) => !d.label)) {
      // デバイス名が伏せられている時は、一度だけ許可を取ってから読み直す
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
      devices = await list();
    }
  } catch {}
  sel.replaceChildren(new Option('既定のデバイス', ''));
  devices.forEach((d, i) => sel.add(new Option(d.label || `再生デバイス ${i + 1}`, d.deviceId)));
  sel.value = [...sel.options].some((o) => o.value === voice.sinkId) ? voice.sinkId : '';
}
$('#voiceSink').addEventListener('change', async (e) => {
  const ok = await voice.setSink(e.target.value);
  if (!ok) {
    e.target.value = '';
    setStatus('その再生デバイスは使えませんでした。既定のデバイスに戻しました');
  }
  store('cursorshare.voiceSink', voice.sinkId);
});

function closeVoicePanel() {
  voicePanel.hidden = true;
  voiceBtn.setAttribute('aria-expanded', 'false');
}
voiceBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!voicePanel.hidden) return closeVoicePanel();
  voicePanel.hidden = false;
  voiceBtn.setAttribute('aria-expanded', 'true');
  fillSinks();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.voice-host')) closeVoicePanel(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVoicePanel(); });

// ハウリング防止の状態を表示する
function renderGuard() {
  const g = voice.guard;
  let text;
  let cls = '';
  if (!stream) {
    text = '画面共有を始めると、共有音声に参加者の声が混ざらないかを自動でチェックします。';
  } else if (g.kind === 'none') {
    text = '音声を共有していないので、ハウリングは起きません。';
  } else if (!g.available) {
    text = 'この環境ではハウリング防止を使えません。';
    cls = 'warn';
  } else if (g.active) {
    cls = 'warn';
    text = g.mode === 'on'
      ? 'ハウリング防止オン：参加者が話している間は、共有音を止めます。'
      : 'この環境では、共有音声に参加者の声が混ざります。声が相手に返ってハウリングするのを防ぐため、参加者が話している間は共有音を自動で止めています。\n'
        + '「出力先」を、共有していない別の再生デバイスにすると、止めずに済みます。';
  } else if (g.testing) {
    text = '共有音声に声が混ざらないかをチェックしています…';
  } else if (g.leak) {
    cls = 'warn';
    text = 'ハウリング防止がオフです。共有音声に参加者の声が混ざり、参加者に自分の声が遅れて返ります。';
  } else {
    cls = 'ok';
    text = g.restricted
      ? '参加者の声は、共有音声から自動で除外されています。ハウリングは起きません。'
      : '共有音声に参加者の声は混ざっていません。ハウリングは起きません。';
  }
  const note = $('#guardNote');
  note.textContent = text;
  note.className = `pop-note ${cls}`;
  $('#retestBtn').hidden = !(stream && g.kind !== 'none');
  // バーにも短く出す
  const hint = $('#guardHint');
  hint.hidden = !(stream && g.active);
  hint.textContent = g.ducking ? 'ハウリング防止：発言中のため共有音を停止中' : 'ハウリング防止：発言中は共有音を止めます';
  hint.classList.toggle('on', g.ducking);
  $('#audioBox').classList.toggle('ducked', !!(stream && g.active && g.ducking));
  // 参加者にも「発言中は共有音が止まる」ことを知らせる
  const on = !!(stream && g.active);
  if (on !== guardSent) {
    guardSent = on;
    send({ type: 'guard', on });
  }
}
let guardSent = false;

// 届いている声のレベル
(function tickVoice() {
  $('#voiceMeter i').style.width = `${Math.round(voice.level() * 100)}%`;
  requestAnimationFrame(tickVoice);
})();
renderGuard();

// 動作確認用（開発者ツールから状態を見られるように）
window.__cs = { voice, pcs, people, layer };

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
