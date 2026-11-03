import { describe, it, expect } from 'vitest';
import { resolveNumThreads, DEFAULT_THREADS } from '../../vendor/ort-setup.js';

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
