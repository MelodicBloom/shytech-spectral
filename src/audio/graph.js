// Web Audio graph: sources -> (analysis, undelayed) -> AudioWorklet DSP
//                         -> DelayNode(lookahead) -> speakers
import { TELEMETRY_SLOTS } from "../telemetry.js";

export const OUTPUT_DELAY_MS = 24;   // speaker path delay = analysis head start
const RENDER_LATENCY_MS = 16;        // ~1 display frame

export async function createEngine({ telemetryRef, onPathChange, pll }) {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  if (!ctx.audioWorklet) throw new Error("AudioWorklet not supported (needs a secure context: https or localhost)");
  await ctx.audioWorklet.addModule("/shytech-dsp-worklet.js");

  const hwMs = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000 || 20;
  const dspNode = new AudioWorkletNode(ctx, "shytech-dsp-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { lookaheadMs: hwMs + RENDER_LATENCY_MS, pll },
  });
  // keep the worklet pulled by the graph, silently
  const sink = ctx.createGain();
  sink.gain.value = 0;
  dspNode.connect(sink).connect(ctx.destination);

  let path;
  if (typeof SharedArrayBuffer !== "undefined" && window.crossOriginIsolated) {
    const sab = new SharedArrayBuffer(TELEMETRY_SLOTS * Float32Array.BYTES_PER_ELEMENT);
    telemetryRef.current = new Float32Array(sab);
    dspNode.port.postMessage({ sharedBuffer: sab });
    path = "SharedArrayBuffer";
  } else {
    if (!(telemetryRef.current instanceof Float32Array) || telemetryRef.current.length !== TELEMETRY_SLOTS) {
      telemetryRef.current = new Float32Array(TELEMETRY_SLOTS);
    }
    const view = telemetryRef.current;
    dspNode.port.onmessage = (e) => view.set(e.data);
    path = "postMessage (~60 Hz)";
  }
  onPathChange?.(path);

  // Speaker output path with the analysis head start
  const outDelay = ctx.createDelay(0.25);
  outDelay.delayTime.value = OUTPUT_DELAY_MS / 1000;
  const monitor = ctx.createGain();
  monitor.connect(outDelay).connect(ctx.destination);

  const setLookahead = (ms) => dspNode.port.postMessage({ config: { lookaheadMs: Math.max(0, ms) } });
  const nodes = [];

  /** connect a source node; playback sources are monitored through the delayed output path */
  function connect(node, { audible }) {
    node.connect(dspNode);
    if (audible) {
      node.connect(monitor);
      // Speakers emit a sample OUTPUT_DELAY_MS + hwMs after it is analysed; the frame is seen
      // RENDER_LATENCY_MS after render. Predict only what the delay line does not already cover
      // (usually <= 0 -> no extrapolation needed; clamped to 0 in setLookahead).
      setLookahead(RENDER_LATENCY_MS - OUTPUT_DELAY_MS - hwMs);
    } else {
      setLookahead(hwMs + RENDER_LATENCY_MS);
    }
    nodes.push(node);
  }
  function disconnectAll() {
    for (const n of nodes.splice(0)) {
      try { n.disconnect(); } catch {}
      try { n.stop?.(); } catch {}
    }
  }

  async function useMic() {
    disconnectAll();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = ctx.createMediaStreamSource(stream);
    src._stream = stream;
    src.stop = () => stream.getTracks().forEach((t) => t.stop());
    connect(src, { audible: false });
  }

  const elementSources = new WeakMap();
  function useElement(audioEl) {
    disconnectAll();
    let src = elementSources.get(audioEl);
    if (!src) { src = ctx.createMediaElementSource(audioEl); elementSources.set(audioEl, src); }
    connect(src, { audible: true });
  }

  /** 220 Hz tone with a slow ±3-semitone glide + a 120 BPM click (sample-accurate loop) */
  function useTestSignal(bpm = 120) {
    disconnectAll();
    const mix = ctx.createGain();
    mix.gain.value = 0.6;

    const osc = ctx.createOscillator();
    osc.frequency.value = 220;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.2;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 300; // cents
    lfo.connect(lfoDepth).connect(osc.detune);
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.25;
    osc.connect(toneGain).connect(mix);

    const len = Math.round((ctx.sampleRate * 60) / bpm);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < Math.min(len, ctx.sampleRate * 0.01); i++) {
      const env = Math.exp(-i / (ctx.sampleRate * 0.002));
      d[i] = env * (0.6 * (Math.random() * 2 - 1) + 0.4 * Math.sin((2 * Math.PI * 1800 * i) / ctx.sampleRate));
    }
    const click = ctx.createBufferSource();
    click.buffer = buf;
    click.loop = true;
    click.connect(mix);

    const t0 = ctx.currentTime + 0.05;
    osc.start(t0); lfo.start(t0); click.start(t0);
    mix.stop = () => { osc.stop(); lfo.stop(); click.stop(); };
    connect(mix, { audible: true });
  }

  return {
    ctx,
    path,
    useMic,
    useElement,
    useTestSignal,
    setPll: (p) => dspNode.port.postMessage({ config: { pll: p } }),
    // Stop keeps the context alive: a <audio> element can only ever be bound to ONE
    // MediaElementSource/AudioContext, so closing would break replaying files later.
    async stop() { disconnectAll(); await ctx.suspend(); },
    async close() { disconnectAll(); await ctx.close(); },
  };
}

/** Main-thread fallback (no AudioWorklet): AnalyserNode + PredictiveAudioEngine */
export async function createFallbackEngine({ telemetryRef, onPathChange }) {
  const { PredictiveAudioEngine } = await import("../engine/PredictiveAudioEngine.js");
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.5;
  const engine = new PredictiveAudioEngine(analyser, 24);
  telemetryRef.current = new Float32Array(16);
  let raf = 0;
  const tick = () => { engine.sample(ctx.currentTime, telemetryRef.current); raf = requestAnimationFrame(tick); };
  tick();
  onPathChange?.("main-thread AnalyserNode (no worklet)");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  ctx.createMediaStreamSource(stream).connect(analyser);
  return { ctx, async close() { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); await ctx.close(); } };
}
