import { useEffect, useRef } from "react";
import { T } from "../telemetry.js";

// Rendered once by React; afterwards a 10 Hz timer writes straight into DOM nodes via refs.
// No React state, no re-renders. The timer skips work while the tab is hidden.
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");
const BAR = { display: "inline-block", width: 80, height: 6, background: "#222", marginLeft: 6, verticalAlign: "middle" };
const FILL = { display: "block", width: "0%", height: "100%", background: "#22d3ee" };

export default function Hud({ telemetryRef, statsRef, pathRef }) {
  const r = useRef({});
  const set = (k) => (el) => { r.current[k] = el; };
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      const d = telemetryRef.current, n = r.current, st = statsRef.current;
      if (!d || !n.bpm) return;
      n.path.textContent = pathRef.current || "idle";
      n.bpm.textContent = fmt(d[T.BPM], 1);
      n.dot.style.background = d[T.BEAT_PHASE] < 0.12 ? "#facc15" : "#333";
      n.confV.textContent = fmt(d[T.TEMPO_CONF]);
      n.lockV.textContent = fmt(d[T.PLL_LOCK]);
      n.beat.textContent = `#${d[T.BEAT_COUNT] | 0}`;
      n.pitch.textContent = `${fmt(d[T.PITCH_HZ], 1)} Hz (clarity ${fmt(d[T.PITCH_CLARITY])})`;
      for (const [k, slot] of [["conf", T.TEMPO_CONF], ["lock", T.PLL_LOCK], ["phase", T.BEAT_PHASE], ["low", T.LOW], ["mid", T.MID], ["high", T.HIGH], ["rhy", T.RHYTHM]]) {
        n[k].style.width = `${Math.round(Math.min(1, Math.max(0, d[slot])) * 100)}%`;
      }
      n.seq.textContent = `seq ${d[T.SEQ] | 0} · t ${fmt(d[T.AUDIO_TIME])} s`;
      n.render.textContent = `render ${st.mode} · dpr ${st.dpr} · ${fmt(st.frameMs, 1)} ms`;
    }, 100);
    return () => clearInterval(id);
  }, [telemetryRef, statsRef, pathRef]);
  const bar = (k) => <span style={BAR}><span ref={set(k)} style={FILL} /></span>;
  return (
    <div style={{ position: "absolute", right: 16, top: 16, zIndex: 10, background: "rgba(0,0,0,0.6)", padding: "10px 12px", borderRadius: 8, fontSize: 11, lineHeight: 1.7, minWidth: 230 }}>
      <div>isolated: <b style={{ color: window.crossOriginIsolated ? "#4ade80" : "#f87171" }}>{String(window.crossOriginIsolated)}</b></div>
      <div>telemetry: <b ref={set("path")}>idle</b></div>
      <div style={{ fontSize: 20, marginTop: 4 }}>
        <span ref={set("bpm")}>–</span> <span style={{ fontSize: 11 }}>BPM</span>
        <span ref={set("dot")} style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, marginLeft: 10, background: "#333" }} />
      </div>
      <div>tempo conf {bar("conf")} <span ref={set("confV")} /></div>
      <div>PLL lock {bar("lock")} <span ref={set("lockV")} /></div>
      <div>beat phase {bar("phase")} <span ref={set("beat")} /></div>
      <div>pitch <span ref={set("pitch")} /></div>
      <div>low {bar("low")} mid {bar("mid")}</div>
      <div>high {bar("high")} rhy {bar("rhy")}</div>
      <div ref={set("render")} style={{ opacity: 0.75 }} />
      <div ref={set("seq")} style={{ opacity: 0.6 }} />
    </div>
  );
}
