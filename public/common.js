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

// 参加者カーソルを描くレイヤー（座標は共有画面に対する 0〜1 の比率）
// videoEl を渡すと映像の表示範囲に、null ならレイヤー全体（デスクトップ表示用）に合わせる
export class CursorLayer {
  constructor(layerEl, videoEl = null) {
    this.layer = layerEl;
    this.video = videoEl;
    this.items = new Map(); // id -> { el, x, y, timer }
    this.people = new Map(); // id -> { name, color }
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
    this.people.set(id, { name, color });
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
  }

  relayout() {
    for (const it of this.items.values()) this.place(it);
  }
}

export function renderPeople(ul, people) {
  ul.replaceChildren(
    ...[...people.values()].map((p) => {
      const li = document.createElement('li');
      li.style.setProperty('--c', p.color);
      li.textContent = p.name;
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
