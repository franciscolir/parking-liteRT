// ============================================================
// ONNX Runtime Web — carga sin bundler
// ------------------------------------------------------------
// El JS se sirve desde ./vendor (copia exacta de
// node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs).
//
// El WASM (~28 MB) NO se commitea al repo: se descarga desde
// jsDelivr, que sirve `Cache-Control: public, max-age=31536000,
// immutable` (GitHub Pages solo da max-age=600).
//
// ORT concatena el nombre del archivo con el prefijo:
//   locateFile = x => wasmPaths + x
// por eso el prefijo lleva la barra final.
// ============================================================
import * as ort from './ort.all.bundle.min.mjs';

export const ORT_WASM_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';

ort.env.wasm.wasmPaths = ORT_WASM_CDN;

export { ort };
export default ort;
