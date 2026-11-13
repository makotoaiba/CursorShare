// ホスト側のボイス処理
//
// ・参加者のマイク音声（WebRTC）を受け取り、ホストのスピーカーで鳴らす
// ・参加者同士にも聞こえるよう、「自分以外の全員の声」を1本にまとめて各参加者へ返す
//   （自分の声は自分には返さない＝ミックスマイナス）
// ・ハウリング防止：ホストが共有している音声に参加者の声が混ざる（回り込む）と、参加者に自分の声が
//   遅れて返り、ハウリングの原因になる。
//     1) まず共有音声の取り込み側で、このアプリ自身の音を除外する（Windows 11。host.js 側で指定）
//     2) 除外できない環境かどうかを、聞こえない高さの短いテスト音で実測する
//     3) 回り込む環境では、参加者の声が鳴っている間だけ共有音を止める（gate-worklet.js）

const PILOT_AMP = 0.04; // テスト音の大きさ（約 -28dB）
const PILOT_BURST = 0.3; // 1音の長さ（秒）
const PILOT_FREQS = [17500, 18200]; // ほぼ聞こえない高さの2音を続けて鳴らす

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HostVoice {
  // onChange: 状態が変わった（表示の更新用） / onShareTrack: 参加者へ送る共有音声トラックが切り替わった
  constructor({ onChange, onShareTrack } = {}) {
    this.onChange = onChange || (() => {});
    this.onShareTrack = onShareTrack || (() => {});
    this.ctx = null;
    this.inbound = new Map(); // 参加者id -> { src, keep, stream }  受け取った声
    this.outbound = new Map(); // 参加者id -> { dest, stream, track } その人へ返す「他の人の声」
    this.volume = 1;
    this.sinkId = ''; // '' = Windowsの既定の再生デバイス
    this.share = {};
    this.testSeq = 0;
    this.guard = {
      kind: 'none', // 共有している音声：none / system（PCの音声）/ input（入力デバイス）
      restricted: false, // 取り込み側でこのアプリの音を除外できている
      plain: false, // PCで鳴っている音をすべて取り込んでいる（除外なし）
      mode: 'auto', // auto / on / off
      testing: false,
      tested: false,
      pilot: false, // テスト音が共有音声に現れた＝回り込む
      delay: 0, // 回り込みが届くまでの時間（ms）
      leak: false,
      active: false, // ハウリング防止ゲートを使っている
      ducking: false, // いま共有音を止めている
      available: true,
    };
  }

  init() {
    if (this.ctx) return;
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.ctx = ctx;
    this.bus = ctx.createGain(); // 全員の声の合計（音量調整の前）
    this.monitor = ctx.createGain(); // ホストのスピーカーへ（音量）
    this.monitor.gain.value = this.volume;
    this.bus.connect(this.monitor);
    this.monitor.connect(ctx.destination);
    this.pilotBus = ctx.createGain(); // テスト音の出口（声と同じ再生デバイスへ。音量つまみは通さない）
    this.pilotBus.connect(ctx.destination);
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 1024;
    this.bus.connect(this.meter);
    this.meterBuf = new Float32Array(this.meter.fftSize);
    this.spectrum = ctx.createAnalyser(); // 動作確認用
    this.spectrum.fftSize = 8192;
    this.spectrum.smoothingTimeConstant = 0;
    this.bus.connect(this.spectrum);
    this.ready = ctx.audioWorklet
      ? ctx.audioWorklet.addModule('/gate-worklet.js').then(() => true, (e) => { console.warn(e); return false; })
      : Promise.resolve(false);
    this.ready.then((ok) => { this.guard.available = ok; });
    if (this.sinkId && ctx.setSinkId) ctx.setSinkId(this.sinkId).catch(() => { this.sinkId = ''; });
  }

  // ブラウザ版では、最初のクリックまで音が止められているので起こす
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  // 届いている声の大きさ（0〜1 ＝ -60dB〜0dB。音量つまみの影響は受けない）
  level() {
    if (!this.meter) return 0;
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    for (const v of this.meterBuf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / this.meterBuf.length) || 1e-8);
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  // ---------- 声の受け取りと配り直し ----------

  // その参加者へ返す音声（自分以外の全員の声）
  out(id) {
    this.init();
    let o = this.outbound.get(id);
    if (!o) {
      const dest = new MediaStreamAudioDestinationNode(this.ctx, { channelCount: 1 });
      o = { dest, stream: dest.stream, track: dest.stream.getAudioTracks()[0] };
      this.outbound.set(id, o);
      for (const [other, inn] of this.inbound) if (other !== id) inn.src.connect(dest);
    }
    return o;
  }

  // 参加者から届く声のトラックをつなぐ
  attachIn(id, track) {
    this.init();
    this.detachIn(id);
    const stream = new MediaStream([track]);
    // 受信した音声は、どこかの再生要素につないでおかないと流れてこないことがあるため、無音の要素にもつなぐ
    const keep = new Audio();
    keep.muted = true;
    keep.srcObject = stream;
    keep.play().catch(() => {});
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.bus);
    for (const [other, o] of this.outbound) if (other !== id) src.connect(o.dest);
    this.inbound.set(id, { src, keep, stream });
  }

  detachIn(id) {
    const inn = this.inbound.get(id);
    if (!inn) return;
    try { inn.src.disconnect(); } catch {}
    inn.keep.srcObject = null;
    this.inbound.delete(id);
  }

  // 参加者が退出した
  removePeer(id) {
    this.detachIn(id);
    const o = this.outbound.get(id);
    if (!o) return;
    for (const inn of this.inbound.values()) {
      try { inn.src.disconnect(o.dest); } catch {}
    }
    o.track.stop();
    this.outbound.delete(id);
  }

  setVolume(v) {
    this.volume = v;
    if (this.monitor) this.monitor.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // 声を鳴らす再生デバイスを変える（'' で既定のデバイス）
  async setSink(id) {
    this.sinkId = id || '';
    let ok = true;
    if (this.ctx && this.ctx.setSinkId) {
      try {
        await this.ctx.setSinkId(this.sinkId);
      } catch (e) {
        console.warn(e);
        ok = false;
        this.sinkId = '';
        try { await this.ctx.setSinkId(''); } catch {}
      }
    }
    this.retest(); // 出力先が変わると、回り込むかどうかも変わる
    return ok;
  }

  // ---------- ハウリング防止 ----------

  // 共有する音声トラックを登録する（共有していない時は null）
  async setShare(track, kind) {
    this.init();
    this.testSeq++;
    this.clearShare();
    const g = this.guard;
    Object.assign(g, {
      kind: track ? kind : 'none', restricted: false, plain: false, testing: false, tested: false, pilot: false, delay: 0, ducking: false,
    });
    if (!track) {
      this.updateGuard();
      return;
    }
    // 取り込み方を読み取る。PCの音声の取り込みには3通りある：
    //   loopbackWithoutChrome … このアプリの音を除いたPCの音（Windows 11）→ 回り込まない
    //   loopback              … PCで鳴っている音すべて（Windows 10 など）→ 同じ再生デバイスで声を鳴らせば必ず回り込む
    //   それ以外（タブの音など）… テスト音で実測して判断する
    const st = typeof track.getSettings === 'function' ? track.getSettings() : {};
    const dev = String(st.deviceId || '');
    g.restricted = kind === 'system' && (st.restrictOwnAudio === true || dev === 'loopbackWithoutChrome');
    g.plain = kind === 'system' && !g.restricted && /^loopback(WithMute)?$/.test(dev);

    const ctx = this.ctx;
    const sh = { raw: track };
    this.share = sh;
    sh.src = ctx.createMediaStreamSource(new MediaStream([track]));
    sh.analyser = ctx.createAnalyser();
    sh.analyser.fftSize = 8192; // 細かく刻むほど、音楽の高音に埋もれたテスト音も見つけやすい
    sh.analyser.smoothingTimeConstant = 0;
    sh.src.connect(sh.analyser);
    const ok = await this.ready;
    if (this.share !== sh) return;
    if (ok) {
      try {
        // 共有音声 → ゲート → 参加者へ送る用のトラック（回り込む環境でだけ、こちらを送る）
        sh.gate = new AudioWorkletNode(ctx, 'sidechain-gate', {
          numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
        });
        sh.src.connect(sh.gate, 0, 0);
        this.monitor.connect(sh.gate, 0, 1);
        sh.dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 2 });
        sh.gate.connect(sh.dest);
        sh.gated = sh.dest.stream.getAudioTracks()[0];
        sh.gate.port.onmessage = (e) => {
          if (this.share !== sh) return;
          g.ducking = !!(e.data && e.data.ducking);
          this.onChange();
        };
      } catch (e) {
        console.warn(e);
        sh.gate = null;
        g.available = false;
      }
    }
    this.updateGuard();
    this.testLeak();
  }

  clearShare() {
    const sh = this.share;
    this.share = {};
    try { if (sh.src) sh.src.disconnect(); } catch {}
    try {
      if (sh.gate) {
        this.monitor.disconnect(sh.gate);
        sh.gate.disconnect();
      }
    } catch {}
    if (sh.gated) sh.gated.stop();
  }

  // 参加者へ送る共有音声（ハウリング防止が有効な時は、ゲートを通したもの）
  shareTrack() {
    const sh = this.share;
    if (!sh.raw) return null;
    return this.guard.active && sh.gated ? sh.gated : sh.raw;
  }

  setMode(mode) {
    this.guard.mode = ['auto', 'on', 'off'].includes(mode) ? mode : 'auto';
    this.updateGuard();
  }

  retest() {
    if (!this.share.raw) return;
    this.guard.tested = false;
    this.guard.pilot = false;
    this.updateGuard();
    this.testLeak();
  }

  updateGuard() {
    const g = this.guard;
    const sh = this.share;
    // PCの音すべてを取り込んでいて（Windows 10 など）、同じ既定の再生デバイスで声を鳴らしていれば、確実に回り込む
    const certain = g.plain && this.sinkId === '';
    g.leak = g.kind !== 'none' && (g.pilot || certain);
    const want = g.kind !== 'none' && !!sh.gate && (g.mode === 'on' || (g.mode === 'auto' && g.leak));
    if (sh.gate) {
      // 声が止んでも、回り込みが届き終わるまでは閉じたままにする
      sh.gate.port.postMessage({ enabled: want, holdMs: Math.min(1200, Math.max(400, g.delay + 300)) });
    }
    const changed = want !== g.active;
    g.active = want;
    if (!want) g.ducking = false;
    if (changed) this.onShareTrack();
    this.onChange();
  }

  // 回り込みの実測：声と同じ出力先にテスト音を出し、共有音声に現れるかを見る
  async testLeak(attempt = 1) {
    const sh = this.share;
    const g = this.guard;
    if (!sh.analyser) return;
    const seq = ++this.testSeq;
    g.testing = true;
    this.onChange();
    await sleep(400); // 取り込みが安定するのを待つ
    if (seq !== this.testSeq || this.share !== sh) return;
    const res = await this.pilot(sh.analyser);
    if (seq !== this.testSeq || this.share !== sh) return;
    g.testing = false;
    g.tested = true;
    g.pilot = res.detected;
    g.delay = res.delay;
    this.updateGuard();
    // 大きな音が鳴っている最中だと、テスト音が埋もれて見逃すことがある。見つからなかった時は少し置いて確かめ直す
    if (!res.detected && res.loud && attempt < 3) {
      setTimeout(() => {
        if (seq === this.testSeq && this.share === sh) this.testLeak(attempt + 1);
      }, 15000);
    }
  }

  async pilot(an) {
    const ctx = this.ctx;
    try { await ctx.resume(); } catch {}
    const binHz = ctx.sampleRate / an.fftSize;
    const bins = PILOT_FREQS.map((f) => Math.round(f / binHz));
    const lead = 0.05;
    const t0 = ctx.currentTime + lead;
    bins.forEach((k, i) => {
      const start = t0 + i * PILOT_BURST;
      const osc = ctx.createOscillator();
      osc.frequency.value = k * binHz; // 解析の刻みにぴったり合わせる
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(PILOT_AMP, start + 0.01);
      g.gain.setValueAtTime(PILOT_AMP, start + PILOT_BURST - 0.01);
      g.gain.linearRampToValueAtTime(0, start + PILOT_BURST);
      osc.connect(g);
      g.connect(this.pilotBus); // 音量つまみは通さない（つまみが0でも経路は確かめる）
      osc.start(start);
      osc.stop(start + PILOT_BURST + 0.02);
    });

    const buf = new Float32Array(an.frequencyBinCount);
    // その高さだけが周りより際立っているか（音楽の高音と区別する）
    const stands = (k) => {
      let peak = -Infinity;
      for (let i = k - 2; i <= k + 2; i++) peak = Math.max(peak, buf[i]);
      const around = [];
      for (let i = k - 24; i <= k + 24; i++) if (Math.abs(i - k) >= 8) around.push(buf[i]);
      around.sort((x, y) => x - y);
      return peak > -95 && peak - around[around.length >> 1] > 13;
    };
    // 「1音目だけが鳴っている時間」のあとに「2音目だけが鳴っている時間」が来た時だけ、回り込みありとする。
    // 両方が同時に鳴りっぱなし（音楽の倍音など）なら数えないので、共有している音そのものには反応しない
    const only = [[], []];
    const wave = new Float32Array(2048);
    let loudest = 0;
    const began = performance.now();
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        an.getFloatFrequencyData(buf);
        const t = performance.now() - began;
        const a = stands(bins[0]);
        const b = stands(bins[1]);
        if (a && !b) only[0].push(t);
        if (b && !a) only[1].push(t);
        an.getFloatTimeDomainData(wave); // テスト中に共有音がどれくらい大きかったか
        let sum = 0;
        for (const v of wave) sum += v * v;
        loudest = Math.max(loudest, Math.sqrt(sum / wave.length));
        if (t > (lead + PILOT_BURST * 2) * 1000 + 900) {
          clearInterval(timer);
          resolve();
        }
      }, 15);
    });
    const mid = (list) => list[list.length >> 1];
    const detected = only[0].length >= 4 && only[1].length >= 4 && mid(only[0]) < mid(only[1]);
    return {
      detected,
      delay: detected ? Math.max(0, Math.round(only[0][0] - lead * 1000)) : 0,
      loud: loudest > 0.02, // 約 -34dB より大きな音が鳴っていた
    };
  }

  // 動作確認用：指定した高さの成分の大きさ（dB）。which = 'voice'（届いた声の合計）/ 'share'（共有音声）
  debugBins(which, freqs) {
    const an = which === 'share' ? this.share.analyser : this.spectrum;
    if (!an) return null;
    const buf = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(buf);
    const binHz = this.ctx.sampleRate / an.fftSize;
    return freqs.map((f) => {
      const k = Math.round(f / binHz);
      return Math.round(Math.max(buf[k - 1], buf[k], buf[k + 1]));
    });
  }
}
