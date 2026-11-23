import test from "node:test";
import assert from "node:assert/strict";
import { YinPitch, TempoEstimator, BeatPLL, ShytechDSP, BandAnalyzer, T, TELEMETRY_SLOTS } from "../public/dsp-core.js";
import { T as TMain, TELEMETRY_SLOTS as SLOTS_MAIN } from "../src/telemetry.js";

const SR = 48000;

test("telemetry layout matches between worklet core and main thread", () => {
  assert.equal(TELEMETRY_SLOTS, SLOTS_MAIN);
  assert.deepEqual({ ...T }, { ...TMain });
});

test("band edges at 48 kHz / 512 match the spec (low 0-2, mid 3-21, high 22-85)", () => {
  const b = new BandAnalyzer(SR, { fftSize: 512 });
  assert.deepEqual(b.edges, [0, 3, 22, 86]);
  console.log("  band edges [start,end):", b.edges.join(", "));
});

for (const f0 of [220, 110, 440]) {
  test(`YIN: synthetic ${f0} Hz sine -> ~${f0} Hz`, () => {
    const yin = new YinPitch(SR);
    const n = SR / 2;
    let hz = 0, maxOps = 0;
    for (let i = 0; i < n; i++) {
      yin.push(0.5 * Math.sin((2 * Math.PI * f0 * i) / SR));
      if (i % 512 === 511 && i > 4096) { hz = yin.detect(); maxOps = Math.max(maxOps, yin.lastOps); }
    }
    const worst = yin.W * yin.tauMax;
    console.log(`  f0=${f0} -> ${hz.toFixed(3)} Hz, clarity=${yin.clarity.toFixed(3)}, ops/detect=${maxOps} (worst-case bound ${worst})`);
    assert.ok(Math.abs(hz - f0) / f0 < 0.01, `got ${hz}`);
    assert.ok(maxOps <= worst);
  });
}

test("YIN: silence is gated (no work, unvoiced)", () => {
  const yin = new YinPitch(SR);
  for (let i = 0; i < 4096; i++) yin.push(0);
  assert.equal(yin.detect(), 0);
  assert.equal(yin.lastOps, 0);
});

test("TempoEstimator: 120 BPM onset train -> ~120 BPM", () => {
  const fr = SR / 256;
  const te = new TempoEstimator(fr);
  const period = 0.5;
  let lastBeat = -1;
  for (let i = 0; i < fr * 10; i++) {
    const t = i / fr;
    const beat = Math.floor(t / period);
    const v = beat !== lastBeat ? 1 : 0.02 * Math.random();
    lastBeat = beat;
    te.push(v);
  }
  console.log(`  tempo=${te.bpm.toFixed(2)} BPM raw=${te.rawBpm.toFixed(2)} conf=${te.confidence.toFixed(3)}`);
  assert.ok(Math.abs(te.bpm - 120) < 1.5);
  assert.ok(te.confidence > 0.5);
});

test("BeatPLL: locks phase + period from a wrong start (109 BPM, phase 0.3)", () => {
  const fr = SR / 256, dt = 1 / fr;
  const pll = new BeatPLL({ initBpm: 109 });
  pll.phase = 0.3;
  const period = 0.5;
  let next = 0.25, errs = [];
  for (let i = 0; i < fr * 20; i++) {
    const t = i * dt;
    pll.advance(dt);
    if (t >= next) { pll.onset(1); errs.push(pll.lastErr); next += period; }
  }
  const tail = errs.slice(-10).map(Math.abs);
  const maxTail = Math.max(...tail);
  console.log(`  pll bpm=${pll.bpm.toFixed(2)} lock=${pll.lock.toFixed(3)} last-10 |phase err| max=${maxTail.toFixed(4)} (first err ${errs[0].toFixed(3)})`);
  assert.ok(Math.abs(pll.bpm - 120) < 1);
  assert.ok(maxTail < 0.03);
  assert.ok(pll.lock > 0.7);
});

test("ShytechDSP end-to-end: 220 Hz tone + 120 BPM clicks -> pitch ~220, tempo ~120, PLL locked on clicks", () => {
  const dsp = new ShytechDSP(SR, { lookaheadMs: 0 });
  const out = new Float32Array(TELEMETRY_SLOTS);
  const block = new Float32Array(128);
  const clickEvery = SR * 0.5;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let s = 0;
  const total = SR * 14;
  for (let q = 0; s < total; q++) {
    for (let i = 0; i < 128; i++, s++) {
      const k = s % clickEvery;
      const click = k < 480 ? rnd() * 0.8 * Math.exp(-k / 96) : 0;
      block[i] = 0.25 * Math.sin((2 * Math.PI * 220 * s) / SR) + click;
    }
    dsp.process(block, (s - 128) / SR);
    dsp.writeTelemetry(out);
  }
  const lag = dsp.pll.lastErr;
  console.log(`  pitch=${out[T.PITCH_HZ].toFixed(2)} Hz clarity=${out[T.PITCH_CLARITY].toFixed(2)} bpm=${out[T.BPM].toFixed(2)} tempoEst=${dsp.tempo.bpm.toFixed(2)} conf=${out[T.TEMPO_CONF].toFixed(3)} lock=${out[T.PLL_LOCK].toFixed(3)} lastPhaseErr=${lag.toFixed(4)} onsets=${dsp.onsetCount} beats=${out[T.BEAT_COUNT]}`);
  assert.ok(Math.abs(out[T.PITCH_HZ] - 220) < 4, "pitch");
  assert.ok(Math.abs(out[T.BPM] - 120) < 1.5, "bpm");
  assert.ok(out[T.PLL_LOCK] > 0.7, "lock");
  assert.ok(Math.abs(lag) < 0.03, "phase error");
  assert.ok(Math.abs(dsp.onsetCount - 28) <= 2, `onsets ${dsp.onsetCount}`);
});

test("ShytechDSP cost: per-quantum process time (budget 128/48000 s = 2.667 ms)", () => {
  const dsp = new ShytechDSP(SR, {});
  const out = new Float32Array(TELEMETRY_SLOTS);
  const block = new Float32Array(128);
  let s = 0;
  const N = 375 * 20; // 20 s of audio
  const t0 = performance.now();
  for (let q = 0; q < N; q++) {
    for (let i = 0; i < 128; i++, s++) block[i] = 0.3 * Math.sin((2 * Math.PI * 95 * s) / SR) + 0.05 * Math.sin(s * 0.37);
    dsp.process(block, s / SR);
    dsp.writeTelemetry(out);
  }
  const ms = performance.now() - t0;
  console.log(`  20 s audio in ${ms.toFixed(1)} ms -> ${(ms / N * 1000).toFixed(1)} µs/quantum avg (${(ms / 20000 * 100).toFixed(2)}% of real time)`);
  assert.ok(ms / N < 0.5);
});

test("ShytechDSP: pitch is not corrupted by clicks (transient guard), 330 Hz + 100 BPM noise clicks", () => {
  const dsp = new ShytechDSP(SR), out = new Float32Array(TELEMETRY_SLOTS), b = new Float32Array(128);
  const per = Math.round((SR * 60) / 100);
  let s = 0, seed = 7, lo = Infinity, hi = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let q = 0; q < 375 * 8; q++) {
    for (let i = 0; i < 128; i++, s++) {
      const k = s % per;
      b[i] = 0.2 * Math.sin((2 * Math.PI * 330 * s) / SR) + (k < 490 ? rnd() * 0.7 * Math.exp(-k / 98) : 0);
    }
    dsp.process(b, s / SR);
    if (q > 375 * 2) { dsp.writeTelemetry(out); lo = Math.min(lo, out[T.PITCH_HZ]); hi = Math.max(hi, out[T.PITCH_HZ]); }
  }
  console.log(`  pitch range under clicks: ${lo.toFixed(2)}–${hi.toFixed(2)} Hz, tempo ${out[T.BPM].toFixed(2)} BPM`);
  assert.ok(lo > 325 && hi < 335);
  assert.ok(Math.abs(out[T.BPM] - 100) < 1.5);
});
