// Full-screen 2-triangle quad. The old 128x128 displaced plane is replaced by an analytic
// height field evaluated per fragment, with its analytic gradient used for shading.
export const vertexShader = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const fragmentShader = /* glsl */ `
  precision highp float;
  uniform vec2 uRes;
  uniform float uTime, uLow, uMid, uHigh, uPitch, uInflection, uRhythm, uBeatPhase, uBeatAmt;

  vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
  }

  void main() {
    // Map pixels to the old plane's uv space. Geometrically the 2.6-unit disc at z=3.2 / fov 45
    // spans 0.981 of the viewport height (scale 1.0196); the old mesh additionally bulged toward the
    // camera, so the scale is matched empirically to the baseline screenshot (disc + ring radius).
    vec2 c = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * 0.968;
    float r = length(c);
    if (r > 0.5) { gl_FragColor = vec4(vec3(10.0 / 255.0), 1.0); return; } // page bg #0a0a0a
    vec2 dir = c / max(r, 1e-4);

    // --- bass swell: B(r) ---
    float eB = exp(-r * 3.0);
    float aB = r * 10.0 - uTime * 2.0;
    float sB = 0.75 + 0.25 * sin(aB);
    float B = uLow * 0.28 * eB * sB;
    float dBdr = uLow * 0.28 * eB * (-3.0 * sB + 2.5 * cos(aB));

    // --- melody crest at pitch-driven Y: C(x,y) = uMid*0.22*G(y)*W(x) ---
    float cy = mix(-0.38, 0.38, uPitch);
    float gy = (c.y - cy) * 7.0;
    float G = exp(-gy * gy);
    float aW = c.x * 12.0 + uTime * 3.0 + uInflection * 6.2831;
    float W = 0.65 + 0.35 * sin(aW);
    float C = uMid * 0.22 * G * W;
    vec2 dC = uMid * 0.22 * vec2(G * 4.2 * cos(aW), W * G * (-14.0 * gy));

    // --- high shimmer ---
    float ax = c.x * 64.0 + uTime * 9.0, ay = c.y * 58.0 - uTime * 7.0;
    float hk = uHigh * 0.035;
    float Hs = hk * sin(ax) * sin(ay);
    vec2 dH = hk * vec2(64.0 * cos(ax) * sin(ay), 58.0 * sin(ax) * cos(ay));

    // --- beat ring: expands once per PLL beat ---
    float rr = (r - uBeatPhase * 0.72) * 26.0;
    float ring = exp(-rr * rr) * pow(1.0 - uBeatPhase, 1.5) * uBeatAmt;
    float dRdr = ring * (-52.0 * rr);

    // --- syllable punch ---
    float P = uRhythm * 0.07 * exp(-r * 5.0);
    float dPdr = -5.0 * P;

    float d = B + C + Hs + ring * 0.12 + P;
    vec2 grad = dir * (dBdr + 0.12 * dRdr + dPdr) + dC + dH;

    // shading from the analytic normal (subtle relief; the old mesh read mostly through colour)
    vec3 n = normalize(vec3(-grad * 0.35, 1.0));
    float lit = 0.85 + 0.25 * dot(n, normalize(vec3(-0.4, 0.5, 0.75)));

    float hue = fract(0.55 + uPitch * 0.6 + uInflection * 0.08);
    vec3 base = hsv2rgb(vec3(hue, 0.75 - uHigh * 0.3, 0.25 + d * 2.6)) * lit;
    vec3 ringCol = hsv2rgb(vec3(fract(hue + 0.5), 0.35, 1.0));
    vec3 col = base + ringCol * ring * 1.6;
    col += vec3(0.9, 0.95, 1.0) * exp(-uBeatPhase * 18.0) * uBeatAmt * 0.18 * smoothstep(0.5, 0.0, r);
    col += uRhythm * 0.15;
    col *= smoothstep(0.5, 0.46, r);
    gl_FragColor = vec4(col, 1.0);
  }
`;
