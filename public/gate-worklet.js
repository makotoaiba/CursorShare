// ハウリング防止ゲート（AudioWorklet：音声処理スレッドで動くので、画面が裏に回っても遅れない）
//
// 入力0 … 共有音声（PCの音・入力デバイス）
// 入力1 … ホストのスピーカーで鳴らしている参加者の声
// 出力  … 参加者の声が鳴っている間だけ無音にした共有音声
//
// 共有音声に参加者の声が回り込む環境では、声が鳴っている間（＋回り込みが届くまでの時間）
// 共有音を止めることで、参加者に自分の声が返ったり、二重に聞こえたりするのを防ぐ。

class SidechainGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.threshold = 0.005; // 声とみなす大きさ（RMS、約 -46dB）
    this.holdSamples = Math.round(sampleRate * 0.5); // 声が止んでから開くまで
    this.hold = 0;
    this.gain = 1;
    this.ducking = false;
    this.down = Math.exp(-1 / (sampleRate * 0.003)); // 閉じる：約3ms
    this.up = Math.exp(-1 / (sampleRate * 0.06)); // 開く：約60ms
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
      if (d.holdMs > 0) this.holdSamples = Math.round((sampleRate * d.holdMs) / 1000);
      if (d.threshold > 0) this.threshold = d.threshold;
      if (!this.enabled) this.hold = 0;
    };
  }

  process(inputs, outputs) {
    const main = inputs[0];
    const side = inputs[1];
    const out = outputs[0];
    const n = out[0].length;

    // 参加者の声が鳴っているか（ブロックごとの大きさで判定）
    let active = false;
    if (this.enabled && side && side[0]) {
      const ch = side[0];
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      active = Math.sqrt(sum / ch.length) > this.threshold;
    }
    if (active) this.hold = this.holdSamples;
    else if (this.hold > 0) this.hold -= n;

    const target = this.enabled && this.hold > 0 ? 0 : 1;
    const coef = target < this.gain ? this.down : this.up;
    for (let i = 0; i < n; i++) {
      this.gain = target + (this.gain - target) * coef;
      for (let c = 0; c < out.length; c++) {
        const src = main[c] || main[0];
        out[c][i] = src ? src[i] * this.gain : 0;
      }
    }

    const ducking = target === 0;
    if (ducking !== this.ducking) {
      this.ducking = ducking;
      this.port.postMessage({ ducking });
    }
    return true;
  }
}

registerProcessor('sidechain-gate', SidechainGate);
