# vendor/

Archivos de terceros servidos **tal cual**, sin bundler. El sitio corre con
módulos ES nativos del navegador, así que estos bundles se copian desde
`node_modules` y se commitean.

| Archivo | Origen | Tamaño | Para qué |
|---|---|---|---|
| `ort.all.bundle.min.mjs` | `onnxruntime-web@1.30.0/dist/ort.all.bundle.min.mjs` | 865 KB | build de ORT **con WebGPU** |
| `ort.wasm.bundle.min.mjs` | `onnxruntime-web@1.30.0/dist/ort.wasm.bundle.min.mjs` | 73 KB | build de ORT **solo WASM** (sin WebGPU) |
| `ort-wasm-simd-threaded.jsep.mjs` | `onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.jsep.mjs` | 47 KB | glue (instancia el WASM) del build con WebGPU |
| `ort-wasm-simd-threaded.mjs` | `onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.mjs` | 24 KB | glue del build solo WASM |
| `supabase.js` | `@supabase/supabase-js@2.118.0/dist/umd/supabase.js` | 218 KB | cliente de Supabase (UMD clásico) |

`ort-setup.js` es nuestro: elige el build según el dispositivo y configura
`ort.env.wasm.wasmPaths`.

## Qué se sirve desde el CDN y qué no

El **.wasm** (el runtime que pesa) NO está acá:

| Build | Archivo | Tamaño | Origen |
|---|---|---|---|
| con WebGPU | `ort-wasm-simd-threaded.jsep.wasm` | 28 MB | jsDelivr |
| solo WASM | `ort-wasm-simd-threaded.wasm` | 14 MB | jsDelivr |

jsDelivr los sirve con `Cache-Control: public, max-age=31536000, immutable`
(GitHub Pages solo da `max-age=600`).

El **glue** (`.mjs`, decenas de KB) sí está vendorizado: queda en el precache
del Service Worker, así que funciona offline y no depende del CDN.

El build de WebGPU pesa el doble de WASM, así que `ort-setup.js` usa el build
solo-WASM cuando `navigator.gpu` no existe (típico en móviles, que es donde
se usa la app): **14 MB en vez de 28 MB** en la primera carga.

## Actualizar una versión

```bash
npm install onnxruntime-web@X @supabase/supabase-js@Y   # o editar package.json
cp node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs vendor/
cp node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs vendor/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs vendor/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs vendor/
cp node_modules/@supabase/supabase-js/dist/umd/supabase.js vendor/
# y actualizar ORT_VERSION en vendor/ort-setup.js con la misma versión
```

Después hay que actualizar el precache del Service Worker (`sw.js`) y el
`README`.

> Los archivos de `vendor/` están marcados como binarios en `.gitattributes`
> (`vendor/** -text`): si Git los convertir a CRLF dejarían de ser idénticos
> al original.
