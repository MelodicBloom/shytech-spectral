// =====================================================================
// Shytech DSP core — pure, allocation-free-after-construction ES module.
// Imported by public/shytech-dsp-worklet.js (audio thread) and by the
// Node unit tests (tests/*.test.mjs). No Web Audio APIs in here.
// =====================================================================

// ---------------------------------------------------------------------
// Telemetry layout (Float32Array, shared via SharedArrayBuffer or posted)
// Keep in sync with src/telemetry.js (a unit test asserts this).
// ---------------------------------------------------------------------
export const T = Object.freeze({
  LOW: 0,          // 0..1  bass / chest band (20–250 Hz), lookahead-extrapolated
  MID: 1,          // 0..1  vocal core (250–2000 Hz)
  HIGH: 2,         // 0..1  inflection / sibilance (2–8 kHz)
  PITCH: 3,        // 0..1  log-mapped YIN pitch (80 Hz -> 0, 800 Hz -> 1)
  INFLECTION: 4,   // 0..1  high/mid brightness ratio
  RHYTHM: 5,       // 0..1  scaled positive spectral flux (syllable/onset energy)
  AUDIO_TIME: 6,   // s     AudioContext time this frame represents (+lookahead)
  PITCH_HZ: 7,     // Hz    smoothed YIN f0 (held through unvoiced gaps)
  PITCH_CLARITY: 8,// 0..1  1 - CMNDF minimum (voicing confidence)
  BEAT_PHASE: 9,   // 0..1  PLL beat phase (0 = on the beat), lookahead-advanced
  BPM: 10,         // BPM   PLL tempo (60..180)
  TEMPO_CONF: 11,  // 0..1  tempo-estimator periodicity confidence
  PLL_LOCK: 12,    // 0..1  PLL lock quality (1 = onsets land on predicted beats)
  BEAT_COUNT: 13,  // int   beats elapsed since start (as float)
  ONSET: 14,       // 0..1  onset pulse, 1 at detected onset, ~80 ms decay
  SEQ: 15,         // int   write sequence counter (wraps at 2^24)
});
export const TELEMETRY_SLOTS = 16;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
// one-pole coefficient for a time constant, given the update interval (fixes
// the "alpha independent of sampleRate/hop" bug)
export const onePoleAlpha = (dtSec, tauSec) => 1 - Math.exp(-dtSec / Math.max(tauSec, 1e-6));

// ---------------------------------------------------------------------
// Radix-2 in-place complex FFT with precomputed tables
// ---------------------------------------------------------------------
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    this.n = n;
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n >> 1);
    this.sin = new Float32Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }
  transform() {
    const { n, re, im, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------
// Multi-band analyser (AnalyserNode-compatible dB mapping) + spectral flux
// ---------------------------------------------------------------------
export class BandAnalyzer {
  constructor(sampleRate, { fftSize = 512, minDb = -100, maxDb = -30, smoothing = 0.5 } = {}) {
    this.sr = sampleRate;
    this.n = fftSize;
    this.mask = fftSize - 1;
    this.ring = new Float32Array(fftSize);
    this.w = 0;
    this.fft = new FFT(fftSize);
    this.win = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
    this.bins = fftSize >> 1;
    this.mag = new Float32Array(this.bins);       // smoothed linear magnitude
    this.level = new Float32Array(this.bins);     // smoothed, 0..1 (like getByteFrequencyData/255)
    this.raw = new Float32Array(this.bins);       // unsmoothed 0..1 (for flux)
    this.prevRaw = new Float32Array(this.bins);
    this.minDb = minDb; this.dbRange = maxDb - minDb;
    this.smoothing = smoothing;
    const binHz = sampleRate / fftSize;
    this.binHz = binHz;
    // Band edges [start, end) in bins. At 48 kHz/512: low 0–2, mid 3–21, high 22–85.
    const e0 = Math.max(0, Math.floor(20 / binHz));
    const e1 = Math.max(e0 + 1, Math.ceil(250 / binHz));
    const e2 = Math.max(e1 + 1, Math.ceil(2000 / binHz));
    const e3 = Math.min(this.bins, Math.max(e2 + 1, Math.ceil(8000 / binHz))); // exclusive
    this.edges = [e0, e1, e2, e3];
    this.low = 0; this.mid = 0; this.high = 0; this.flux = 0;
  }
  push(x) {
    this.ring[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  analyze() {
    const { n, mask, ring, win, fft, bins } = this;
    const re = fft.re, im = fft.im;
    // oldest -> newest
    for (let i = 0, j = this.w; i < n; i++, j = (j + 1) & mask) {
      re[i] = ring[j] * win[i];
      im[i] = 0;
    }
    fft.transform();
    const s = this.smoothing, inv = 1 / n;
    const [e0, e1, e2, e3] = this.edges;
    let low = 0, mid = 0, high = 0, flux = 0;
    for (let k = 0; k < bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * inv;
      this.mag[k] = s * this.mag[k] + (1 - s) * m;
      const lv = clamp01((20 * Math.log10(this.mag[k] + 1e-12) - this.minDb) / this.dbRange);
      const rw = clamp01((20 * Math.log10(m + 1e-12) - this.minDb) / this.dbRange);
      this.level[k] = lv;
      const d = rw - this.prevRaw[k];
      this.prevRaw[k] = rw;
      this.raw[k] = rw;
      if (k >= e0 && k < e1) low += lv;
      else if (k >= e1 && k < e2) { mid += lv; if (d > 0) flux += d; }
      else if (k >= e2 && k < e3) { high += lv; if (d > 0) flux += d; }
    }
    this.low = low / (e1 - e0);
    this.mid = mid / (e2 - e1);
    this.high = high / (e3 - e2);
    this.flux = flux / (e3 - e1); // mean positive flux over mid+high bins
  }
}

// ---------------------------------------------------------------------
// YIN pitch detector — hop-throttled, decimated, early-exit, allocation-free
// ---------------------------------------------------------------------
export class YinPitch {
  constructor(sampleRate, { minHz = 70, maxHz = 1000, threshold = 0.15, window = 512, rmsGate = 0.003 } = {}) {
    this.decim = Math.max(1, Math.round(sampleRate / 24000));
    this.sr = sampleRate / this.decim; // effective rate (~24 kHz)
    this.W = window;
    this.tauMin = Math.max(2, Math.floor(this.sr / maxHz));
    this.tauMax = Math.ceil(this.sr / minHz);
    this.span = this.W + this.tauMax + 1;
    let size = 1;
    while (size < this.span) size <<= 1;
    this.ring = new Float32Array(size);
    this.mask = size - 1;
    this.w = 0;
    this.buf = new Float32Array(this.span);
    this.d = new Float32Array(this.tauMax + 2);
    this.cm = new Float32Array(this.tauMax + 2);
    this.threshold = threshold;
    this.rmsGate = rmsGate;
    this.acc = 0; this.accN = 0;
    this.hz = 0; this.clarity = 0; this.voiced = false;
    this.lastOps = 0; // difference-function inner-loop iterations of the last detect() (cost metric)
  }
  push(x) {
    this.acc += x;
    if (++this.accN === this.decim) {
      this.ring[this.w] = this.acc / this.decim; // boxcar decimation
      this.w = (this.w + 1) & this.mask;
      this.acc = 0; this.accN = 0;
    }
  }
  /** Runs one YIN analysis over the most recent W + tauMax decimated samples. */
  detect() {
    const { buf, ring, mask, W, tauMin, tauMax, span, d, cm } = this;
    // FIX: read the circular buffer in chronological order (oldest -> newest)
    for (let i = 0, j = (this.w - span) & mask; i < span; i++, j = (j + 1) & mask) buf[i] = ring[j];
    let e = 0;
    for (let j = 0; j < W; j++) e += buf[j] * buf[j];
    this.lastOps = 0;
    if (Math.sqrt(e / W) < this.rmsGate) {
      this.voiced = false; this.clarity = 0;
      return 0;
    }
    d[0] = 0; cm[0] = 1;
    let running = 0, cand = -1, best = -1;
    let gMin = Infinity, gTau = -1;
    let ops = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = buf[j] - buf[j + tau];
        s += diff * diff;
      }
      ops += W;
      d[tau] = s;
      running += s;
      cm[tau] = running > 0 ? (s * tau) / running : 1;
      if (tau >= tauMin && cm[tau] < gMin) { gMin = cm[tau]; gTau = tau; }
      if (cand < 0) {
        if (tau > tauMin && cm[tau] < this.threshold) cand = tau;
      } else if (cm[tau] >= cm[tau - 1]) {
        best = tau - 1; // local minimum; cm[best+1] already computed
        break;
      }
    }
    this.lastOps = ops;
    if (best < 0) best = cand >= 0 ? cand : gTau;
    if (best < 1 || best >= tauMax) { this.voiced = false; this.clarity = 0; return 0; }
    // parabolic interpolation on the CMNDF around the minimum
    const a = cm[best - 1], b = cm[best], c = cm[best + 1];
    const den = a - 2 * b + c;
    const shift = Math.abs(den) > 1e-12 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
    const tauF = best + shift;
    this.clarity = clamp01(1 - b);
    this.voiced = b < 0.35;
    this.hz = this.voiced ? this.sr / tauF : this.hz;
    return this.voiced ? this.hz : 0;
  }
}

// ---------------------------------------------------------------------
// Onset picker: adaptive threshold on the flux envelope + refractory period
// ---------------------------------------------------------------------
export class OnsetDetector {
  constructor(frameRate, { k = 1.6, delta = 0.02, refractorySec = 0.1, meanTauSec = 0.5 } = {}) {
    this.k = k; this.delta = delta;
    this.refractory = Math.round(refractorySec * frameRate);
    this.alpha = onePoleAlpha(1 / frameRate, meanTauSec);
    this.mean = 0; this.above = false; this.since = 1e9;
  }
  process(odf) {
    this.since++;
    const thresh = this.mean * this.k + this.delta;
    let onset = 0;
    const isAbove = odf > thresh;
    if (isAbove && !this.above && this.since >= this.refractory) {
      onset = clamp01((odf - thresh) / (thresh + 1e-6));
      if (onset < 0.05) onset = 0.05;
      this.since = 0;
    }
    this.above = isAbove;
    this.mean += this.alpha * (odf - this.mean); // update after test so a hit doesn't mask itself
    return onset;
  }
}

// ---------------------------------------------------------------------
// Tempo estimator: autocorrelation of the onset envelope, 60–180 BPM,
// harmonic-sum + log-Gaussian tempo prior, parabolic lag refinement.
// ---------------------------------------------------------------------
export class TempoEstimator {
  constructor(frameRate, { minBpm = 60, maxBpm = 180, windowSec = 6, updateSec = 0.5, priorBpm = 120, priorOct = 1.0 } = {}) {
    this.fr = frameRate;
    this.N = Math.round(windowSec * frameRate);
    this.ring = new Float32Array(this.N);
    this.lin = new Float32Array(this.N);
    this.w = 0; this.filled = 0;
    this.lagMin = Math.max(2, Math.floor((60 * frameRate) / maxBpm));
    this.lagMax = Math.ceil((60 * frameRate) / minBpm);
    this.maxLag = Math.min(this.N - 1, 2 * (this.lagMax + 1));
    this.acf = new Float32Array(this.maxLag + 1);
    this.score = new Float32Array(this.lagMax + 2);
    this.prior = new Float32Array(this.lagMax + 2);
    for (let l = 1; l <= this.lagMax + 1; l++) {
      const o = Math.log2((60 * frameRate) / l / priorBpm) / priorOct;
      this.prior[l] = Math.exp(-0.5 * o * o);
    }
    this.minBpm = minBpm; this.maxBpm = maxBpm;
    this.updateFrames = Math.max(1, Math.round(updateSec * frameRate));
    this.since = 0;
    this.bpm = 0; this.rawBpm = 0; this.confidence = 0;
    this.pending = 0; this.pendingCount = 0;
  }
  /** push one onset-envelope sample; returns true when a new estimate was computed */
  push(odf) {
    this.ring[this.w] = odf;
    this.w = (this.w + 1) % this.N;
    if (this.filled < this.N) this.filled++;
    if (++this.since < this.updateFrames || this.filled < Math.min(this.N, 2 * this.lagMax + 2)) return false;
    this.since = 0;
    this.compute();
    return true;
  }
  compute() {
    const { N, ring, lin, acf, score, prior, lagMin, lagMax } = this;
    const count = this.filled;
    const start = count < N ? 0 : this.w;
    let mean = 0;
    for (let i = 0; i < count; i++) { const v = ring[(start + i) % N]; lin[i] = v; mean += v; }
    mean /= count;
    for (let i = 0; i < count; i++) lin[i] -= mean;
    const maxLag = Math.min(this.maxLag, count - 1);
    // r(0)
    let r0 = 0;
    for (let i = 0; i < count; i++) r0 += lin[i] * lin[i];
    r0 /= count;
    acf[0] = r0;
    if (r0 < 1e-9) { this.confidence *= 0.8; return; }
    for (let l = lagMin - 1; l <= maxLag; l++) {
      let s = 0;
      for (let i = l; i < count; i++) s += lin[i] * lin[i - l];
      acf[l] = s / (count - l); // unbiased
    }
    let best = -1, bestScore = -Infinity;
    for (let l = lagMin - 1; l <= lagMax + 1; l++) {
      const h = 2 * l <= maxLag ? acf[2 * l] : 0;
      score[l] = (acf[l] + 0.5 * h) * prior[l];
      if (l >= lagMin && l <= lagMax && score[l] > bestScore) { bestScore = score[l]; best = l; }
    }
    if (best < 0) return;
    const a = score[best - 1], b = score[best], c = score[best + 1];
    const den = a - 2 * b + c;
    const shift = Math.abs(den) > 1e-12 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
    const bpm = clamp((60 * this.fr) / (best + shift), this.minBpm, this.maxBpm);
    const periodicity = clamp01(acf[best] / r0);
    this.rawBpm = bpm;
    this.confidence += 0.4 * (periodicity - this.confidence);
    if (this.bpm === 0 || Math.abs(Math.log2(bpm / this.bpm)) < 0.04) {
      this.bpm = this.bpm === 0 ? bpm : this.bpm + 0.35 * (bpm - this.bpm);
      this.pendingCount = 0;
    } else {
      // tempo change must persist for 3 updates (~1.5 s) before we switch
      if (this.pendingCount > 0 && Math.abs(Math.log2(bpm / this.pending)) < 0.04) this.pendingCount++;
      else { this.pending = bpm; this.pendingCount = 1; }
      if (this.pendingCount >= 3) { this.bpm = bpm; this.pendingCount = 0; }
    }
  }
}

// ---------------------------------------------------------------------
// Beat PLL: 2nd-order (PI) phase-locked loop on a free-running beat clock.
// ---------------------------------------------------------------------
export class BeatPLL {
  constructor({ initBpm = 120, kp = 0.25, ki = 0.05, window = 0.3, tempoPull = 0.2, acquireKp = 0.6, minBpm = 60, maxBpm = 180 } = {}) {
    this.period = 60 / initBpm;
    this.phase = 0;
    this.beatCount = 0;
    this.lockErr = 0.5;
    this.t = 0; this.lastOnsetT = -1e9;
    this.kp = kp; this.ki = ki; this.window = window; this.tempoPull = tempoPull; this.acquireKp = acquireKp;
    this.minPeriod = 60 / maxBpm; this.maxPeriod = 60 / minBpm;
    this.lastErr = 0;
  }
  get bpm() { return 60 / this.period; }
  get lock() { return clamp01(1 - this.lockErr / 0.12); }
  configure(o) {
    for (const k of ["kp", "ki", "window", "tempoPull", "acquireKp"]) if (typeof o[k] === "number") this[k] = o[k];
  }
  advance(dt) {
    this.t += dt;
    this.phase += dt / this.period;
    while (this.phase >= 1) { this.phase -= 1; this.beatCount++; }
    // no onsets for > 4 beats: lock quality slowly drains
    if (this.t - this.lastOnsetT > 4 * this.period) this.lockErr += Math.min(1, dt * 0.5) * (0.5 - this.lockErr);
  }
  /** call at the moment an onset is detected */
  onset(strength = 1) {
    const e = this.phase >= 0.5 ? this.phase - 1 : this.phase; // + => onset after predicted beat
    const acquiring = this.lock < 0.3;
    const win = acquiring ? 0.5 : this.window;
    this.lastOnsetT = this.t;
    if (Math.abs(e) > win) {           // off-beat / syncopated onset: ignore, small lock penalty
      this.lockErr += 0.03 * (0.5 - this.lockErr);
      return;
    }
    const w = clamp(strength, 0.25, 1);
    const kp = (acquiring ? Math.max(this.kp, this.acquireKp) : this.kp) * w;
    this.phase -= kp * e;               // proportional: slide phase toward the onset
    if (this.phase < 0) { this.phase += 1; this.beatCount--; }
    else if (this.phase >= 1) { this.phase -= 1; this.beatCount++; }
    this.period = clamp(this.period * (1 + this.ki * w * e), this.minPeriod, this.maxPeriod); // integral: retune period
    this.lockErr += 0.15 * (Math.abs(e) - this.lockErr);
    this.lastErr = e;
  }
  /** pull the free-running period toward the autocorrelation tempo */
  setTempo(bpm, confidence) {
    if (!(bpm > 0) || confidence < 0.15) return;
    const target = 60 / bpm;
    const ratio = target / this.period;
    if (ratio > 0.8 && ratio < 1.25) this.period += this.tempoPull * confidence * (target - this.period);
    else if (this.lock < 0.3 && confidence > 0.4) this.period = target; // re-acquire at new tempo
    this.period = clamp(this.period, this.minPeriod, this.maxPeriod);
  }
}

// ---------------------------------------------------------------------
// Full pipeline: per-quantum process(), hop-scheduled FFT and YIN,
// 4-slot snapshot ring for derivative extrapolation, telemetry writer.
// ---------------------------------------------------------------------
const H = 6; // snapshot fields: low, mid, high, inflection, rhythm, pitchNorm
export class ShytechDSP {
  constructor(sampleRate, o = {}) {
    this.sr = sampleRate;
    this.quantum = o.quantum ?? 128;
    this.fftHopQuanta = o.fftHopQuanta ?? 2; // 256 samples -> 187.5 frames/s @48k
    this.yinHopQuanta = o.yinHopQuanta ?? 4; // 512 samples -> 93.75 detections/s @48k
    this.lookaheadSec = (o.lookaheadMs ?? 0) / 1000;
    this.frameDt = (this.quantum * this.fftHopQuanta) / sampleRate;
    this.yinDt = (this.quantum * this.yinHopQuanta) / sampleRate;
    this.frameRate = 1 / this.frameDt;
    this.bands = new BandAnalyzer(sampleRate, { fftSize: o.fftSize ?? 512 });
    this.yin = new YinPitch(sampleRate, o.yin);
    this.onsets = new OnsetDetector(this.frameRate, o.onset);
    this.tempo = new TempoEstimator(this.frameRate, o.tempo);
    this.pll = new BeatPLL(o.pll);
    this.fluxGain = o.fluxGain ?? 6;
    this.q = 0;
    this.hist = new Float32Array(4 * H);
    this.histT = new Float64Array(4);
    this.head = 0; this.frames = 0;
    this.pitchHz = 0; this.pitchNorm = 0; this.clarity = 0;
    this.pitchAlpha = onePoleAlpha(this.yinDt, 0.03);
    this.onsetPulse = 0;
    this.onsetDecay = Math.exp(-this.frameDt / 0.08);
    this.time = 0;
    this.seq = 0;
    this.onsetCount = 0;
    this.lastOnsetTime = -1e9;
    this.yinHops = 0; this.yinRuns = 0; this.yinSkipped = 0; this.yinOps = 0; // cost counters
    this.yinSpanSec = (this.yin.span * this.yin.decim) / sampleRate + this.frameDt;
  }
  configure(c = {}) {
    if (typeof c.lookaheadMs === "number") this.lookaheadSec = c.lookaheadMs / 1000;
    if (c.pll) this.pll.configure(c.pll);
  }
  /** block: Float32Array (mono, usually 128). currentTime: AudioContext time of block start */
  process(block, currentTime) {
    const b = this.bands, y = this.yin;
    for (let i = 0; i < block.length; i++) { const x = block[i]; b.push(x); y.push(x); }
    this.q++;
    const tEnd = currentTime + block.length / this.sr;
    if (this.q % this.fftHopQuanta === 0) this._frame(tEnd);
    if (this.q % this.yinHopQuanta === 0) this._pitch();
  }
  _pitch() {
    // Skip YIN entirely when its result would be discarded or is very likely unvoiced:
    //  1. transient guard: a broadband onset (click, plosive) is inside the YIN window -> the f0
    //     would be confident-but-wrong, so hold the previous pitch and don't spend the cycles;
    //  2. RMS gate inside detect() (silence costs ~W multiply-adds, no difference function);
    //  3. while unvoiced (noise, breath, consonants), run at half rate until voicing returns.
    this.yinHops++;
    if (this.time - this.lastOnsetTime < this.yinSpanSec) { this.yinSkipped++; return; }
    if (!this.yin.voiced && (this.yinHops & 1)) { this.yinSkipped++; return; }
    const hz = this.yin.detect();
    this.yinRuns++;
    this.yinOps += this.yin.lastOps;
    this.clarity = this.yin.clarity;
    if (hz > 0) {
      // smooth in log-frequency so glides stay continuous
      const target = Math.log2(hz);
      const cur = this.pitchHz > 0 ? Math.log2(this.pitchHz) : target;
      this.pitchHz = Math.pow(2, cur + this.pitchAlpha * (target - cur));
      this.pitchNorm = clamp01(Math.log2(this.pitchHz / 80) / Math.log2(10));
    }
  }
  _frame(t) {
    const b = this.bands;
    b.analyze();
    const low = b.low, mid = b.mid, high = b.high, flux = b.flux;
    const inflection = mid > 0.05 ? Math.min((high / (mid + 0.15)) * 0.65, 1) : 0;
    const rhythm = Math.min(flux * this.fluxGain, 1);
    this.onsetPulse *= this.onsetDecay;
    this.pll.advance(this.frameDt);
    const on = this.onsets.process(flux);
    if (on > 0) { this.pll.onset(on); this.onsetPulse = 1; this.onsetCount++; this.lastOnsetTime = t; }
    if (this.tempo.push(flux)) this.pll.setTempo(this.tempo.bpm, this.tempo.confidence);
    // FIX: snapshot ring — advance head then overwrite the OLDEST slot; prev/prev2 are read relative to head
    this.head = (this.head + 1) & 3;
    const o = this.head * H, h = this.hist;
    h[o] = low; h[o + 1] = mid; h[o + 2] = high; h[o + 3] = inflection; h[o + 4] = rhythm; h[o + 5] = this.pitchNorm;
    this.histT[this.head] = t;
    this.frames++;
    this.time = t;
  }
  /** Writes the current (lookahead-extrapolated) state into a telemetry Float32Array. */
  writeTelemetry(out) {
    const h = this.hist, c = this.head * H;
    const pIdx = (this.head + 2) & 3; // two frames back: less noisy derivative than 1-frame diff
    const p = pIdx * H;
    const haveHist = this.frames >= 3;
    const dt = haveHist ? Math.max(this.histT[this.head] - this.histT[pIdx], 1e-3) : 1;
    const la = this.lookaheadSec;
    const ex = (i) => {
      const cur = h[c + i];
      if (!haveHist || la <= 0) return cur;
      const step = clamp(((cur - h[p + i]) / dt) * la, -0.25, 0.25); // clamp overshoot
      return clamp01(cur + step);
    };
    out[T.LOW] = ex(0);
    out[T.MID] = ex(1);
    out[T.HIGH] = ex(2);
    out[T.INFLECTION] = ex(3);
    out[T.RHYTHM] = ex(4);
    out[T.PITCH] = ex(5);
    out[T.AUDIO_TIME] = this.time + la;
    out[T.PITCH_HZ] = this.pitchHz;
    out[T.PITCH_CLARITY] = this.clarity;
    const pll = this.pll;
    let ph = pll.phase + la / pll.period;
    ph -= Math.floor(ph);
    out[T.BEAT_PHASE] = ph;
    out[T.BPM] = pll.bpm;
    out[T.TEMPO_CONF] = this.tempo.confidence;
    out[T.PLL_LOCK] = pll.lock;
    out[T.BEAT_COUNT] = pll.beatCount;
    out[T.ONSET] = this.onsetPulse;
    this.seq = (this.seq + 1) & 0xffffff;
    out[T.SEQ] = this.seq; // written last
  }
}
