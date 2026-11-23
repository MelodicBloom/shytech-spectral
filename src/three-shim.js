// Tree-shaking shim for three.js.
// @react-three/fiber v8 does `import * as THREE from "three"` and registers that whole namespace as
// its JSX catalogue, which keeps ALL of three (~690 kB) in the bundle. vite.config.js redirects
// R3F's "three" import to this module, so only what R3F needs plus the JSX elements this app uses
// get bundled.
// >>> If you add a new JSX element (e.g. <boxGeometry/>), export its class here. <<<
export {
  // used internally by @react-three/fiber 8.x
  ACESFilmicToneMapping, BasicShadowMap, Camera, Clock, ColorManagement, Layers, NoToneMapping,
  Object3D, OrthographicCamera, PCFShadowMap, PCFSoftShadowMap, PerspectiveCamera, RGBAFormat,
  Raycaster, Scene, UnsignedByteType, VSMShadowMap, Vector2, Vector3, WebGLRenderer,
  // JSX elements used by this app: <mesh>, <planeGeometry>, <shaderMaterial>
  Mesh, PlaneGeometry, ShaderMaterial,
} from "three";
