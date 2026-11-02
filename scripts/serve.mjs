/**
 * Servidor estático de desarrollo (sin dependencias).
 *
 *   npm run dev          → http://localhost:3000
 *   PORT=8080 npm run dev
 *
 * Sirve la raíz del proyecto tal cual, que es exactamente lo que publica
 * GitHub Pages (no hay build). Además envía COOP/COEP para que local
 * tengas crossOriginIsolated = true y ONNX Runtime use varios hilos.
 *
 * Nota: GitHub Pages NO puede enviar esas cabeceras, así que en producción
 * la inferencia corre single-thread. Ver diagnóstico de rendimiento.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.mp4': 'video/mp4',
};

function safePath(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  // normalize convierte '/' en '\' en Windows: quitamos la barra inicial
  // para que join() no la trate como ruta absoluta.
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const clean = rel.replace(/^(\.\.([/\\]|$))+/, ''); // nunca salirse de la raíz
  const full = join(ROOT, clean);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  const target = safePath(req.url || '/');

  try {
    // El sitio desplegado tiene los archivos de public/ en la raíz
    // (los copia el CI); en el repo viven en ./public, así que si no
    // está en la raíz se busca ahí.
    const candidates = target
      ? [target, join(ROOT, 'public', relative(ROOT, target))]
      : [];

    for (const file of candidates) {
      if (!file) continue;
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        const index = join(file, 'index.html');
        info = await stat(index).catch(() => null);
        if (info?.isFile()) {
          send(res, index, info);
          return;
        }
        continue;
      }
      if (info?.isFile()) {
        send(res, file, info);
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 - No encontrado: ${req.url}\n(Raíz: ${ROOT})`);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 - ${err.message}`);
  }
});

function send(res, file, info) {
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    // Mismas cabeceras que el viejo dev server de Vite
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

server.listen(PORT, () => {
  console.log(`\n  Estacionamiento (sin build) → http://localhost:${PORT}\n`);
  console.log(`  Raíz: ${ROOT}`);
  console.log(`  COOP/COEP activos (crossOriginIsolated = true)\n`);
});
