import { describe, it, expect } from 'vitest';
import { resolveNumThreads, resolveWasmPaths, DEFAULT_THREADS, ORT_WASM_CDN } from '../../vendor/ort-setup.js';

describe('ort-setup · hilos del WASM', () => {
  it('usa 1 hilo por defecto (los Workers de pthread se bloquean con el Service Worker)', () => {
    expect(DEFAULT_THREADS).toBe(1);
    expect(resolveNumThreads({})).toBe(1);
    expect(resolveNumThreads({ forced: 0 })).toBe(1);
  });

  it('permite forzar el número de hilos con ?threads=N', () => {
    expect(resolveNumThreads({ forced: 4 })).toBe(4);
    expect(resolveNumThreads({ forced: 2 })).toBe(2);
  });

  it('ignora valores inválidos', () => {
    expect(resolveNumThreads({ forced: -1 })).toBe(1);
    expect(resolveNumThreads({ forced: NaN })).toBe(1);
    expect(resolveNumThreads({ forced: 'x' })).toBe(1);
  });
});

describe('ort-setup · rutas del WASM', () => {
  const localDir = 'https://ejemplo.test/vendor/';

  it('con 1 hilo usa el glue local (offline, precache del Service Worker)', () => {
    const p = resolveWasmPaths(1, { webgpu: true, localDir });
    expect(p.mjs).toBe(localDir + 'ort-wasm-simd-threaded.jsep.mjs');
    expect(p.wasm).toBe(ORT_WASM_CDN + 'ort-wasm-simd-threaded.jsep.wasm');
  });

  it('con >1 hilos usa el glue del CDN (ORT lo baja a blob: y los workers no los bloquea el SW)', () => {
    const p = resolveWasmPaths(4, { webgpu: true, localDir });
    expect(p.mjs).toBe(ORT_WASM_CDN + 'ort-wasm-simd-threaded.jsep.mjs');
    expect(p.wasm).toBe(ORT_WASM_CDN + 'ort-wasm-simd-threaded.jsep.wasm');
  });

  it('usa el build sin JSEP cuando no hay WebGPU', () => {
    const p = resolveWasmPaths(1, { webgpu: false, localDir });
    expect(p.mjs).toBe(localDir + 'ort-wasm-simd-threaded.mjs');
    expect(p.wasm).toBe(ORT_WASM_CDN + 'ort-wasm-simd-threaded.wasm');
  });
});
