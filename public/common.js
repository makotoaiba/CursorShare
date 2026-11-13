// ホスト画面・参加者画面で共通の処理

const ARROW = (c) =>
  `<svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true">` +
  `<path d="M2 2 L2 21 L7.2 16.3 L10.6 24 L14 22.5 L10.7 14.9 L18 14.9 Z" ` +
  `fill="${c}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

// <video object-fit:contain> の中で、実際に映像が描かれている矩形（黒帯を除く）
export function contentRect(video) {
  const W = video.clientWidth;
  const H = video.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: W, h: H };
  const s = Math.min(W / vw, H / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

const INK_HOLD = 3000; // 描き終わってから消え始めるまで（ms）
const INK_FADE = 800; // 消えるのにかける時間（ms）

// 参加者カーソルを描くレイヤー（座標は共有画面に対する 0〜1 の比率）
// videoEl を渡すと映像の表示範囲に、null ならレイヤー全体（デスクトップ表示用）に合わせる
export class CursorLayer {
  constructor(layerEl, videoEl = null) {
    this.layer = layerEl;
    this.video = videoEl;
    this.items = new Map(); // id -> { el, x, y, timer }
    this.people = new Map(); // id -> { name, color }
    // 右ドラッグで描かれる線（数秒で消える）。カーソルより下に重ねる
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ink';
    layerEl.prepend(this.canvas);
    this.ink = this.canvas.getContext('2d');
    this.strokes = new Map(); // "id:番号" -> { color, pts, last, end }
    this.inkWidth = Number(layerEl.dataset.ink) || 4;
    this.inkRaf = 0;
    new ResizeObserver(() => this.relayout()).observe(videoEl || layerEl);
    if (videoEl) {
      videoEl.addEventListener('loadedmetadata', () => this.relayout());
      videoEl.addEventListener('resize', () => this.relayout());
    }
  }

  rect() {
    return this.video
      ? contentRect(this.video)
      : { x: 0, y: 0, w: this.layer.clientWidth, h: this.layer.clientHeight };
  }

  setPerson(id, name, color) {
    this.people.set(id, { ...this.people.get(id), name, color });
  }

  // 発言中はカーソルの名前ラベルを光らせる
  setSpeaking(id, on) {
    const p = this.people.get(id);
    if (p) p.speaking = !!on;
    const it = this.items.get(id);
    if (it) it.el.classList.toggle('speaking', !!on);
  }

  removePerson(id) {
    this.people.delete(id);
    this.remove(id);
  }

  ensure(id) {
    let it = this.items.get(id);
    if (it) return it;
    const p = this.people.get(id);
    if (!p) return null;
    const el = document.createElement('div');
    el.className = 'cursor';
    el.style.setProperty('--c', p.color);
    el.innerHTML = ARROW(p.color) + '<span class="cursor-name"></span>';
    el.querySelector('.cursor-name').textContent = p.name;
    el.classList.toggle('speaking', !!p.speaking);
    this.layer.appendChild(el);
    it = { el, x: 0, y: 0, timer: 0 };
    this.items.set(id, it);
    return it;
  }

  place(it) {
    const r = this.rect();
    it.el.style.transform = `translate(${r.x + it.x * r.w}px, ${r.y + it.y * r.h}px)`;
  }

  move(id, x, y) {
    const it = this.ensure(id);
    if (!it) return;
    it.x = x;
    it.y = y;
    it.el.hidden = false;
    it.el.classList.remove('idle');
    this.place(it);
    clearTimeout(it.timer);
    it.timer = setTimeout(() => it.el.classList.add('idle'), 4000); // 4秒動かないと薄く
  }

  click(id, x, y) {
    this.move(id, x, y);
    const p = this.people.get(id);
    if (!p) return;
    const r = this.rect();
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.setProperty('--c', p.color);
    s.style.left = `${r.x + x * r.w}px`;
    s.style.top = `${r.y + y * r.h}px`;
    this.layer.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  }

  // リアクション：その位置から浮かび上がって消える
  react(id, emoji, x, y) {
    const r = this.rect();
    const s = document.createElement('span');
    s.className = 'reaction';
    s.textContent = emoji;
    s.style.left = `${r.x + x * r.w}px`;
    s.style.top = `${r.y + y * r.h}px`;
    this.layer.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  }

  // チャットの吹き出しをカーソル横に数秒表示（カーソルが映像上にある時だけ見える）
  say(id, text) {
    const it = this.items.get(id);
    if (!it) return;
    let b = it.el.querySelector('.cursor-say');
    if (!b) {
      b = document.createElement('span');
      b.className = 'cursor-say';
      it.el.appendChild(b);
    }
    b.textContent = text.length > 60 ? text.slice(0, 60) + '…' : text;
    clearTimeout(it.sayTimer);
    it.sayTimer = setTimeout(() => b.remove(), 5000);
  }

  hide(id) {
    const it = this.items.get(id);
    if (it) it.el.hidden = true;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    clearTimeout(it.timer);
    clearTimeout(it.sayTimer);
    it.el.remove();
    this.items.delete(id);
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
    this.strokes.clear();
    this.drawInk();
  }

  relayout() {
    for (const it of this.items.values()) this.place(it);
    this.drawInk();
  }

  // 線の続きを足す。pts は [[x, y], ...]（0〜1）。end で描き終わり
  stroke(id, sid, pts, end) {
    const key = `${id}:${sid}`;
    let st = this.strokes.get(key);
    if (!st) {
      const p = this.people.get(id);
      st = { color: (p && p.color) || '#ffffff', pts: [], last: 0, end: 0 };
      this.strokes.set(key, st);
    }
    for (const pt of pts || []) st.pts.push(pt);
    st.last = performance.now();
    if (end && !st.end) st.end = st.last;
    this.kickInk();
  }

  kickInk() {
    if (!this.inkRaf) this.inkRaf = requestAnimationFrame(() => { this.inkRaf = 0; this.drawInk(); });
  }

  drawInk() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.layer.clientWidth;
    const H = this.layer.clientHeight;
    const cw = Math.max(1, Math.round(W * dpr));
    const ch = Math.max(1, Math.round(H * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ink;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!this.strokes.size) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const r = this.rect();
    const now = performance.now();
    for (const [key, st] of this.strokes) {
      if (!st.end && now - st.last > 10000) st.end = st.last; // 描いている途中で切断された線も、いずれ消す
      let alpha = 1;
      if (st.end) {
        const age = now - st.end;
        if (age > INK_HOLD + INK_FADE) {
          this.strokes.delete(key);
          continue;
        }
        if (age > INK_HOLD) alpha = 1 - (age - INK_HOLD) / INK_FADE;
      }
      if (!st.pts.length) continue;
      const path = new Path2D();
      st.pts.forEach(([x, y], i) => {
        const px = r.x + x * r.w;
        const py = r.y + y * r.h;
        if (i === 0) path.moveTo(px, py);
        else path.lineTo(px, py);
        if (st.pts.length === 1) path.lineTo(px + 0.01, py); // 点だけでも見えるように
      });
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = 'rgba(255, 255, 255, .9)'; // どんな背景でも見えるよう、白いふちを付ける
      ctx.lineWidth = this.inkWidth + 3;
      ctx.stroke(path);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = this.inkWidth;
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
    if (this.strokes.size) this.kickInk();
  }
}

// マイクのアイコン（muted なら斜線つき）
export function micIcon(muted) {
  return '<svg class="mic-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
    + '<path d="M8 1.5a2.2 2.2 0 0 0-2.2 2.2v4a2.2 2.2 0 0 0 4.4 0v-4A2.2 2.2 0 0 0 8 1.5Z" fill="currentColor"/>'
    + '<path d="M3.8 7.5a4.2 4.2 0 0 0 8.4 0M8 11.7v2.6M5.6 14.3h4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    + (muted ? '<path d="M2.2 2.2l11.6 11.6" fill="none" stroke="#ff6b6b" stroke-width="1.7" stroke-linecap="round"/>' : '')
    + '</svg>';
}

// 参加者チップ。people: id -> { name, color, mic, speaking }
// opts.onClick を渡すと、マイクがオンの人のチップを押せるようになる（ホストからのミュート用）
export function renderPeople(ul, people, opts = {}) {
  ul.replaceChildren(
    ...[...people.entries()].map(([id, p]) => {
      const li = document.createElement('li');
      li.style.setProperty('--c', p.color);
      const name = document.createElement('span');
      name.textContent = p.name;
      li.appendChild(name);
      if (p.mic === 'on' || p.mic === 'muted') {
        const ico = document.createElement('span');
        ico.className = 'chip-mic';
        ico.innerHTML = micIcon(p.mic === 'muted');
        ico.title = p.mic === 'muted' ? 'ミュート中' : 'マイク オン';
        li.appendChild(ico);
        li.classList.add(p.mic === 'on' ? 'mic-on' : 'mic-muted');
      }
      if (p.mic === 'na') {
        // LAN用URL（http）から参加していて、マイクを使えない人
        const ico = document.createElement('span');
        ico.className = 'chip-mic na';
        ico.innerHTML = micIcon(true);
        ico.title = 'LAN用URL（http）で参加しているため、マイクを使えません。インターネット用URLから参加すると使えます';
        li.appendChild(ico);
      }
      if (p.speaking) li.classList.add('speaking');
      if (opts.onClick && p.mic === 'on') {
        li.classList.add('clickable');
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.title = 'クリックでこの人のマイクをミュート';
        li.addEventListener('click', () => opts.onClick(id));
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onClick(id); }
        });
      }
      return li;
    })
  );
}

// ICE候補をSDPにまとめてから送る（通常1秒未満。順序ずれの問題も起きない）
export function waitIceGathering(pc, timeout = 3000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, timeout);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

export function wsUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export const REACTIONS = ['👍', '👀', '😂', '❤️', '❓', '🎉'];

// チャット1件をリストに追加
export function appendChat(list, m, myId) {
  const li = document.createElement('li');
  if (m.id === myId) li.className = 'mine';
  const head = document.createElement('div');
  head.className = 'chat-head';
  const name = document.createElement('span');
  name.className = 'chat-name';
  name.style.setProperty('--c', m.color);
  name.textContent = m.name;
  const time = document.createElement('time');
  const d = new Date(m.time);
  time.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  head.append(name, time);
  const body = document.createElement('p');
  body.textContent = m.text;
  li.append(head, body);
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.appendChild(li);
  while (list.children.length > 300) list.firstElementChild.remove();
  if (atBottom || m.id === myId) list.scrollTop = list.scrollHeight;
}

// チャット入力欄：Enterで送信、Shift+Enterで改行
export function bindChatInput(form, input, onSend) {
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    onSend(text);
    input.value = '';
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
}

// 音量メーター：stream の音声レベルを el（.meter > i）に表示。onLevel(0〜1) も呼ぶ
export function startMeter(stream, el, onLevel) {
  const track = stream.getAudioTracks()[0];
  if (!track) return () => {};
  let ctx;
  try { ctx = new AudioContext(); } catch { return () => {}; }
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an); // 出力には繋がない（メーター専用）
  const buf = new Float32Array(an.fftSize);
  const bar = el.querySelector('i');
  let raf = 0;
  const tick = () => {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
    const level = Math.max(0, Math.min(1, (db + 60) / 60)); // -60dB〜0dB
    bar.style.width = `${Math.round(level * 100)}%`;
    if (onLevel) onLevel(level);
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    bar.style.width = '0%';
    ctx.close().catch(() => {});
  };
}

// 音声トラックの音量を一定間隔で通知する（0〜1 ＝ -60dB〜0dB）。
// 画面の描画に連動させず タイマーで回すので、タブが裏に回っていても止まらない
export function watchLevel(track, onLevel, interval = 60) {
  let ctx;
  try { ctx = new AudioContext(); } catch { return () => {}; }
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const timer = setInterval(() => {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
    onLevel(Math.max(0, Math.min(1, (db + 60) / 60)));
  }, interval);
  return () => {
    clearInterval(timer);
    ctx.close().catch(() => {});
  };
}
