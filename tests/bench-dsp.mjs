// Benchmark / evaluation harness (not part of `npm test`):
//   node tests/bench-dsp.mjs [path/to/dsp-core.js]
// 1) YIN work under different inputs; 2) onset-analysis config comparison (512/256 vs 1024/512).
import { pathToFileURL } from "node:url";
const corePath = process.argv[2] ? pathToFileURL(process.argv[2]).href : new URL("../public/dsp-core.js", import.meta.url).href;
const { ShytechDSP, T, TELEMETRY_SLOTS } = await import(corePath);
const SR = 48000;
let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function run(gen, secs, opts = {}, onQuantum) {
  seed = 12345;
  const dsp = new ShytechDSP(SR, { lookaheadMs: 0, ...opts });
  const out = new Float32Array(TELEMETRY_SLOTS), b = new Float32Array(128);
  // count YIN difference-function work regardless of core version
  let ops = 0, runs = 0;
  const det = dsp.yin.detect.bind(dsp.yin);
  dsp.yin.detect = () => { const r = det(); ops += dsp.yin.lastOps; runs++; return r; };
  const errs = [];
  const on = dsp.pll.onset.bind(dsp.pll);
  dsp.pll.onset = (s) => { on(s); errs.push({ t: dsp.pll.t, e: dsp.pll.lastErr }); };
  let s = 0, lockAt = null;
  const t0 = performance.now();
  for (let q = 0; s < secs * SR; q++) {
    for (let i = 0; i < 128; i++, s++) b[i] = gen(s);
    dsp.process(b, s / SR);
    if (q % 16 === 0) { dsp.writeTelemetry(out); if (lockAt === null && out[T.PLL_LOCK] > 0.7) lockAt = s / SR; onQuantum?.(dsp, out, s); }
  }
  const ms = performance.now() - t0;
  dsp.writeTelemetry(out);
  return { dsp, out, ops, runs, ms, lockAt, errs };
}

const tone = (f, a = 0.25) => (s) => a * Math.sin((2 * Math.PI * f * s) / SR);
const clicks = (bpm, amp = 0.8) => { const per = Math.round((SR * 60) / bpm); return (s) => { const k = s % per; return k < 480 ? rnd() * amp * Math.exp(-k / 96) : 0; }; };
const mix = (...g) => (s) => g.reduce((a, f) => a + f(s), 0);

console.log("== YIN work per 10 s of audio (difference-function multiply-adds) ==");
for (const [name, gen] of [
  ["220 Hz tone (voiced)", tone(220)],
  ["white noise 0.2 (unvoiced)", (s) => 0.2 * rnd()],
  ["silence", () => 0],
  ["220 Hz + 120 BPM clicks", mix(tone(220), clicks(120))],
]) {
  const r = run(gen, 10);
  console.log(`${name.padEnd(28)} yinRuns=${String(r.runs).padStart(4)}  Mops=${(r.ops / 1e6).toFixed(1).padStart(6)}  total DSP ${r.ms.toFixed(0)} ms (${(r.ms / 100).toFixed(2)}% RT)`);
}

console.log("\n== Onset analysis config: fftSize/hop ==");
const scenarios = [
  ["120 BPM clicks + 220 Hz", mix(tone(220), clicks(120))],
  ["100 BPM noisy clicks + 330 Hz", mix(tone(330, 0.2), clicks(100, 0.7))],
  ["90 BPM clicks", clicks(90)],
  ["150 BPM clicks + 0.05 noise", mix(clicks(150), (s) => 0.05 * rnd())],
];
const configs = [["512 win / 256 hop", { fftSize: 512, fftHopQuanta: 2 }], ["1024 win / 512 hop", { fftSize: 1024, fftHopQuanta: 4 }]];
const truth = [120, 100, 90, 150];
for (const [cname, cfg] of configs) {
  console.log(`-- ${cname}`);
  scenarios.forEach(([name, gen], i) => {
    const r = run(gen, 16, cfg);
    const tail = r.errs.filter((x) => x.t > 10).map((x) => Math.abs(x.e));
    const meanErr = tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
    console.log(`${name.padEnd(30)} bpm=${r.out[T.BPM].toFixed(2)} (err ${(r.out[T.BPM] - truth[i]).toFixed(2)})  conf=${r.out[T.TEMPO_CONF].toFixed(2)}  lock=${r.out[T.PLL_LOCK].toFixed(3)}  lock>0.7@${r.lockAt?.toFixed(2) ?? "never"}s  mean|phaseErr| t>10s=${meanErr.toFixed(4)}  onsets=${r.dsp.onsetCount ?? r.errs.length}/${Math.ceil(16 * truth[i] / 60)}  DSP ${r.ms.toFixed(0)} ms`);
  });
}
