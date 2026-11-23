import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const threeShim = fileURLToPath(new URL("./src/three-shim.js", import.meta.url));

// Point @react-three/fiber's `import * as THREE from "three"` at a narrow re-export module so
// Rollup can tree-shake three (see src/three-shim.js).
const treeShakeThreeForR3F = {
  name: "tree-shake-three-for-r3f",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "three" && importer && importer.includes("/@react-three/fiber/")) return threeShim;
    return null;
  },
};

// Cross-origin isolation => window.crossOriginIsolated === true => SharedArrayBuffer available.
// Must be sent on the HTML document AND every subresource (worklet modules included).
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [treeShakeThreeForR3F, react()],
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  build: {
    rollupOptions: {
      output: {
        // Long-term cacheable vendor chunks: app edits don't bust the big three.js download.
        manualChunks(id) {
          if (id === threeShim) return "three";
          if (!id.includes("node_modules")) return;
          if (/node_modules\/three\//.test(id)) return "three";
          if (/node_modules\/(@react-three|zustand|its-fine|suspend-react|react-reconciler|react-use-measure|debounce)\//.test(id)) return "r3f";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
        },
      },
    },
  },
});
