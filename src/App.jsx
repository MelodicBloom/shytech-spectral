import { lazy, Suspense, useRef, useState } from "react";
import Hud from "./components/Hud.jsx";
import { createEngine, createFallbackEngine } from "./audio/graph.js";
import { T, TELEMETRY_SLOTS } from "./telemetry.js";

// three.js + R3F load as separate chunks after first paint
const Scene = lazy(() => import("./components/scene/Scene.jsx"));

const DEFAULT_PLL = { kp: 0.25, ki: 0.05, window: 0.3, tempoPull: 0.2 };

const btn = (active) => ({
  padding: "8px 12px", borderRadius: 8, border: 0, cursor: "pointer", fontWeight: 700, fontSize: 12,
  fontFamily: "inherit", background: active ? "#67e8f9" : "#22d3ee", color: "#000",
});

export default function App() {
  const telemetryRef = useRef(new Float32Array(TELEMETRY_SLOTS));
  const engineRef = useRef(null);
  // debug hook (only with ?debug in the URL): lets test harnesses inject telemetry
  if (typeof window !== "undefined" && location.search.includes("debug")) window.__shytechTelemetry = telemetryRef;
  const audioElRef = useRef(null);
  const statsRef = useRef({ mode: "starting", dpr: 1, frameMs: 0, dprChanges: 0 });
  const pathRef = useRef("");
  const [path, setPathState] = useState("");
  const setPath = (p) => { pathRef.current = p; setPathState(p); };
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [pll, setPll] = useState(DEFAULT_PLL);

  async function ensureEngine() {
    if (engineRef.current) {
      await engineRef.current.ctx.resume();
      return engineRef.current;
    }
    engineRef.current = await createEngine({ telemetryRef, onPathChange: setPath, pll });
    return engineRef.current;
  }

  const run = (label, fn) => async () => {
    setError("");
    try { await fn(); setSource(label); }
    catch (e) { console.error(e); setError(String(e.message || e)); }
  };

  const startMic = run("mic", async () => {
    if (!window.AudioWorkletNode) {
      engineRef.current = await createFallbackEngine({ telemetryRef, onPathChange: setPath });
      return;
    }
    await (await ensureEngine()).useMic();
  });
  const startTest = run("test 120 BPM + 220 Hz", async () => (await ensureEngine()).useTestSignal(120));
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const el = audioElRef.current;
    el.src = URL.createObjectURL(f); // blob: URL is same-origin, so it is fine under COEP require-corp
    await run(`file: ${f.name}`, async () => {
      (await ensureEngine()).useElement(el);
      await el.play();
    })();
  };
  const stop = async () => {
    audioElRef.current?.pause();
    const eng = engineRef.current;
    if (eng?.stop) await eng.stop();           // worklet engine: disconnect + suspend (reusable)
    else if (eng) { await eng.close(); engineRef.current = null; setPath(""); }
    // zero the energy/beat slots so the scene decays to rest and the frame driver goes idle
    const d = telemetryRef.current;
    for (const k of [T.LOW, T.MID, T.HIGH, T.INFLECTION, T.RHYTHM, T.ONSET, T.PLL_LOCK, T.TEMPO_CONF]) d[k] = 0;
    setSource("");
  };
  const updatePll = (k, v) => {
    const next = { ...pll, [k]: v };
    setPll(next);
    engineRef.current?.setPll?.(next);
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100vh", background: "#0a0a0a", color: "#fff", fontFamily: "ui-monospace, monospace" }}>
      <div style={{ position: "absolute", top: 16, left: 16, zIndex: 10, display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={btn(source === "mic")} onClick={startMic}>Live mic</button>
          <button style={btn(source.startsWith("test"))} onClick={startTest}>Test signal (120 BPM)</button>
          <label style={{ ...btn(source.startsWith("file")), display: "inline-block" }}>
            Audio file
            <input type="file" accept="audio/*" onChange={onFile} style={{ display: "none" }} />
          </label>
          <button style={{ ...btn(false), background: "#444", color: "#fff" }} onClick={stop}>Stop</button>
        </div>
        <audio ref={audioElRef} controls loop style={{ width: 300, height: 32, display: source.startsWith("file") ? "block" : "none" }} />
        <div style={{ fontSize: 11, opacity: 0.8 }}>source: {source || "none"}</div>
        {error && <div style={{ fontSize: 11, color: "#f87171" }}>{error}</div>}
        <details style={{ fontSize: 11, background: "rgba(0,0,0,0.5)", padding: 8, borderRadius: 8 }}>
          <summary>PLL tunables</summary>
          {[["kp", 0, 1], ["ki", 0, 0.3], ["window", 0.05, 0.5], ["tempoPull", 0, 1]].map(([k, lo, hi]) => (
            <div key={k}>
              {k} {pll[k].toFixed(2)}
              <input type="range" min={lo} max={hi} step={0.01} value={pll[k]} onChange={(e) => updatePll(k, parseFloat(e.target.value))} style={{ width: "100%" }} />
            </div>
          ))}
        </details>
      </div>
      <Hud telemetryRef={telemetryRef} statsRef={statsRef} pathRef={pathRef} />
      {/* No drei <Environment preset>: remote HDRs can be blocked by COEP require-corp. */}
      <Suspense fallback={null}>
        <Scene telemetryRef={telemetryRef} statsRef={statsRef} />
      </Suspense>
    </div>
  );
}
