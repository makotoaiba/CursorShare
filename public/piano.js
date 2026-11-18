// 鍵盤：音を鳴らす・音名・表示
//
// 音そのものは送らない。「どの鍵盤が押された／離された」だけを全員に送り、
// それぞれの画面（参加者・ホスト）がその場で音を作って鳴らす。軽くて遅れが少なく、音質も落ちない。

const NAMES = {
  doremi: ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'],
  cde: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
};
export const LABEL_MODES = ['doremi', 'cde', 'both', 'off'];
export const LABEL_TEXT = { doremi: 'ドレミ', cde: 'CDE', both: '両方', off: 'なし' };
export const MIN_BASE = 36; // 鍵盤の左端に出せる一番低いド（C2）
export const MAX_BASE = 84; // 一番高いド（C6）

const pc = (m) => ((m % 12) + 12) % 12;
const oct = (m) => Math.floor(m / 12) - 1; // 真ん中のド（MIDI 60）= C4
export const isBlack = (m) => [1, 3, 6, 8, 10].includes(pc(m));

// 音名。mode：doremi / cde / both / off
export function noteName(midi, mode) {
  const i = pc(midi);
  if (mode === 'doremi') return NAMES.doremi[i];
  if (mode === 'cde') return `${NAMES.cde[i]}${oct(midi)}`;
  if (mode === 'both') return `${NAMES.doremi[i]}(${NAMES.cde[i]}${oct(midi)})`;
  return '';
}
export const cName = (midi) => `${NAMES.cde[pc(midi)]}${oct(midi)}`;

// ---------- 音（ピアノ風） ----------
export class PianoSynth {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(output || ctx.destination);
    this.analyser = ctx.createAnalyser(); // 動作確認用
    this.analyser.fftSize = 8192;
    this.out.connect(this.analyser);
    this.voices = new Map(); // "だれ:音" -> 鳴っている音
    this.count = 0;
  }

  setVolume(v) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  noteOn(key, midi) {
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    this.noteOff(key, 0.03); // 同じ鍵盤が鳴っていたら止めてから
    const t = ctx.currentTime + 0.005;
    const f = 440 * 2 ** ((midi - 69) / 12);
    const env = ctx.createGain();
    const peak = 0.26;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.006); // 打鍵
    env.gain.setTargetAtTime(peak * 0.35, t + 0.006, 0.22); // すぐに少し減衰
    env.gain.setTargetAtTime(0, t + 0.5, 1.1); // ゆっくり消える
    const lp = ctx.createBiquadFilter(); // 時間とともに音がこもっていく（ピアノらしさ）
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(16000, f * 12), t);
    lp.frequency.setTargetAtTime(Math.min(9000, f * 3), t, 0.35);
    lp.connect(env);
    env.connect(this.out);
    const oscs = [];
    [[1, 1], [2, 0.42], [3, 0.22], [4, 0.11], [5, 0.06], [6, 0.035]].forEach(([h, a]) => {
      if (f * h > 18000) return;
      const o = ctx.createOscillator();
      o.frequency.value = f * h * (1 + (h - 1) * 0.0004); // 弦らしく、倍音をわずかに高めに
      const g = ctx.createGain();
      g.gain.value = a;
      o.connect(g);
      g.connect(lp);
      o.start(t);
      o.stop(t + 6);
      oscs.push(o);
    });
    const v = { env, oscs };
    this.voices.set(key, v);
    this.count++;
    oscs[0].onended = () => {
      if (this.voices.get(key) === v) this.voices.delete(key);
      try { env.disconnect(); } catch {}
    };
  }

  // 鍵盤を離した：少しの余韻で止める
  noteOff(key, rel = 0.25) {
    const v = this.voices.get(key);
    if (!v) return;
    this.voices.delete(key);
    const t = this.ctx.currentTime;
    const g = v.env.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else {
      const now = g.value;
      g.cancelScheduledValues(t);
      g.setValueAtTime(now, t);
    }
    g.setTargetAtTime(0, t, rel / 4);
    v.oscs.forEach((o) => { try { o.stop(t + rel + 0.1); } catch {} });
  }

  // prefix を付けると、その人の音だけ止める
  allOff(prefix = '') {
    for (const k of [...this.voices.keys()]) if (k.startsWith(prefix)) this.noteOff(k);
  }
}

// ---------- 弾かれた音名の表示（「だれが・何の音を」） ----------
export class NoteFeed {
  constructor(el) {
    this.el = el;
    this.lines = new Map();
    this.mode = 'doremi';
  }

  add(id, who, color, midi) {
    if (this.mode === 'off') return;
    let ln = this.lines.get(id);
    if (!ln) {
      const row = document.createElement('div');
      row.className = 'note-line';
      row.style.setProperty('--c', color);
      const b = document.createElement('b');
      b.textContent = who;
      const notes = document.createElement('span');
      row.append(b, notes);
      this.el.appendChild(row);
      ln = { row, notes, list: [], timer: 0 };
      this.lines.set(id, ln);
    }
    ln.list.push(midi);
    if (ln.list.length > 8) ln.list.shift(); // 直近8音まで
    this.render(ln);
    ln.row.classList.remove('fade');
    clearTimeout(ln.timer);
    ln.timer = setTimeout(() => {
      ln.row.classList.add('fade');
      ln.timer = setTimeout(() => {
        ln.row.remove();
        this.lines.delete(id);
      }, 600);
    }, 2200);
  }

  render(ln) {
    ln.notes.textContent = ln.list.map((m) => noteName(m, this.mode)).join(' ');
  }

  // 表示の仕方を変える（出ている行も書き直す）
  setMode(mode) {
    this.mode = mode;
    if (mode === 'off') return this.clear();
    for (const ln of this.lines.values()) this.render(ln);
  }

  clear() {
    for (const ln of this.lines.values()) {
      clearTimeout(ln.timer);
      ln.row.remove();
    }
    this.lines.clear();
  }
}

// ---------- 画面の鍵盤（1オクターブ＋上のド） ----------
// キーボードでも弾ける：A W S E D F T G Y H U J K（白鍵 A〜K、黒鍵 W E T Y U）
export const KEY_CODES = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK'];
const KEY_LABELS = ['A', 'W', 'S', 'E', 'D', 'F', 'T', 'G', 'Y', 'H', 'U', 'J', 'K'];

export class PianoKeyboard {
  // onDown(midi) / onUp(midi)：自分が押した・離した
  constructor(el, { onDown, onUp }) {
    this.el = el;
    this.onDown = onDown;
    this.onUp = onUp;
    this.base = 60; // 左端のド（C4）
    this.mode = 'doremi';
    this.keys = new Map(); // midi -> 要素
    this.remote = new Map(); // midi -> Map(だれ -> 色)
    this.held = null; // マウス・タッチで押さえている鍵盤
    this.pointer = null;
    el.addEventListener('pointerdown', (e) => this.pdown(e));
    el.addEventListener('pointermove', (e) => this.pmove(e));
    el.addEventListener('pointerup', () => this.pup());
    el.addEventListener('pointercancel', () => this.pup());
    el.addEventListener('lostpointercapture', () => this.pup());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.build();
  }

  build() {
    this.pup();
    this.el.replaceChildren();
    this.keys.clear();
    const whites = [];
    for (let i = 0; i <= 12; i++) {
      const m = this.base + i;
      const k = document.createElement('div');
      k.className = isBlack(m) ? 'pkey black' : 'pkey white';
      k.dataset.midi = m;
      k.setAttribute('role', 'button');
      k.setAttribute('aria-label', `${noteName(m, 'doremi')}（${cName(m)}）キー ${KEY_LABELS[i]}`);
      const name = document.createElement('span');
      name.className = 'pkey-name';
      const hint = document.createElement('span');
      hint.className = 'pkey-hint';
      hint.textContent = KEY_LABELS[i];
      k.append(name, hint);
      if (!isBlack(m)) whites.push(k);
      this.keys.set(m, k);
    }
    // 白鍵を並べ、黒鍵は白鍵の境目の上に重ねる
    const n = whites.length;
    whites.forEach((k) => this.el.appendChild(k));
    let wi = 0;
    for (let i = 0; i <= 12; i++) {
      const m = this.base + i;
      const k = this.keys.get(m);
      if (isBlack(m)) {
        k.style.left = `calc(${(wi / n) * 100}% - ${(0.6 / n) * 50}%)`;
        k.style.width = `${(0.6 / n) * 100}%`;
        this.el.appendChild(k);
      } else wi++;
    }
    this.relabel();
    for (const m of this.remote.keys()) this.paint(m);
  }

  relabel() {
    for (const [m, k] of this.keys) {
      const label = this.mode === 'both' ? `${noteName(m, 'doremi')}\n${cName(m)}` : noteName(m, this.mode);
      k.querySelector('.pkey-name').textContent = label;
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.relabel();
  }

  shift(octaves) {
    const next = Math.min(MAX_BASE, Math.max(MIN_BASE, this.base + octaves * 12));
    if (next === this.base) return false;
    this.base = next;
    this.build();
    return true;
  }

  range() {
    return `${cName(this.base)}〜${cName(this.base + 12)}`;
  }

  // 自分が押している表示
  setLocal(midi, on) {
    const k = this.keys.get(midi);
    if (k) k.classList.toggle('on', on);
  }

  // 他の人が押している表示（その人の色で）
  setRemote(who, midi, color, on) {
    let m = this.remote.get(midi);
    if (on) {
      if (!m) this.remote.set(midi, (m = new Map()));
      m.set(who, color);
    } else if (m) {
      m.delete(who);
      if (!m.size) this.remote.delete(midi);
    }
    this.paint(midi);
  }

  clearRemote(who) {
    for (const [midi, m] of [...this.remote]) {
      if (who != null && !m.has(who)) continue;
      if (who == null) m.clear();
      else m.delete(who);
      if (!m.size) this.remote.delete(midi);
      this.paint(midi);
    }
  }

  paint(midi) {
    const k = this.keys.get(midi);
    if (!k) return;
    const m = this.remote.get(midi);
    const color = m && m.size ? [...m.values()].pop() : '';
    k.classList.toggle('remote', !!color);
    if (color) k.style.setProperty('--rc', color);
  }

  keyAt(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const k = el && el.closest && el.closest('.pkey');
    return k && this.el.contains(k) ? Number(k.dataset.midi) : null;
  }

  pdown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.pointer = e.pointerId;
    try { this.el.setPointerCapture(e.pointerId); } catch {}
    this.press(this.keyAt(e));
  }

  // 押したまま横になぞると、次々に弾ける（グリッサンド）
  pmove(e) {
    if (this.pointer !== e.pointerId) return;
    const m = this.keyAt(e);
    if (m !== this.held) this.press(m);
  }

  pup() {
    this.pointer = null;
    this.press(null);
  }

  press(midi) {
    if (this.held != null) this.onUp(this.held);
    this.held = midi;
    if (midi != null) this.onDown(midi);
  }
}
