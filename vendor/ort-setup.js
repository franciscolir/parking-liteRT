// ============================================================
// ONNX Runtime Web — carga sin bundler
// ------------------------------------------------------------
// Se elegyen DOS builds según el dispositivo:
//
//   - Con WebGPU (Chrome/Edge de escritorio):
//       ort.all.bundle.min.mjs         865 KB (nuestro origen)
//       ort-wasm-simd-threaded.jsep.wasm  28 MB (jsDelivr)
//     → inferencia por GPU.
//
//   - Sin WebGPU (típico en móviles, que es donde se usa la app):
//       ort.wasm.bundle.min.mjs          73 KB (nuestro origen)
//       ort-wasm-simd-threaded.wasm      14 MB (jsDelivr)
//     → la mitad de descarga que el build con JSEP.
//
// El "glue" (.mjs que instancia el WASM) se sirve desde nuestro propio
// origen: pesa poco, queda en el precache del Service Worker (offline y
// sin CORS) y no depende del CDN.
//
// El .wasm grande NO se commitea: se baja de jsDelivr, que lo sirve con
// `Cache-Control: public, max-age=31536000, immutable` (GitHub Pages
// solo da max-age=600).
// ============================================================

export const ORT_VERSION = '1.30.0';
export const ORT_WASM_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// ¿El dispositivo tiene WebGPU? (solo Chrome/Edge de escritorio lo tienen)
// Se puede forzar con ?ort=wasm / ?ort=webgpu para probar los dos builds.
const forced = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('ort')) || '';

export const HAS_WEBGPU = forced === 'wasm'
  ? false
  : forced === 'webgpu'
    ? true
    : typeof navigator !== 'undefined' && !!navigator.gpu;

// EPs que se le pasan a InferenceSession.create. El build sin WebGPU no
// registra ese EP: pedirlo genera warnings en cada sesión.
export const ORT_EXECUTION_PROVIDERS = HAS_WEBGPU ? ['webgpu', 'wasm'] : ['wasm'];

let ortPromise = null;

/**
 * Carga (una sola vez) el runtime de ONNX.
 * @returns {Promise<typeof import('./ort.all.bundle.min.mjs')>}
 */
export function getOrt() {
  if (!ortPromise) ortPromise = loadOrt();
  return ortPromise;
}

async function loadOrt() {
  const mod = HAS_WEBGPU
    ? await import('./ort.all.bundle.min.mjs')
    : await import('./ort.wasm.bundle.min.mjs');

  const ort = mod;

  // El glue va desde nuestro origen (relative al propio módulo) y el WASM
  // desde jsDelivr. ORT concatena el nombre con el prefijo cuando el
  // wasmPaths es un string; con el formato {mjs, wasm} hay que pasar la
  // URL completa del .wasm.
  const glue = HAS_WEBGPU
    ? 'ort-wasm-simd-threaded.jsep.mjs'
    : 'ort-wasm-simd-threaded.mjs';
  const wasm = HAS_WEBGPU
    ? 'ort-wasm-simd-threaded.jsep.wasm'
    : 'ort-wasm-simd-threaded.wasm';

  ort.env.wasm.wasmPaths = {
    mjs: new URL('./' + glue, import.meta.url).href,
    wasm: ORT_WASM_CDN + wasm,
  };

  // ORT calcula los hilos por defecto así:
  //   si el documento NO está cross-origin isolated → 1 hilo (single-thread)
  //   si está isolated → min(4, ceil(cores/2))
  // Por eso los headers COOP/COEP que agrega el Service Worker son clave.
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
  const isolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
  const threads = ort.env.wasm.numThreads
    ?? (isolated ? Math.min(4, Math.ceil(cores / 2)) : 1);

  console.log(
    `[ORT] build ${HAS_WEBGPU ? 'webgpu' : 'wasm'} · threads=${threads} · isolated=${isolated}`
  );

  return ort;
}
