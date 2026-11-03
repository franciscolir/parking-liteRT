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

// ------------------------------------------------------------
// Hilos del WASM
// ------------------------------------------------------------
// 1 (single-thread) por defecto.
//
// ORT con varios hilos arranca Workers de pthread cargados desde el propio
// origen. Con el Service Worker activo, esas peticiones se responden desde
// la caché y el navegador las BLOQUEA (net::ERR_BLOCKED_BY_RESPONSE): el
// WASM queda esperando a un worker que nunca arranca y la carga de los
// modelos se cuelga para siempre ("Cargando detector YOLOv8..." eternity).
//
// Con 1 hilo no hace falta ningún Worker: el WASM se instancia en el hilo
// principal y los modelos cargan siempre. La inferencia es ~2x más lenta,
// pero funciona en todos los dispositivos.
//
// Se puede forzar el número de hilos con ?threads=4 (o ?threads=1) para
// probar el modo multi-hilo.
export const DEFAULT_THREADS = 1;

const forcedThreads = Number(
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('threads')) || 0
) || 0;

/** Resuelve cuántos hilos debe usar el WASM. */
export function resolveNumThreads({ forced: forcedValue = forcedThreads, fallback = DEFAULT_THREADS } = {}) {
  return Number.isFinite(forcedValue) && forcedValue > 0 ? Math.floor(forcedValue) : fallback;
}

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
  //
  // PERO: los hilos de ORT arrancan Workers de pthread que el Service
  // Worker no puede servir (se bloquean con ERR_BLOCKED_BY_RESPONSE) y el
  // WASM queda colgado. Por eso se fuerzan los hilos explícitamente
  // (1 por defecto) en vez de dejar que ORT los elija.
  const threads = resolveNumThreads();
  ort.env.wasm.numThreads = threads;

  const isolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;

  console.log(
    `[ORT] build ${HAS_WEBGPU ? 'webgpu' : 'wasm'} · threads=${threads} · isolated=${isolated}`
  );

  return ort;
}
