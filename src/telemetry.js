// Mirror of the telemetry layout in public/dsp-core.js (asserted equal in tests/dsp.test.mjs).
export const T = Object.freeze({
  LOW: 0, MID: 1, HIGH: 2, PITCH: 3, INFLECTION: 4, RHYTHM: 5, AUDIO_TIME: 6,
  PITCH_HZ: 7, PITCH_CLARITY: 8, BEAT_PHASE: 9, BPM: 10, TEMPO_CONF: 11,
  PLL_LOCK: 12, BEAT_COUNT: 13, ONSET: 14, SEQ: 15,
});
export const TELEMETRY_SLOTS = 16;
