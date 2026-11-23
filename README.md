# Shytech Spectral — AudioWorklet DSP + YIN pitch + Beat PLL (Vite + React + R3F)

```bash
npm install
npm run dev        # http://localhost:5173  (COOP/COEP headers on)
npm run build && npm run preview   # http://localhost:4173 (COOP/COEP headers on)
npm test           # Node unit tests for YIN, tempo estimator, PLL, full pipeline
```

Buttons: **Live mic**, **Test signal (120 BPM)** (220 Hz sine with a ±300-cent glide, plus a
sample-accurate 120 BPM click loop), **Audio file** (an `<audio>` element routed through the 24 ms
`DelayNode` lookahead). The HUD shows `crossOriginIsolated`, the telemetry path in use
(SharedArrayBuffer or postMessage), BPM, tempo confidence, PLL lock, beat phase, and pitch.
"PLL tunables" lets you change the PLL gains live.

## Layout

| file | role |
|---|---|
| `public/dsp-core.js` | All DSP (FFT, bands, YIN, onset, tempo, PLL, telemetry writer). Pure ES module, imported by the worklet **and** the Node tests |
| `public/shytech-dsp-worklet.js` | `AudioWorkletProcessor` wrapper: downmix, SAB / postMessage telemetry |
| `src/audio/graph.js` | AudioContext graph: sources → worklet (undelayed analysis) and → `DelayNode(24 ms)` → speakers; test signal; fallback engine |
| `src/engine/PredictiveAudioEngine.js` | Your original main-thread AnalyserNode engine (fixed). Used only when AudioWorklet is unavailable (bands only) |
| `src/components/scene/Scene.jsx` | Lazy-loaded R3F scene: full-screen quad, frame driver (demand loop, hidden-tab pause, idle throttle), adaptive DPR |
| `src/components/scene/shaders.js` | Per-fragment analytic height field + analytic gradient shading: bass swell, pitch-driven melody crest and hue, syllable punch, high shimmer, beat ring |
| `src/three-shim.js` | Narrow three.js re-export that R3F is redirected to so three can tree-shake (add classes here if you add new JSX elements) |
| `tests/bench-dsp.mjs` | DSP benchmark / onset-config evaluation (`node tests/bench-dsp.mjs`) |
| `src/components/Hud.jsx` | HUD, rendered once; a 10 Hz timer writes to the DOM through refs, with no React state |
| `src/telemetry.js` | Telemetry slot constants for the main thread (a test asserts they match the worklet's) |

## Telemetry layout (`Float32Array(16)`)

| slot | name | meaning |
|---|---|---|
| 0 | LOW | 0..1 bass 20–250 Hz (bins 0–2 @48k/512), lookahead-extrapolated |
| 1 | MID | 0..1 vocal core 250–2000 Hz (bins 3–21) |
| 2 | HIGH | 0..1 inflection/sibilance 2–8 kHz (bins 22–85) |
| 3 | PITCH | 0..1 log-mapped f0 (80 Hz → 0, 800 Hz → 1) |
| 4 | INFLECTION | 0..1 high/mid brightness ratio |
| 5 | RHYTHM | 0..1 scaled positive spectral flux (mid+high bins) |
| 6 | AUDIO_TIME | s, AudioContext time of the frame + lookahead |
| 7 | PITCH_HZ | Hz, smoothed YIN f0 (held through unvoiced gaps and transients) |
| 8 | PITCH_CLARITY | 0..1, 1 − CMNDF minimum |
| 9 | BEAT_PHASE | 0..1, PLL phase (0 = on the beat), advanced by lookahead |
| 10 | BPM | PLL tempo, 60–180 |
| 11 | TEMPO_CONF | 0..1, autocorrelation periodicity confidence |
| 12 | PLL_LOCK | 0..1, lock quality (1 = onsets land on predicted beats) |
| 13 | BEAT_COUNT | beats since start |
| 14 | ONSET | 0..1 onset pulse (1 at onset, ~80 ms decay) |
| 15 | SEQ | write counter (written last; wraps at 2^24) |

## Beat / tempo tracking

1. **Onset envelope**: mean positive spectral flux over mid+high bins, one value per FFT frame
   (512-pt FFT, hop 256 samples → 187.5 frames/s at 48 kHz).
2. **Onset picker**: adaptive threshold `mean·k + delta` (k = 1.6, delta = 0.02, mean τ = 0.5 s),
   rising-edge trigger with a 100 ms refractory period.
3. **Tempo estimator**: unbiased autocorrelation of the last 6 s of the envelope every 0.5 s over
   lags for 60–180 BPM. Score = `(r(L) + 0.5·r(2L)) × log-Gaussian prior` (centred on 120 BPM,
   1-octave width), with parabolic lag refinement. Confidence = r(L)/r(0), smoothed. A tempo change
   has to persist for 3 updates (about 1.5 s) before it is accepted.
4. **PLL** (second-order, PI): a free-running beat clock `phase += dt/period`. On each onset,
   phase error `e = wrap(phase)` ∈ (−0.5, 0.5]. Onsets with `|e| > window` are treated as
   off-beat and ignored. Otherwise the PLL applies `phase −= kp·e` and `period *= 1 + ki·e`
   (weighted by onset strength). The autocorrelation tempo pulls the period with
   `period += tempoPull·conf·(target − period)`. If the tempo is more than 25% away and the loop
   is unlocked, the period re-acquires directly. While `lock < 0.3`, acquisition mode uses
   `kp ≥ 0.6` and a ±0.5 window. Lock = `1 − EMA|e| / 0.12`. It drains after 4 beats with no onsets.

Tunables (`processorOptions.pll` or `port.postMessage({config:{pll:{...}}})`):
`kp` 0.25, `ki` 0.05, `window` 0.3, `tempoPull` 0.2, `acquireKp` 0.6, `initBpm` 120.

## Cross-origin isolation (SharedArrayBuffer)

`vite.config.js` sends these headers for both `server` and `preview`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If `window.crossOriginIsolated` is false, the worklet falls back to posting one reused
`Float32Array` at about 60 Hz. The HUD shows which path is active.

**Next.js** (`next.config.js` / `next.config.mjs`):

```js
const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};
export default nextConfig; // or module.exports = nextConfig
```

**Vercel** (`vercel.json`):

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

**COEP caveat:** under `require-corp`, every cross-origin subresource needs a
`Cross-Origin-Resource-Policy` header or CORS. drei's `<Environment preset="city">` downloads HDRs
from a remote CDN and can fail under COEP. This demo removes it (the shader is unlit). If you need
IBL, ship the `.hdr` locally (`<Environment files="/city.hdr" />`) or use `Lightformer`s. Remote
fonts, images, and analytics scripts have the same constraint. `credentialless` COEP is a
Chromium-only alternative.

## Latency model

- **Playback** (file, test signal): sources feed the worklet directly, and the speakers get the same
  signal through `DelayNode(24 ms)`. Analysis is therefore 24 ms + output latency ahead of what you
  hear. The worklet only extrapolates whatever the delay line does not already cover, which is
  usually nothing (lookahead clamped to 0).
- **Mic**: nothing plays back, so the engine extrapolates by `outputLatency + baseLatency + 16 ms`.
  It uses the derivative across the last two analysis frames from a 4-slot snapshot ring, and
  each step is clamped to ±0.25.

## Performance architecture

- **Bundle:** drei is removed. R3F's `import * as THREE` is redirected to `src/three-shim.js`, so
  three tree-shakes (687 kB to 462 kB raw). The scene is `React.lazy`-loaded, and `manualChunks`
  emits `three`, `r3f` and `react` as separate cacheable chunks. First paint needs only `index` + `react`.
- **Rendering:** one full-screen quad (2 triangles, 1 draw call) with the height field evaluated
  per fragment, instead of a 128×128 displaced plane plus ContactShadows (about 7 draws per frame,
  MSAA). The canvas is created with `antialias:false, depth:false, stencil:false`; the disc edge
  is already soft from a smoothstep.
- **Frame loop:** `frameloop="demand"`, driven by a small controller:
  - **Hidden tab:** no frames.
  - **Active:** one frame per rAF while the worklet is writing and the signal has energy.
  - **Idle:** about 10 Hz once the signal has been silent for more than 1 s.
- **Adaptive DPR:** the controller steps 2 → 1.5 → 1. It steps down when the frame-time EMA is
  above 1.35× the refresh interval for 1 s, and back up when it is under 1.1× for 3 s. There is a
  1.5 s cooldown, and a flip-flop back-off doubles the up-step wait (max 60 s) if a step down
  follows a step up within 5 s. `?adaptive=0` pins the DPR (for benchmarking).
- **Worklet:**
  - **YIN is skipped** when an onset is inside its window, when the input is silent (RMS gate),
    and on every other hop while unvoiced.
  - **Onset analysis stays at 512 window / 256 hop.** 1024 window / 512 hop was evaluated and
    rejected: it locked onto half the tempo (75 BPM) on the 150 BPM case and never locked at
    90 BPM. Run `node tests/bench-dsp.mjs` to reproduce.
