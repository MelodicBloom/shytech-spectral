// Lazy-loaded chunk: everything that pulls in three / @react-three/fiber lives behind this module.
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { T } from "../../telemetry.js";
import { vertexShader, fragmentShader } from "./shaders.js";

const lerpExp = (curr, target, rate, dt) => curr + (target - curr) * (1 - Math.exp(-rate * dt));

function SpectralQuad({ telemetryRef }) {
  const matRef = useRef();
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const uniforms = useMemo(
    () => ({
      uRes: { value: [1, 1] }, uTime: { value: 0 }, uLow: { value: 0 }, uMid: { value: 0 }, uHigh: { value: 0 },
      uPitch: { value: 0 }, uInflection: { value: 0 }, uRhythm: { value: 0 },
      uBeatPhase: { value: 0 }, uBeatAmt: { value: 0 },
    }),
    []
  );
  useEffect(() => {
    uniforms.uRes.value = [size.width * dpr, size.height * dpr];
  }, [size, dpr, uniforms]);

  useFrame((state, rawDelta) => {
    const data = telemetryRef.current;
    if (!data) return;
    const u = uniforms;
    const delta = Math.min(rawDelta, 0.25); // idle/resume gaps: don't overshoot
    u.uTime.value = state.clock.elapsedTime;
    const sm = (k, target, attack, release) => {
      const cur = u[k].value;
      u[k].value = lerpExp(cur, target, target > cur ? attack : release, delta);
    };
    sm("uLow", data[T.LOW], 28, 10);
    sm("uMid", data[T.MID], 36, 14);
    sm("uHigh", data[T.HIGH], 45, 18);
    sm("uPitch", data[T.PITCH], 22, 12);
    sm("uInflection", data[T.INFLECTION], 32, 14);
    sm("uRhythm", data[T.RHYTHM], 65, 16);
    u.uBeatPhase.value = data[T.BEAT_PHASE]; // wraps 1 -> 0: never smoothed
    sm("uBeatAmt", Math.min(1, data[T.PLL_LOCK] * (0.4 + data[T.TEMPO_CONF])), 6, 2);
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial ref={matRef} vertexShader={vertexShader} fragmentShader={fragmentShader} uniforms={uniforms} depthTest={false} depthWrite={false} />
    </mesh>
  );
}

/**
 * Frame driver for frameloop="demand":
 *  - tab hidden            -> no frames at all (visibilitychange)
 *  - telemetry active      -> invalidate every rAF (display rate)
 *  - silent > 1 s          -> idle at ~10 Hz so smoothing still decays and the scene stays alive
 * Also runs the adaptive-DPR controller on active frames only.
 */
function FrameDriver({ telemetryRef, statsRef, maxDpr }) {
  const invalidate = useThree((s) => s.invalidate);
  const setDpr = useThree((s) => s.setDpr);
  useEffect(() => {
    let raf = 0, timer = 0, lastActive = -1e9, last = performance.now();
    // Adaptive DPR (PerformanceMonitor-style). Thresholds are relative to the measured refresh
    // interval (rAF deltas can never beat vsync), with separate down/up bands, dwell times,
    // a cooldown, and flip-flop back-off: if an up-step is followed by a down-step within 5 s,
    // the next up-step waits twice as long (max 60 s).
    const params = new URLSearchParams(location.search);
    const adaptive = params.get("adaptive") !== "0";
    const DOWN_K = 1.35, UP_K = 1.1, DOWN_DWELL = 1000, COOLDOWN = 1500;
    let upDwell = 3000, lastUpAt = -1e9;
    const steps = [1, 1.5, 2].filter((d) => d <= maxDpr + 1e-6);
    let level = steps.length - 1, ema = 16.7, overSince = 0, underSince = 0, lastChange = 0;
    // refresh interval estimate: median rAF delta over ~2 s snapped to a standard rate. It may only
    // DECREASE from the 60 Hz default (learns 90/120/144 Hz panels); load can't inflate it.
    const RATES = [6.94, 8.33, 11.11, 13.89, 16.67, 33.33];
    const win = new Float32Array(120), sorted = new Float32Array(120);
    let refresh = 16.67, winN = 0, winStart = performance.now();
    setDpr(steps[level]);
    const stats = statsRef.current;
    stats.dpr = steps[level];
    stats.adaptive = adaptive;

    // active = the worklet is still writing (SEQ advancing) AND there is signal energy
    let lastSeq = -1, lastSeqChange = -1e9;
    const isActive = (now) => {
      const d = telemetryRef.current;
      if (d) {
        if (d[T.SEQ] !== lastSeq) { lastSeq = d[T.SEQ]; lastSeqChange = now; }
        const e = Math.max(d[T.LOW], d[T.MID], d[T.HIGH], d[T.ONSET], d[T.RHYTHM]);
        if (e > 0.02 && now - lastSeqChange < 250) lastActive = now;
      }
      return now - lastActive < 1000;
    };
    const adapt = (now, dt) => {
      if (dt > 250) return; // tab switch / stall, not a steady-state sample
      ema += (dt - ema) * 0.1;
      stats.frameMs = ema;
      if (winN < win.length) win[winN++] = dt;
      if (now - winStart > 2000 && winN >= 30) {
        sorted.set(win); const v = sorted.subarray(0, winN).sort();
        const p50 = v[Math.floor(winN * 0.5)];
        refresh = Math.min(refresh, RATES.reduce((a, b) => (Math.abs(b - p50) < Math.abs(a - p50) ? b : a)));
        winN = 0; winStart = now;
      }
      if (!adaptive || now - lastChange < COOLDOWN) return;
      if (ema > refresh * DOWN_K) { overSince ||= now; underSince = 0; }
      else if (ema < refresh * UP_K) { underSince ||= now; overSince = 0; }
      else { overSince = underSince = 0; }
      if (overSince && now - overSince > DOWN_DWELL && level > 0) {
        level--; overSince = 0;
        if (now - lastUpAt < 5000) upDwell = Math.min(60000, upDwell * 2); // flip-flop back-off
      } else if (underSince && now - underSince > upDwell && level < steps.length - 1) {
        level++; underSince = 0; lastUpAt = now;
      } else return;
      lastChange = now;
      setDpr(steps[level]);
      stats.dpr = steps[level];
      stats.dprChanges++;
      if ((window.__dprLog ||= []).length > 50) window.__dprLog.shift();
      window.__dprLog.push(`${Math.round(now)}ms->${steps[level]} (ema ${ema.toFixed(1)}, refresh ${refresh.toFixed(1)})`);
    };
    const tick = () => {
      raf = timer = 0;
      if (document.hidden) { stats.mode = "paused (hidden)"; return; }
      const now = performance.now();
      const dt = now - last;
      last = now;
      invalidate();
      if (isActive(now)) {
        if (stats.mode === "active") adapt(now, dt); // only judge steady display-rate frames
        stats.mode = "active";
        raf = requestAnimationFrame(tick);
      } else {
        stats.mode = "idle 10 Hz";
        timer = setTimeout(tick, 100);
      }
    };
    const onVis = () => {
      cancelAnimationFrame(raf); clearTimeout(timer); raf = timer = 0;
      if (!document.hidden) { last = performance.now(); stats.mode = "resuming"; tick(); }
      else stats.mode = "paused (hidden)";
    };
    document.addEventListener("visibilitychange", onVis);
    tick();
    return () => { document.removeEventListener("visibilitychange", onVis); cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [invalidate, setDpr, telemetryRef, statsRef, maxDpr]);
  return null;
}

export default function Scene({ telemetryRef, statsRef }) {
  const maxDpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  return (
    <Canvas
      frameloop="demand"
      dpr={maxDpr}
      gl={{ antialias: false, depth: false, stencil: false, alpha: false, powerPreference: "high-performance" }}
      style={{ position: "absolute", inset: 0 }}
    >
      <SpectralQuad telemetryRef={telemetryRef} />
      <FrameDriver telemetryRef={telemetryRef} statsRef={statsRef} maxDpr={maxDpr} />
    </Canvas>
  );
}
