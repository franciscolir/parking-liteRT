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
// El número de hilos depende del dispositivo:
//
//   - Con WebGPU (escritorio): 1 hilo. La GPU hace el trabajo pesado y
//     medir en producción no mostró diferencia (1 hilo = 229-310 ms por
//     inferencia, 4 hilos = 237-366 ms).
//
//   - Sin WebGPU (móviles, build CPU): multi-hilo (2-4 según núcleos).
//     Con 1 hilo la inferencia bloquea el hilo principal del navegador
//     (medido: 503 ms en escritorio, varios segundos en un teléfono):
//     la UI se congela, el recuadro verde no aparece y ningún botón
//     responde. Con 4 hilos la inferencia baja a 200 ms y el hilo
//     principal queda libre.
//
// El multi-hilo necesita el glue de jsDelivr (ver resolveWasmPaths): con el
// glue same-origin el Service Worker bloquea los Workers de pthread.
//
// Se puede forzar con ?threads=N (o ?threads=1 para desactivar el
// multi-hilo en un móvil).
export const DEFAULT_THREADS = 1;
export const MAX_THREADS = 4;

const forcedThreads = Number(
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('threads')) || 0
) || 0;

const defaultCores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;

/** Resuelve cuántos hilos debe usar el WASM. */
export function resolveNumThreads({
  forced = forcedThreads,
  webgpu = HAS_WEBGPU,
  cores = defaultCores,
  fallback = DEFAULT_THREADS,
} = {}) {
  if (Number.isFinite(forced) && forced > 0) return Math.floor(forced);
  if (webgpu) return fallback;
  const n = Math.ceil((Number(cores) || 2) / 2);
  return Math.min(MAX_THREADS, Math.max(2, n));
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
let ortFallback = null;          // instancia single-thread si el multi-hilo falla
let ortFallbackPromise = null;   // promesa compartida: el detector y el OCR
                                  // pueden fallar a la vez y deben caer en
                                  // la MISMA instancia (si no, los Tensor
                                  // quedan de un módulo y la sesión de otro)

/**
 * Carga (una sola vez) el runtime de ONNX.
 * @returns {Promise<typeof import('./ort.all.bundle.min.mjs')>}
 */
export function getOrt() {
  if (ortFallback) return Promise.resolve(ortFallback);
  if (!ortPromise) ortPromise = loadOrt();
  return ortPromise;
}

/**
 * Crea una sesión de inferencia.
 *
 * Si el multi-hilo falla (SharedArrayBuffer no disponible, el navegador no
 * soporta pthread workers, el CDN no responde...) se reintenta con 1 hilo y
 * el glue local, que es la configuración que funciona en todas partes.
 */
export async function createSession(model, options = {}) {
  const ort = await getOrt();
  try {
    return await ort.InferenceSession.create(model, options);
  } catch (err) {
    if (resolveNumThreads() <= 1) throw err;
    console.warn('[ORT] el multi-hilo falló, reintento con 1 hilo:', err?.message || err);
    const single = await getSingleThreadOrt();
    return await single.InferenceSession.create(model, options);
  }
}

function getSingleThreadOrt() {
  if (!ortFallbackPromise) {
    ortFallbackPromise = loadOrt({ threads: 1, fresh: true })
      .then((ort) => { ortFallback = ort; return ort; });
  }
  return ortFallbackPromise;
}

async function importOrt(fresh = false) {
  const url = HAS_WEBGPU ? './ort.all.bundle.min.mjs' : './ort.wasm.bundle.min.mjs';
  // Una instancia "fresca" (con query) es un módulo aparte: sirve para
  // reintentar con otra config porque ORT no permite reinicializar el WASM
  // dentro del mismo módulo.
  return fresh ? import(/* @vite-ignore */ url + '?single=1') : import(url);
}

async function loadOrt({ threads = resolveNumThreads(), fresh = false } = {}) {
  const mod = await importOrt(fresh);
  const ort = mod;

  // El glue va desde nuestro origen (relative al propio módulo) y el WASM
  // desde jsDelivr. ORT concatena el nombre con el prefijo cuando el
  // wasmPaths es un string; con el formato {mjs, wasm} hay que pasar la
  // URL completa del .wasm.
  //
  // Los hilos se fuerzan explícitamente (nunca los elige ORT): si está
  // isolated y el multi-hilo está activo, ORT crea Workers de pthread que el
  // Service Worker no puede servir (ERR_BLOCKED_BY_RESPONSE) y la carga de
  // los modelos se queda colgada para siempre.
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.wasmPaths = resolveWasmPaths(threads);

  const isolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;

  console.log(
    `[ORT] build ${HAS_WEBGPU ? 'webgpu' : 'wasm'} · threads=${threads} · isolated=${isolated}`
  );

  return ort;
}
