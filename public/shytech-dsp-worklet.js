// AudioWorklet: runs the whole DSP pipeline on the audio rendering thread.
// Telemetry goes out through a SharedArrayBuffer (crossOriginIsolated) or,
// as a fallback, a throttled (~60 Hz) postMessage of ONE preallocated array.
import { ShytechDSP, TELEMETRY_SLOTS } from "./dsp-core.js";

class ShytechDspProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.dsp = new ShytechDSP(sampleRate, opts);
    this.mono = new Float32Array(128);
    this.local = new Float32Array(TELEMETRY_SLOTS);
    this.shared = null;
    // FIX: fallback used to allocate & post a new array every 128-sample quantum (375/s).
    this.postEvery = Math.max(1, Math.round(sampleRate / 128 / (opts.postHz || 60)));
    this.counter = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.sharedBuffer) this.shared = new Float32Array(d.sharedBuffer);
      if (d.config) this.dsp.configure(d.config);
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    let block = this.mono;
    if (input && input.length > 0) {
      const n = input[0].length;
      if (block.length !== n) block = this.mono = new Float32Array(n); // only if render quantum size ever changes
      if (input.length === 1) block.set(input[0]);
      else {
        const inv = 1 / input.length;
        for (let i = 0; i < n; i++) {
          let s = 0;
          for (let c = 0; c < input.length; c++) s += input[c][i];
          block[i] = s * inv;
        }
      }
    } else {
      block.fill(0); // disconnected: keep the beat clock running on silence
    }
    this.dsp.process(block, currentTime);
    if (this.shared) {
      this.dsp.writeTelemetry(this.shared);
    } else if (++this.counter >= this.postEvery) {
      this.counter = 0;
      this.dsp.writeTelemetry(this.local);
      this.port.postMessage(this.local); // structured clone; worklet keeps reusing this.local
    }
    // outputs are left silent (node is connected to a muted sink so it is always pulled)
    return true;
  }
}

registerProcessor("shytech-dsp-processor", ShytechDspProcessor);
