// Simple static server to serve the dist folder
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const DIST  = path.join(__dirname, 'dist');

const mimeTypes = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.txt':  'text/plain',
  '.png':  'image/png',
};

function getMime(ext){ return mimeTypes[ext] || 'application/octet-stream'; }

function serveFile(filePath, res){
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data)=>{ 
    if(err){
      res.writeHead(404, { 'Content-Type': 'text/plain'});
      res.end('404 Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': getMime(ext)});
      res.end(data);
    }
  });
}

const server = http.createServer((req, res)=>{
  let reqPath = decodeURI(req.url.split('?')[0]);
  if(reqPath=== '/') reqPath = '/index.html';
  const filePath = path.join(DIST, reqPath);
  serveFile(filePath, res);
});

server.listen(PORT, ()=>{ console.log(`Serving ${DIST} on http://localhost:${PORT}`); });
