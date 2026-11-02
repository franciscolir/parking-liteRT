# vendor/

Archivos de terceros servidos **tal cual**, sin bundler. El sitio corre con
módulos ES nativos del navegador, así que estos bundles se copian desde
`node_modules` y se commitean.

| Archivo | Origen | Tamaño |
|---|---|---|
| `ort.all.bundle.min.mjs` | `onnxruntime-web@1.30.0/dist/ort.all.bundle.min.mjs` | 865 KB |
| `ort-wasm-simd-threaded.jsep.mjs` | `onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.jsep.mjs` | 47 KB |
| `supabase.js` | `@supabase/supabase-js@2.118.0/dist/umd/supabase.js` | 218 KB |

`ort-setup.js` es nuestro: configura `ort.env.wasm.wasmPaths` para bajar el
WASM (28 MB, no incluido acá) desde jsDelivr con caché immutable.

## Actualizar una versión

```bash
npm install onnxruntime-web@X @supabase/supabase-js@Y   # o editar package.json
cp node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs vendor/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs vendor/
cp node_modules/@supabase/supabase-js/dist/umd/supabase.js vendor/
# y actualizar ORT_WASM_CDN en vendor/ort-setup.js con la misma versión
```

El WASM del CDN se cachea en el Service Worker (`sw.js`) la primera vez que
se usa, así que la app sigue funcionando offline después de ese load.
