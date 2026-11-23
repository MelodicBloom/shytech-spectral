// Main-thread fallback engine (the original AnalyserNode version, fixed).
// Used only when AudioWorklet is unavailable. Bands/inflection/rhythm only:
// pitch (YIN) and the beat PLL live in the worklet.
import { T } from "../telemetry.js";

export class PredictiveAudioEngine {
  constructor(analyser, lookaheadMs = 24) {
    this.analyser = analyser;
    this.lookaheadSec = lookaheadMs / 1000;
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    // FIX: band edges derived from the real sampleRate (44.1k devices no longer shift bands)
    this.e = [0, Math.ceil(250 / binHz), Math.ceil(2000 / binHz), Math.min(analyser.frequencyBinCount, Math.ceil(8000 / binHz))];
    this.history = Array.from({ length: 4 }, () => ({ time: 0, low: 0, mid: 0, high: 0, inflection: 0, rhythm: 0 }));
    this.head = 0;
    this.count = 0;
    this.prevMidEnergy = 0;
  }
  _bandAvg(a, b) {
    let s = 0;
    for (let i = a; i < b; i++) s += this.freqData[i];
    return s / ((b - a) * 255);
  }
  /** writes into a telemetry Float32Array (same layout as the worklet) */
  sample(nowSec, out) {
    this.analyser.getByteFrequencyData(this.freqData);
    const [e0, e1, e2, e3] = this.e;
    const low = this._bandAvg(e0, e1), mid = this._bandAvg(e1, e2), high = this._bandAvg(e2, e3);
    const inflection = mid > 0.05 ? Math.min((high / (mid + 0.15)) * 0.65, 1) : 0;
    const rhythm = Math.min(Math.max(0, mid - this.prevMidEnergy) * 4.5, 1);
    this.prevMidEnergy = mid;
    this.head = (this.head + 1) % 4;               // overwrite the oldest slot
    const curr = this.history[this.head];
    Object.assign(curr, { time: nowSec, low, mid, high, inflection, rhythm });
    this.count++;
    const prev = this.history[(this.head + 2) % 4]; // 2 frames back
    const dt = Math.max(curr.time - prev.time, 1e-3);
    const ok = this.count >= 3;                       // FIX: no bogus velocity from the zeroed initial slots
    const ex = (k) => {
      if (!ok) return curr[k];
      const step = Math.max(-0.25, Math.min(0.25, ((curr[k] - prev[k]) / dt) * this.lookaheadSec));
      return Math.min(1, Math.max(0, curr[k] + step));
    };
    out[T.LOW] = ex("low"); out[T.MID] = ex("mid"); out[T.HIGH] = ex("high");
    out[T.INFLECTION] = ex("inflection"); out[T.RHYTHM] = ex("rhythm");
    out[T.AUDIO_TIME] = nowSec + this.lookaheadSec;
  }
}
