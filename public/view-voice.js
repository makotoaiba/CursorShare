// 参加者側のボイス処理：自分のマイクをホストへ送り、他の参加者の声を聞く
//
// マイクはブラウザのエコーキャンセルを有効にして取り込む。スピーカーから出た共有音や他の人の声を
// マイクが拾っても、送る前に取り除かれる（ハウリング防止）。それでも、できればヘッドホン推奨。

import { watchLevel } from '/common.js';

export const INSECURE_NOTE =
  'このURL（http）では、ブラウザの制限でマイクを使えません。ホストに「インターネット用URL」を送ってもらい、そちらから参加し直してください。';

export class ViewerVoice {
  // onState: マイクの状態・発言中かどうかが変わった / onLevel: 自分のマイクの音量 / onNotice: 利用者へのお知らせ
  constructor({ audioEl, onState, onLevel, onNotice }) {
    this.audio = audioEl;
    this.onState = onState || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onNotice = onNotice || (() => {});
    this.track = null;
    this.sender = null; // ホストへ声を送る口（接続のたびに差し替わる）
    this.deviceId = '';
    this.mic = this.available ? 'off' : 'na'; // off / on / muted / na
    this.speaking = false;
    this.busy = false;
    this.stopWatch = () => {};
    // 自動再生が止められた時は、次のクリックで鳴らし直す
    document.addEventListener('pointerdown', () => { if (this.audio.srcObject && this.audio.paused) this.play(); });
  }

  get available() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // ---------- 送る側（自分のマイク） ----------

  async enable(deviceId) {
    if (!this.available) {
      this.onNotice(INSECURE_NOTE);
      return false;
    }
    if (this.busy) return false;
    this.busy = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: true, // スピーカーの音を拾っても送り返さない
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const track = stream.getAudioTracks()[0];
      this.release();
      this.track = track;
      this.deviceId = deviceId || track.getSettings().deviceId || '';
      track.addEventListener('ended', () => {
        if (this.track !== track) return;
        this.release();
        this.set('off');
        this.onNotice('マイクが使えなくなりました（取り外された可能性があります）');
      });
      if (this.sender) await this.sender.replaceTrack(track).catch(() => {});
      this.watch();
      this.set('on');
      return true;
    } catch (e) {
      this.onNotice(
        e.name === 'NotAllowedError' ? 'マイクの使用が許可されませんでした。アドレスバーのマイクのアイコンから許可してください。'
          : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'マイクが見つかりません。接続を確認してください。'
            : `マイクを開けません：${e.message}`
      );
      return false;
    } finally {
      this.busy = false;
    }
  }

  // マイクを手放す（デバイスの使用をやめる）
  release() {
    this.stopWatch();
    this.stopWatch = () => {};
    if (this.track) this.track.stop();
    this.track = null;
    if (this.sender) this.sender.replaceTrack(null).catch(() => {});
    this.onLevel(0);
  }

  set(mic) {
    this.mic = mic;
    if (mic !== 'on') this.speaking = false;
    if (this.track) this.track.enabled = mic === 'on'; // ミュート中は無音を送る
    this.onState();
  }

  // ボタン：未使用→オン、オン⇔ミュート
  toggle() {
    if (this.mic === 'na') return this.onNotice(INSECURE_NOTE);
    if (this.mic === 'off') return this.enable(this.deviceId);
    return this.set(this.mic === 'on' ? 'muted' : 'on');
  }

  mute() {
    if (this.mic !== 'on') return false;
    this.set('muted');
    return true;
  }

  disable() {
    this.release();
    this.set(this.available ? 'off' : 'na');
  }

  // 音量から「発言中」を判定（声が止んでも少しの間は発言中のままにして、表示のちらつきを防ぐ）
  watch() {
    this.stopWatch();
    let quietSince = 0;
    this.stopWatch = watchLevel(this.track, (lv) => {
      const on = this.mic === 'on';
      this.onLevel(on ? lv : 0);
      const now = performance.now();
      let sp = this.speaking;
      if (!on) sp = false;
      else if (lv > 0.3) { // 約 -42dB より大きい
        sp = true;
        quietSince = 0;
      } else if (sp && lv < 0.22) {
        if (!quietSince) quietSince = now;
        else if (now - quietSince > 450) sp = false;
      } else quietSince = 0;
      if (sp !== this.speaking) {
        this.speaking = sp;
        this.onState();
      }
    });
  }

  // 新しい接続の送信口にマイクをつなぐ（マイク未使用なら空のまま。後からオンにすればそのまま流れる）
  setSender(sender) {
    this.sender = sender;
    return sender ? sender.replaceTrack(this.track || null).catch(() => {}) : Promise.resolve();
  }

  async devices() {
    if (!this.available) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  }

  // ---------- 聞く側（他の参加者の声。自分の声は含まれない） ----------

  setRemote(track) {
    this.audio.srcObject = track ? new MediaStream([track]) : null;
    if (track) this.play();
  }

  play() {
    this.audio.play().catch(() => {});
  }

  setVolume(v) {
    this.audio.volume = Math.max(0, Math.min(1, v));
  }
}
