import * as ort from 'onnxruntime-web';
import { validatePlate, normalizePlate } from './validator.js';
import { Corrector } from './corrector.js';
import { FallbackDetector } from './fallback.js';

const DB = {
  registered: ['ABC123', 'DEF456', 'GHI789', 'JKL012', 'MNO345', 'PQR678', 'STU901', 'BBBB10'],
  stolen: ['XYZ789', 'LMN456', 'WVU321'],
};
const DEFAULT_CONTACTS = [
  { name: 'Policia', phone: '911', type: 'police', icon: '\u{1F6A8}' },
  { name: 'Emergencias', phone: '107', type: 'emergency', icon: '\u{1F691}' },
  { name: 'Bomberos', phone: '100', type: 'fire', icon: '\u{1F525}' },
  { name: 'Hospital', phone: '108', type: 'hospital', icon: '\u{1F3E5}' },
];

let scanHistory = JSON.parse(localStorage.getItem('plateHistory') || '[]');
let scanCount = JSON.parse(localStorage.getItem('plateStats') || '{"total":0,"registered":0,"stolen":0,"unknown":0}');
let contacts = JSON.parse(localStorage.getItem('contacts') || '[]');
if (!contacts.length) contacts = JSON.parse(JSON.stringify(DEFAULT_CONTACTS));
let mediaStream = null, isScanning = false, rafId = null;
let detector = null, ocr = null, corrector = null, fallbackDetector = null;
let ocrChars = [];

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const plateWindow = [];
const WINDOW_SIZE = 5;

function addToWindow(plate) {
  plateWindow.push(plate);
  if (plateWindow.length > WINDOW_SIZE) plateWindow.shift();
}

function getConsensus() {
  if (plateWindow.length < 3) return null;
  const counts = {};
  for (const p of plateWindow) counts[p] = (counts[p] || 0) + 1;
  let best = null, max = 0;
  for (const [p, c] of Object.entries(counts)) { if (c > max) { max = c; best = p; } }
  return max >= 3 ? best : null;
}

let fpsFrames = 0, fpsLastTime = performance.now();
function updateFPS() {
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLastTime >= 1000) {
    const fps = Math.round(fpsFrames * 1000 / (now - fpsLastTime));
    const el = document.getElementById('hud-fps');
    if (el) el.textContent = 'FPS ' + fps;
    fpsFrames = 0;
    fpsLastTime = now;
  }
}

let idb = null;

function initDB() {
  return new Promise(resolve => {
    if (!indexedDB) { resolve(null); return; }
    const req = indexedDB.open('platedetect', 1);
    req.onsuccess = () => { idb = req.result; resolve(idb); };
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
    };
  });
}

function saveIDB(value) {
  if (!idb) return;
  const tx = idb.transaction('history', 'readwrite');
  tx.objectStore('history').put(value);
}

async function fetchArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Fetch ' + url + ' ' + res.status);
  return await res.arrayBuffer();
}

let useGPU = false;

function detectGPU() {
  useGPU = !!navigator.gpu;
  const hud = document.getElementById('hud-gpu');
  if (hud) hud.textContent = useGPU ? 'GPU' : 'CPU';
}

async function initModels() {
  setStatus('Cargando modelos...');
  detectGPU();

  const ep = ['webgl', 'wasm'];

  try {
    corrector = new Corrector();
    fallbackDetector = new FallbackDetector();

    setStatus('Cargando detector YOLOv8...');
    const detBuf = await fetchArrayBuffer('models/yolov8_plate.onnx');
    detector = await ort.InferenceSession.create(detBuf, { executionProviders: ep });

    setStatus('Cargando OCR PP-OCRv4...');
    const ocrBuf = await fetchArrayBuffer('models/ppocr_rec.onnx');
    ocr = await ort.InferenceSession.create(ocrBuf, { executionProviders: ep });

    const resp = await fetch('models/ppocr_keys.json');
    ocrChars = await resp.json();

    setStatus('Calentando modelos...');
    try {
      await Promise.race([
        Promise.all([warmupDetector(), warmupOCR()]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
      ]);
    } catch (e) { console.warn('warmup skip:', e.message); }

    setStatus('Modelos listos');
    console.log('YOLO inputs:', detector.inputNames, 'outputs:', detector.outputNames);
    console.log('OCR inputs:', ocr.inputNames, 'outputs:', ocr.outputNames);
  } catch (e) {
    console.error('initModels error:', e);
    setStatus('Error: ' + e.message);
  }
}

async function warmupDetector() {
  if (!detector) return;
  const sz = 640;
  const dummy = new ort.Tensor('float32', new Float32Array(3 * sz * sz), [1, 3, sz, sz]);
  await detector.run({ [detector.inputNames[0]]: dummy });
}

async function warmupOCR() {
  if (!ocr) return;
  const w = 100, h = 48;
  const dummy = new ort.Tensor('float32', new Float32Array(3 * h * w), [1, 3, h, w]);
  await ocr.run({ [ocr.inputNames[0]]: dummy });
}

let _detCanvas = null;
let _detCtx = null;
let _detTransform = null;

function preprocessDetector(video) {
  const vw = video.videoWidth || video.width || 0;
  const vh = video.videoHeight || video.height || 0;
  const sz = 640;
  const maxSize = Math.max(vw, vh);
  const scale = sz / maxSize;
  const ox = (sz - vw * scale) / 2;
  const oy = (sz - vh * scale) / 2;
  _detTransform = { scale, ox, oy, vw, vh };

  if (!_detCanvas) {
    _detCanvas = document.createElement('canvas');
    _detCtx = _detCanvas.getContext('2d', { willReadFrequently: true });
  }
  _detCanvas.width = sz;
  _detCanvas.height = sz;
  _detCtx.fillStyle = '#000';
  _detCtx.fillRect(0, 0, sz, sz);
  _detCtx.drawImage(video, ox, oy, vw * scale, vh * scale);

  const rgba = _detCtx.getImageData(0, 0, sz, sz).data;
  const ch = sz * sz;
  const data = new Float32Array(3 * ch);
  for (let i = 0; i < ch; i++) {
    const pi = i << 2;
    data[i] = rgba[pi] / 255;
    data[ch + i] = rgba[pi + 1] / 255;
    data[2 * ch + i] = rgba[pi + 2] / 255;
  }
  return new ort.Tensor('float32', data, [1, 3, sz, sz]);
}

function decodeYOLO(data, dims, confThreshold, iouThreshold) {
  const numPreds = dims[2];
  const raw = [];
  const maxCx = Math.max(...Array.from(data.subarray(0, Math.min(numPreds, 100))));
  const normalized = maxCx < 2;
  const sc = normalized ? 640 : 1;

  for (let i = 0; i < numPreds; i++) {
    const cx = data[i];
    const cy = data[numPreds + i];
    const w = data[2 * numPreds + i];
    const h = data[3 * numPreds + i];
    const conf = data[4 * numPreds + i];
    if (conf < 0.05) continue;
    raw.push({
      x1: (cx - w / 2) * sc,
      y1: (cy - h / 2) * sc,
      x2: (cx + w / 2) * sc,
      y2: (cy + h / 2) * sc,
      score: conf,
    });
  }

  raw.sort((a, b) => b.score - a.score);
  const picked = new Array(raw.length).fill(false);
  const result = [];
  for (let i = 0; i < raw.length; i++) {
    if (picked[i]) continue;
    if (raw[i].score < confThreshold) continue;
    result.push(raw[i]);
    for (let j = i + 1; j < raw.length; j++) {
      if (picked[j]) continue;
      const iou = iouCalc(raw[i], raw[j]);
      if (iou >= iouThreshold) picked[j] = true;
    }
  }
  return result;
}

function iouCalc(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-6);
}

function toOriginalBox(box) {
  const t = _detTransform;
  return {
    x1: Math.max(0, (box.x1 - t.ox) / t.scale),
    y1: Math.max(0, (box.y1 - t.oy) / t.scale),
    x2: Math.min(t.vw, (box.x2 - t.ox) / t.scale),
    y2: Math.min(t.vh, (box.y2 - t.oy) / t.scale),
    score: box.score,
  };
}

async function detectPlate(video) {
  if (!detector) return [];
  const input = preprocessDetector(video);
  const results = await detector.run({ [detector.inputNames[0]]: input });
  const output = results[detector.outputNames[0]];

  const confThreshold = 0.15;
  const iouThreshold = 0.45;

  let boxData;
  if (output.data instanceof Float32Array) {
    boxData = output.data;
  } else {
    boxData = new Float32Array(output.data.length);
    for (let i = 0; i < output.data.length; i++) boxData[i] = output.data[i];
  }

  const rawBoxes = decodeYOLO(boxData, output.dims, confThreshold, iouThreshold);
  const mapped = rawBoxes.map(b => toOriginalBox(b)).filter(b => {
    const w = b.x2 - b.x1;
    const h = b.y2 - b.y1;
    return w >= 30 && h >= 10 && w / h < 12;
  });
  return mapped;
}

let _cropCanvas = null;
let _cropCtx = null;

function cropImageData(video, box) {
  const w = Math.round(box.x2 - box.x1);
  const h = Math.round(box.y2 - box.y1);
  if (w < 4 || h < 4) return null;
  if (!_cropCanvas) {
    _cropCanvas = document.createElement('canvas');
    _cropCtx = _cropCanvas.getContext('2d', { willReadFrequently: true });
  }
  _cropCanvas.width = w;
  _cropCanvas.height = h;
  _cropCtx.drawImage(video, box.x1, box.y1, w, h, 0, 0, w, h);
  return _cropCtx.getImageData(0, 0, w, h);
}

let _ocrSrcCanvas = null;
let _ocrDstCanvas = null;
let _ocrDstCtx = null;

function preprocessOCR(imageData) {
  const oldW = imageData.width;
  const oldH = imageData.height;
  const newH = 48;
  const newW = Math.max(1, Math.round(oldW * (newH / oldH)));

  if (!_ocrSrcCanvas) {
    _ocrSrcCanvas = document.createElement('canvas');
    _ocrDstCanvas = document.createElement('canvas');
    _ocrDstCtx = _ocrDstCanvas.getContext('2d', { willReadFrequently: true });
  }
  _ocrSrcCanvas.width = oldW;
  _ocrSrcCanvas.height = oldH;
  _ocrSrcCanvas.getContext('2d').putImageData(imageData, 0, 0);

  _ocrDstCanvas.width = newW;
  _ocrDstCanvas.height = newH;
  _ocrDstCtx.drawImage(_ocrSrcCanvas, 0, 0, newW, newH);

  const resized = _ocrDstCtx.getImageData(0, 0, newW, newH);
  const pixels = resized.data;
  const nchw = new Float32Array(3 * newH * newW);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcIdx = (y * newW + x) * 4;
      const dstIdx = y * newW + x;
      nchw[dstIdx] = pixels[srcIdx] / 127.5 - 1.0;
      nchw[newH * newW + dstIdx] = pixels[srcIdx + 1] / 127.5 - 1.0;
      nchw[2 * newH * newW + dstIdx] = pixels[srcIdx + 2] / 127.5 - 1.0;
    }
  }
  return new ort.Tensor('float32', nchw, [1, 3, newH, newW]);
}

function ctcGreedyDecode(data, dims) {
  const timeSteps = dims[1];
  const vocabSize = dims[2];
  let prev = 0;
  let result = '';
  for (let t = 0; t < timeSteps; t++) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    const offset = t * vocabSize;
    for (let v = 0; v < vocabSize; v++) {
      if (data[offset + v] > bestVal) {
        bestVal = data[offset + v];
        bestIdx = v;
      }
    }
    if (bestIdx !== 0 && bestIdx !== prev) {
      const ch = ocrChars[bestIdx];
      if (ch) result += ch;
    }
    prev = bestIdx;
  }
  return result;
}

async function recognizePlate(imageData) {
  if (!ocr || !ocrChars.length) return '';
  const input = preprocessOCR(imageData);
  const results = await ocr.run({ [ocr.inputNames[0]]: input });

  let outData;
  const out = results[ocr.outputNames[0]];
  if (out.data instanceof Float32Array) {
    outData = out.data;
  } else {
    outData = new Float32Array(out.data.length);
    for (let i = 0; i < out.data.length; i++) outData[i] = out.data[i];
  }
  return ctcGreedyDecode(outData, out.dims);
}

let _yoloCounter = 0;
const _yoloSkip = isMobile ? 3 : 2;
let _lastGoodBox = null;
let _goodBoxAge = 0;

let _ocrCounter = 0;
const _ocrSkipInterval = isMobile ? 2 : 3;
let _lastBoxCenter = null;

let _lastPlate = null;
let _noDetectFrames = 0;
const NO_DETECT_LIMIT = 20;

let _smoothFallback = null;

async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: isMobile ? 640 : 1280 }, height: { ideal: isMobile ? 480 : 720 } },
      audio: false,
    });
    document.getElementById('video').srcObject = mediaStream;
    await document.getElementById('video').play();
    setStatus('Listo');
    return true;
  } catch (e) {
    showToast('Error al acceder a la camara: ' + e.message, 'error');
    return false;
  }
}

function setStatus(msg) { const el = document.getElementById('cam-status'); if (el) el.textContent = msg; }

function stopCamera() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  isScanning = false;
  _yoloCounter = 0;
  _lastGoodBox = null;
  _goodBoxAge = 0;
  _ocrCounter = 0;
  _lastBoxCenter = null;
  _lastPlate = null;
  _noDetectFrames = 0;
  if (fallbackDetector) fallbackDetector.reset();
  _smoothFallback = null;
  plateWindow.length = 0;
  document.getElementById('scan-toggle').checked = false;
  document.getElementById('switch-label').textContent = 'Iniciar deteccion';
  document.getElementById('cam-status').classList.remove('scanning');
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  setStatus('En espera');
  hideOverlay();
}

window.toggleScan = async function () {
  if (isScanning) { stopCamera(); setStatus('Detenido'); return; }
  if (!mediaStream && !(await startCamera())) { document.getElementById('scan-toggle').checked = false; return; }
  isScanning = true;
  document.getElementById('switch-label').textContent = 'Apagar camara';
  document.getElementById('cam-status').classList.add('scanning');
  setStatus('Escaneando...');
  _lastPlate = null;
  _noDetectFrames = 0;
  if (fallbackDetector) fallbackDetector.reset();
  if (detector) _smoothFallback = null;
  requestAnimationFrame(loop);
};

async function loop() {
  if (!isScanning) return;
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) { rafId = requestAnimationFrame(loop); return; }
  updateFPS();

  let boxes = [];
  _yoloCounter++;
  const skip = (_yoloCounter % _yoloSkip !== 0) && _lastGoodBox && _goodBoxAge < 8;

  if (skip) {
    _goodBoxAge++;
    if (_lastGoodBox) boxes = [{ ..._lastGoodBox }];
  } else if (detector) {
    try {
      boxes = await detectPlate(video);
      if (boxes.length > 0) {
        _lastGoodBox = { ...boxes[0] };
        _goodBoxAge = 0;
      } else {
        _goodBoxAge++;
      }
    } catch (e) { console.warn('YOLO error:', e); }
  }

  if (boxes.length === 0 && fallbackDetector) {
    const fb = fallbackDetector.detect(video);
    if (fb && fb.score > 0.3) {
      if (_smoothFallback) {
        const alpha = 0.35;
        _smoothFallback.x1 += (fb.x1 - _smoothFallback.x1) * alpha;
        _smoothFallback.y1 += (fb.y1 - _smoothFallback.y1) * alpha;
        _smoothFallback.x2 += (fb.x2 - _smoothFallback.x2) * alpha;
        _smoothFallback.y2 += (fb.y2 - _smoothFallback.y2) * alpha;
        _smoothFallback.score = fb.score;
      } else {
        _smoothFallback = { x1: fb.x1, y1: fb.y1, x2: fb.x2, y2: fb.y2, score: fb.score };
      }
      boxes = [{ ..._smoothFallback }];
    } else {
      _smoothFallback = null;
    }
  }

  drawOverlay(boxes);

  if (boxes.length > 0) {
    _noDetectFrames = 0;
    const box = boxes[0];
    const center = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
    const isStable = _lastBoxCenter &&
      Math.abs(center.x - _lastBoxCenter.x) < bw * 0.15 &&
      Math.abs(center.y - _lastBoxCenter.y) < bh * 0.15;
    _lastBoxCenter = center;

    _ocrCounter++;
    const skipOCR = isStable && (_ocrCounter % _ocrSkipInterval !== 0);

    if (!skipOCR) {
      const crop = cropImageData(video, box);
      if (crop) {
        let rawText = '';
        try {
          rawText = await recognizePlate(crop);
        } catch (e) { console.warn('OCR error:', e); }

        if (rawText) {
          const normalized = normalizePlate(rawText);
          const corrected = corrector ? corrector.correct(normalized) : normalized;
          if (validatePlate(corrected)) {
            addToWindow(corrected);
            const consensus = getConsensus();
            if (consensus && consensus !== _lastPlate) {
              _lastPlate = consensus;
              processPlate(consensus);
              plateWindow.length = 0;
            } else if (!_lastPlate) {
              showOverlay(corrected, 'warning', 'Confirmando...');
            }
          } else {
            plateWindow.length = 0;
          }
        } else {
          plateWindow.length = 0;
        }
      }
    }
  } else {
    _noDetectFrames++;
    plateWindow.length = 0;
    if (_noDetectFrames > NO_DETECT_LIMIT && _lastPlate) {
      _lastPlate = null;
      hideOverlay();
    }
  }

  rafId = requestAnimationFrame(loop);
}

function drawOverlay(boxes) {
  const overlay = document.getElementById('scan-frame');
  const video = document.getElementById('video');
  if (!overlay || !video.videoWidth) return;
  if (boxes.length === 0) {
    overlay.classList.remove('active');
    overlay.style.left = overlay.style.top = overlay.style.width = overlay.style.height = '';
    return;
  }
  const b = boxes[0];
  const scaleX = video.clientWidth / video.videoWidth;
  const scaleY = video.clientHeight / video.videoHeight;
  const w = b.x2 - b.x1;
  const h = b.y2 - b.y1;
  overlay.style.left = (b.x1 * scaleX) + 'px';
  overlay.style.top = (b.y1 * scaleY) + 'px';
  overlay.style.width = (w * scaleX) + 'px';
  overlay.style.height = (h * scaleY) + 'px';
  overlay.style.borderColor = b.score > 0.5 ? '#00ff66' : '#ffcc00';
  overlay.classList.add('active');
}

function showOverlay(plate, type, statusText) {
  const el = document.getElementById('overlay-result');
  if (!el) return;
  el.classList.remove('hidden');
  document.getElementById('overlay-plate').textContent = plate;
  const st = document.getElementById('overlay-status');
  st.className = 'overlay-status ' + type;
  st.textContent = statusText;
}

function hideOverlay() {
  const el = document.getElementById('overlay-result');
  if (el) el.classList.add('hidden');
}

function processPlate(plate) {
  setStatus('Patente: ' + plate);
  const result = document.getElementById('cam-result');
  result.classList.remove('hidden', 'success', 'danger', 'warning');
  document.getElementById('result-plate').textContent = plate;

  let st, css, ico;
  if (DB.stolen.includes(plate)) { st = '\u26A0 VEHICULO DENUNCIADO'; css = 'danger'; ico = '\u{1F534}'; scanCount.stolen++; }
  else if (DB.registered.includes(plate)) { st = '\u2713 Vehiculo registrado'; css = 'success'; ico = '\u{1F7E2}'; scanCount.registered++; }
  else { st = '\u26A0 No registrado'; css = 'warning'; ico = '\u{1F534}'; scanCount.unknown++; }
  scanCount.total++;

  scanHistory.unshift({ plate, status: css, time: Date.now() });
  if (scanHistory.length > 20) scanHistory.pop();
  localStorage.setItem('plateStats', JSON.stringify(scanCount));
  localStorage.setItem('plateHistory', JSON.stringify(scanHistory));
  saveIDB({ plate, status: css, time: Date.now() });
  updateStats();
  result.className = 'camera-result ' + css;
  document.getElementById('result-icon').textContent = ico;
  document.getElementById('result-status').textContent = st;
  showOverlay(plate, css, st.replace(/[\u26A0\u2713]/g, '').trim());
  updateHistory();
  if (navigator.vibrate) navigator.vibrate(100);
  document.getElementById('reg-plate').value = plate;
}

function updateHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (!scanHistory.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Sin detecciones recientes</div>'; return; }
  list.innerHTML = scanHistory.slice(0, 10).map(h => {
    const sc = h.status === 'success' ? 'reg' : h.status === 'danger' ? 'stolen' : 'unk';
    const st = h.status === 'success' ? 'Registrada' : h.status === 'danger' ? 'Denunciada' : 'Desconocida';
    return '<div class="history-item"><span class="h-plate">' + h.plate + '</span><span class="h-status ' + sc + '">' + st + '</span></div>';
  }).join('');
}

function updateStats() {
  document.getElementById('stat-total').textContent = scanCount.total;
  document.getElementById('stat-reg').textContent = scanCount.registered;
  document.getElementById('stat-stolen').textContent = scanCount.stolen;
  document.getElementById('stat-unknown').textContent = scanCount.unknown;
}

window.navigate = function (view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const vEl = document.getElementById('view-' + view);
  if (vEl) vEl.classList.add('active');
  const nEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (nEl) nEl.classList.add('active');
  if (view !== 'camera') stopCamera();
  if (view === 'camera') updateHistory();
  if (view === 'home') updateStats();
  if (view === 'call') renderContacts();
};

window.sendWhatsApp = function () {
  const p = document.getElementById('reg-plate').value.trim();
  const v = document.getElementById('reg-vehicle').value;
  const i = document.getElementById('reg-incident').value;
  const l = document.getElementById('reg-location').value.trim();
  const d = document.getElementById('reg-desc').value.trim();
  if (!p || !v || !i) { showToast('Complete patente, vehiculo e incidente', 'error'); return; }
  const msg = ['\u{1F6A8} *REPORTE DE INCIDENTE*', '', '*Patente:* ' + p.toUpperCase(), '*Vehiculo:* ' + v, '*Incidente:* ' + i, l ? '*Ubicacion:* ' + l : '', d ? '*Descripcion:* ' + d : '', '', 'Enviado desde PlateDetect'].filter(Boolean).join('\n');
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
};

function renderContacts() {
  document.getElementById('contact-grid').innerHTML = contacts.map(c =>
    '<div class="contact-card"><div class="avatar ' + (c.type || 'custom') + '">' + (c.icon || '\u{1F4DE}') + '</div><div class="info"><div class="name">' + c.name + '</div><div class="phone">' + c.phone + '</div></div><button class="call-btn" onclick="callContact(\'' + c.phone + '\')"><svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></button></div>'
  ).join('');
}

window.callContact = function (p) { window.location.href = 'tel:' + p; };
window.addContact = function () {
  const name = document.getElementById('new-contact-name').value.trim();
  const phone = document.getElementById('new-contact-phone').value.trim();
  if (!name || !phone) { showToast('Ingrese nombre y telefono', 'error'); return; }
  contacts.push({ name, phone, type: 'custom', icon: '\u{1F4DE}' });
  localStorage.setItem('contacts', JSON.stringify(contacts));
  renderContacts();
  document.getElementById('new-contact-name').value = '';
  document.getElementById('new-contact-phone').value = '';
  showToast('Contacto agregado', 'success');
};

function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.innerHTML = msg;
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3000);
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-home-scan').onclick = () => window.navigate('camera');
  document.getElementById('scan-toggle').onchange = window.toggleScan;
  document.getElementById('btn-send-whatsapp').onclick = window.sendWhatsApp;
  document.getElementById('btn-add-contact').onclick = window.addContact;
  document.querySelectorAll('.nav-item[data-view]').forEach(n => {
    n.onclick = () => { window.navigate(n.dataset.view); if (n.dataset.view === 'camera') initModels(); };
  });
  document.getElementById('cam-result').onclick = function () {
    const txt = document.getElementById('result-plate').textContent;
    if (txt !== '---') { document.getElementById('reg-plate').value = txt; window.navigate('register'); }
  };
  updateStats(); updateHistory(); renderContacts(); initDB(); initModels();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});