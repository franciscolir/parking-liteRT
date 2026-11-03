import { describe, it, expect } from 'vitest';
import {
  resolveNumThreads,
  resolveWasmPaths,
  DEFAULT_THREADS,
  MAX_THREADS,
  ORT_WASM_CDN,
} from '../../vendor/ort-setup.js';

describe('ort-setup · hilos del WASM', () => {
  it('usa 1 hilo con WebGPU (la GPU hace el trabajo pesado)', () => {
    expect(DEFAULT_THREADS).toBe(1);
    expect(resolveNumThreads({ webgpu: true, cores: 8 })).toBe(1);
    expect(resolveNumThreads({ webgpu: true, cores: 2 })).toBe(1);
  });

  it('usa multi-hilo sin WebGPU (móviles: la inferencia no debe congelar la UI)', () => {
    expect(resolveNumThreads({ webgpu: false, cores: 8 })).toBe(4);
    expect(resolveNumThreads({ webgpu: false, cores: 4 })).toBe(2);
    expect(resolveNumThreads({ webgpu: false, cores: 2 })).toBe(2);
    expect(resolveNumThreads({ webgpu: false, cores: 1 })).toBe(2);
  });

  it('nunca supera el máximo de hilos', () => {
    expect(resolveNumThreads({ webgpu: false, cores: 64 })).toBe(MAX_THREADS);
  });

  it('permite forzar el número de hilos con ?threads=N', () => {
    expect(resolveNumThreads({ forced: 4 })).toBe(4);
    expect(resolveNumThreads({ forced: 2 })).toBe(2);
    expect(resolveNumThreads({ forced: 1, webgpu: false, cores: 8 })).toBe(1);
  });

  it('ignora valores inválidos y usa el default del dispositivo', () => {
    const cpu = { webgpu: false, cores: 4 };   // -> 2 hilos
    expect(resolveNumThreads({ ...cpu, forced: -1 })).toBe(2);
    expect(resolveNumThreads({ ...cpu, forced: NaN })).toBe(2);
    expect(resolveNumThreads({ ...cpu, forced: 'x' })).toBe(2);
    expect(resolveNumThreads({ ...cpu, forced: 0 })).toBe(2);
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
