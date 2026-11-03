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
// Excepción: en modo multi-hilo el glue se pide a jsDelivr, porque ORT crea
// los Workers de pthread a partir de la URL del glue y el Service Worker
// bloquea los workers same-origin (ver resolveWasmPaths).
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
// modelos se cuelga para siempre ("Cargando detector YOLOv8...").
//
// Con 1 hilo no hace falta ningún Worker: el WASM se instancia en el hilo
// principal y los modelos cargan siempre.
//
// Con >1 hilos el problema se esquiva usando el glue de jsDelivr: ORT lo
// baja a un blob: y los Workers de pthread nacen de blob:, que el Service
// Worker no intercepta (ver resolveWasmPaths). Se activa con ?threads=4.
//
// En escritorio (WebGPU) el multi-hilo NO aporta: medido en producción,
// 1 hilo = 229-310 ms por inferencia y 4 hilos = 237-366 ms. Por eso el
// default es 1: más simple, menos memoria y siempre funciona.
export const DEFAULT_THREADS = 1;

const forcedThreads = Number(
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('threads')) || 0
) || 0;

/** Resuelve cuántos hilos debe usar el WASM. */
export function resolveNumThreads({ forced: forcedValue = forcedThreads, fallback = DEFAULT_THREADS } = {}) {
  return Number.isFinite(forcedValue) && forcedValue > 0 ? Math.floor(forcedValue) : fallback;
}

/**
 * Rutas del glue (.mjs) y del WASM.
 *
 * - 1 hilo  → glue desde nuestro origen (offline, precache del SW).
 * - >1 hilos → glue desde jsDelivr: ORT lo convierte en un blob: y los
 *   Workers de pthread se crean desde ahí. Con el glue same-origin el
 *   Service Worker intercepta la petición del worker y el navegador la
 *   bloquea (ERR_BLOCKED_BY_RESPONSE) → el WASM queda colgado.
 */
export function resolveWasmPaths(numThreads, {
  webgpu = HAS_WEBGPU,
  cdn = ORT_WASM_CDN,
  localDir = new URL('./', import.meta.url).href,
} = {}) {
  const glue = webgpu ? 'ort-wasm-simd-threaded.jsep.mjs' : 'ort-wasm-simd-threaded.mjs';
  const wasm = webgpu ? 'ort-wasm-simd-threaded.jsep.wasm' : 'ort-wasm-simd-threaded.wasm';
  return {
    mjs: numThreads > 1 ? cdn + glue : localDir + glue,
    wasm: cdn + wasm,
  };
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
  //
  // Los hilos se fuerzan explícitamente (1 por defecto): si se deja que ORT
  // los elija, con el documento cross-origin isolated usa varios y el
  // Service Worker bloquea los Workers de pthread (ERR_BLOCKED_BY_RESPONSE)
  // → la carga de los modelos se queda colgada para siempre.
  const threads = resolveNumThreads();
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.wasmPaths = resolveWasmPaths(threads);

  const isolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;

  console.log(
    `[ORT] build ${HAS_WEBGPU ? 'webgpu' : 'wasm'} · threads=${threads} · isolated=${isolated}`
  );

  return ort;
}
