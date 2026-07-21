// =============================== IMPORTS ===============================
import { loadLiteRt, loadAndCompile, Tensor } from 'https://cdn.jsdelivr.net/npm/@litertjs/core/+esm';

// =============================== CONSTANTS ===============================
const DB = {
  registered: ['ABC123', 'DEF456', 'GHI789', 'JKL012', 'MNO345', 'PQR678', 'STU901', 'BBBB10'],
  stolen: ['XYZ789', 'LMN456', 'WVU321'],
};
const PLATE_PATTERNS = [/^[A-Z]{4}\d{2}$/, /^[A-Z]{2}\d{4}$/];
const VEHICLE_CLASS_IDS = new Set([3, 4, 6, 8]);
const DEFAULT_CONTACTS = [
  { name: 'Policia', phone: '911', type: 'police', icon: '\u{1F6A8}' },
  { name: 'Emergencias', phone: '107', type: 'emergency', icon: '\u{1F691}' },
  { name: 'Bomberos', phone: '100', type: 'fire', icon: '\u{1F525}' },
  { name: 'Hospital', phone: '108', type: 'hospital', icon: '\u{1F3E5}' },
];

// =============================== STATE ===============================
let scanHistory = JSON.parse(localStorage.getItem('plateHistory') || '[]');
let scanCount = JSON.parse(localStorage.getItem('plateStats') || '{"total":0,"registered":0,"stolen":0,"unknown":0}');
let contacts = JSON.parse(localStorage.getItem('contacts') || '[]');
if (!contacts.length) contacts = JSON.parse(JSON.stringify(DEFAULT_CONTACTS));
let mediaStream = null, isScanning = false, scanTimer = null;
let liteModel = null, litertReady = false, INPUT_SIZE = 320;
let ocrWorker = null;

// =============================== SLIDING WINDOW ===============================
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

// =============================== FPS COUNTER ===============================
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

// =============================== NORMALIZACION OCR ===============================
function normalizeOCR(text) {
  let t = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const map = { O: '0', I: '1', Z: '2', S: '5', B: '8' };
  if (PLATE_PATTERNS[0].test(t)) {
    t = t.slice(0, 4) + (map[t[4]] || t[4]) + (map[t[5]] || t[5]);
  } else if (PLATE_PATTERNS[1].test(t)) {
    t = t.slice(0, 2) + t.slice(2).replace(/[OISZB]/g, c => map[c] || c);
  }
  return t;
}

// =============================== INDEXEDDB ===============================
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

// =============================== LITERT.JS ===============================
let liteLoading = false, useGPU = false;

function detectGPU() {
  useGPU = !!navigator.gpu;
  const hud = document.getElementById('hud-gpu');
  if (hud) hud.textContent = useGPU ? 'GPU' : 'CPU';
}

async function initLiteRT() {
  if (liteModel || litertReady || liteLoading) return;
  liteLoading = true;
  setStatus('Cargando liteRT.js...');
  detectGPU();
  try {
    await loadLiteRt('https://cdn.jsdelivr.net/npm/@litertjs/core/wasm/', { jspi: true });
    liteModel = await loadAndCompile(
      'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite',
      { accelerator: useGPU ? 'webgpu' : 'wasm' }
    );
    INPUT_SIZE = liteModel.getInputDetails()[0]?.shape[1] || 320;
    console.log('liteRT outputs:', liteModel.getOutputDetails().map(d => d.name + ' ' + JSON.stringify(d.shape)));
    setStatus('liteRT.js listo');
    litertReady = true; liteLoading = false;
  } catch (e) {
    console.warn('liteRT.js no disponible:', e);
    setStatus('Modo sin IA'); liteLoading = false;
  }
}

function tensorFromFrame(frame) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const pixels = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const data = new Float32Array(INPUT_SIZE * INPUT_SIZE * 3);
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    data[i * 3] = pixels[i * 4] / 255;
    data[i * 3 + 1] = pixels[i * 4 + 1] / 255;
    data[i * 3 + 2] = pixels[i * 4 + 2] / 255;
  }
  return new Tensor(data, [1, INPUT_SIZE, INPUT_SIZE, 3]);
}

async function detectVehicles(video) {
  if (!liteModel || !litertReady) return [];
  const inputTensor = tensorFromFrame(video);
  const outputs = await liteModel.run(inputTensor);
  inputTensor.delete();

  const details = liteModel.getOutputDetails();
  if (!outputs[0] || !outputs[1]) { outputs.forEach(o => o?.delete()); return []; }

  const boxData = await outputs[0].toTypedArray();
  const scoreData = await outputs[1].toTypedArray();
  outputs.forEach(o => o.delete());

  const numAnchors = details[0].shape[1];
  const numClasses = details[1].shape[2];
  const fw = video.videoWidth, fh = video.videoHeight;
  const candidates = [];

  for (let a = 0; a < numAnchors; a++) {
    let bestScore = 0, bestCls = -1;
    for (let c = 0; c < numClasses; c++) {
      const sc = scoreData[a * numClasses + c];
      if (sc > bestScore) { bestScore = sc; bestCls = c; }
    }
    if (bestScore < 0.35 || !VEHICLE_CLASS_IDS.has(bestCls)) continue;
    candidates.push({
      x: boxData[a * 4 + 1] * fw, y: boxData[a * 4] * fh,
      w: (boxData[a * 4 + 3] - boxData[a * 4 + 1]) * fw, h: (boxData[a * 4 + 2] - boxData[a * 4]) * fh,
      score: bestScore,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of candidates) {
    let overlap = false;
    for (const k of keep) {
      const ix1 = Math.max(c.x, k.x), iy1 = Math.max(c.y, k.y);
      const ix2 = Math.min(c.x + c.w, k.x + k.w), iy2 = Math.min(c.y + c.h, k.y + k.h);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const union = c.w * c.h + k.w * k.h - inter;
      if (inter / union > 0.5) { overlap = true; break; }
    }
    if (!overlap) keep.push(c);
  }
  return keep;
}

// =============================== OCR WORKER ===============================
function initWorker() {
  try { ocrWorker = new Worker('ocr-worker.js'); } catch (e) { console.warn('Worker no disponible'); }
}

function readPlateInWorker(canvas) {
  return new Promise(resolve => {
    if (!ocrWorker) { resolve(null); return; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const handler = e => { ocrWorker.removeEventListener('message', handler); resolve(e.data.plate); };
    ocrWorker.addEventListener('message', handler);
    try {
      ocrWorker.postMessage({ imageData, width: canvas.width, height: canvas.height }, [imageData.data.buffer]);
    } catch { ocrWorker.postMessage({ imageData, width: canvas.width, height: canvas.height }); }
  });
}

const tick = () => new Promise(r => setTimeout(r, 0));

// =============================== CAMERA ===============================
async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
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
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  isScanning = false;
  document.getElementById('scan-toggle').checked = false;
  document.getElementById('switch-label').textContent = 'Iniciar deteccion';
  document.getElementById('cam-status').classList.remove('scanning');
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  setStatus('En espera');
}

window.toggleScan = async function () {
  if (isScanning) { stopCamera(); setStatus('Detenido'); return; }
  if (!mediaStream && !(await startCamera())) { document.getElementById('scan-toggle').checked = false; return; }
  isScanning = true;
  document.getElementById('switch-label').textContent = 'Apagar camara';
  document.getElementById('cam-status').classList.add('scanning');
  setStatus('Escaneando...');
  await detect();
  scanTimer = setInterval(detect, 2500);
};

// =============================== DETECTION ===============================
function captureFrame() {
  const v = document.getElementById('video');
  if (!v || !v.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return c;
}

function crop(src, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(40, Math.round(w)); c.height = Math.max(40, Math.round(h));
  c.getContext('2d').drawImage(src, Math.round(x), Math.round(y), Math.round(w), Math.round(h), 0, 0, c.width, c.height);
  return c;
}

async function detect() {
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) return;
  updateFPS();
  const frame = captureFrame();
  if (!frame) return;

  let plate = null;
  const fw = frame.width, fh = frame.height;
  const scanW = 240, scanH = 80;

  for (let sy = 0; sy < 3 && !plate; sy++) {
    for (let sx = 0; sx < 4 && !plate; sx++) {
      const rx = fw * 0.15 + sx * (fw * 0.7 / 4);
      const ry = fh * 0.25 + sy * (fh * 0.4 / 3);
      setStatus('Buscando...');
      try { plate = await readPlateInWorker(crop(frame, rx, ry, scanW, scanH)); } catch (e) {}
      await tick();
    }
  }

  let detectedBox = null;
  if (!plate && litertReady) {
    try {
      setStatus('liteRT.js detectando...');
      await tick();
      const vehicles = await detectVehicles(video);
      for (const v of vehicles) {
        if (plate) break;
        setStatus('Leyendo patente...');
        detectedBox = v;
        plate = await readPlateInWorker(crop(frame, v.x + v.w * 0.12, v.y + v.h * 0.5, v.w * 0.76, v.h * 0.35));
        await tick();
      }
    } catch (e) { console.warn('liteRT error:', e); }
  }

  if (detectedBox) drawDetectionBox(detectedBox);

  if (plate) {
    const normalized = normalizeOCR(plate);
    const corrected = correctPlate(normalized);
    if (corrected) {
      addToWindow(corrected);
      const consensus = getConsensus();
      if (consensus) { processPlate(consensus); plateWindow.length = 0; }
      else showOverlay(corrected, 'warning', 'Confirmando...');
    } else {
      setStatus('Patente invalida: ' + plate);
      plateWindow.length = 0;
    }
  } else {
    setStatus('Sin deteccion');
    hideOverlay();
  }
}

function drawDetectionBox(v) {
  const sf = document.getElementById('scan-frame');
  if (!sf) return;
  const video = document.getElementById('video');
  if (!video.videoWidth) return;
  const scaleX = video.clientWidth / video.videoWidth;
  const scaleY = video.clientHeight / video.videoHeight;
  sf.style.left = (v.x * scaleX) + 'px';
  sf.style.top = (v.y * scaleY) + 'px';
  sf.style.width = (v.w * scaleX) + 'px';
  sf.style.height = (v.h * scaleY) + 'px';
  sf.style.transform = 'none';
  sf.classList.add('active');
  setTimeout(() => {
    sf.classList.remove('active');
    sf.style.left = sf.style.top = sf.style.width = sf.style.height = sf.style.transform = '';
  }, 1000);
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

function correctPlate(raw) {
  const c = { '0':'O','O':'0','1':'I','I':'1','2':'Z','Z':'2','5':'S','S':'5','8':'B','B':'8','6':'G','G':'6','4':'A','A':'4' };
  if (PLATE_PATTERNS.some(p => p.test(raw))) return raw;
  for (let i = 0; i < raw.length; i++) {
    if (!c[raw[i]]) continue;
    for (const r of c[raw[i]]) {
      const t = raw.slice(0, i) + r + raw.slice(i + 1);
      if (PLATE_PATTERNS.some(p => p.test(t))) return t;
    }
  }
  return null;
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

// =============================== UI ===============================
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

// =============================== INIT ===============================
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-home-scan').onclick = () => window.navigate('camera');
  document.getElementById('scan-toggle').onchange = window.toggleScan;
  document.getElementById('btn-send-whatsapp').onclick = window.sendWhatsApp;
  document.getElementById('btn-add-contact').onclick = window.addContact;
  document.querySelectorAll('.nav-item[data-view]').forEach(n => {
    n.onclick = () => { window.navigate(n.dataset.view); if (n.dataset.view === 'camera') initLiteRT(); };
  });
  document.getElementById('cam-result').onclick = function () {
    const txt = document.getElementById('result-plate').textContent;
    if (txt !== '---') { document.getElementById('reg-plate').value = txt; window.navigate('register'); }
  };
  updateStats(); updateHistory(); renderContacts(); initLiteRT(); initWorker(); initDB();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});