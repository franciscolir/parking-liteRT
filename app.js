// =============================== IMPORTS ===============================
import { loadLiteRt, loadAndCompile, Tensor } from 'https://cdn.jsdelivr.net/npm/@litertjs/core/+esm';

// =============================== CONSTANTS ===============================
const DB = {
  registered: ['ABC123', 'DEF456', 'GHI789', 'JKL012', 'MNO345', 'PQR678', 'STU901', 'BBBB10'],
  stolen: ['XYZ789', 'LMN456', 'WVU321'],
};
const PLATE_PATTERNS = [/^[A-Z]{4}\d{2}$/, /^[A-Z]{2}\d{4}$/];
const VEHICLE_CLASS_IDS = new Set([3, 4, 6, 8]); // COCO: 3=car, 4=motorcycle, 6=bus, 8=truck
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

// =============================== PERSISTENCE ===============================
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

// =============================== LITERT.JS - INIT ===============================
let liteLoading = false;
async function initLiteRT() {
  if (liteModel || litertReady || liteLoading) return;
  liteLoading = true;
  setStatus('Cargando liteRT.js...');
  try {
    await loadLiteRt('https://cdn.jsdelivr.net/npm/@litertjs/core/wasm/', { jspi: true });
    liteModel = await loadAndCompile(
      'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite',
      { accelerator: 'wasm' }
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

// =============================== LITERT.JS - INFERENCE ===============================
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
  const out0 = outputs[0], out1 = outputs[1];
  if (!out0 || !out1) { outputs.forEach(o => o?.delete()); return []; }

  const s0 = details[0].shape, s1 = details[1].shape;
  const boxData = await out0.toTypedArray();
  const scoreData = await out1.toTypedArray();
  outputs.forEach(o => o.delete());

  const numAnchors = s0[1];
  const numClasses = s1[2];
  const fw = video.videoWidth, fh = video.videoHeight;
  const candidates = [];

  for (let a = 0; a < numAnchors; a++) {
    let bestScore = 0, bestCls = -1;
    for (let c = 0; c < numClasses; c++) {
      const sc = scoreData[a * numClasses + c];
      if (sc > bestScore) { bestScore = sc; bestCls = c; }
    }
    if (bestScore < 0.35 || !VEHICLE_CLASS_IDS.has(bestCls)) continue;

    const ymin = boxData[a * 4], xmin = boxData[a * 4 + 1];
    const ymax = boxData[a * 4 + 2], xmax = boxData[a * 4 + 3];
    candidates.push({
      x: xmin * fw, y: ymin * fh, w: (xmax - xmin) * fw, h: (ymax - ymin) * fh,
      score: bestScore,
    });
  }

  // NMS
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

// =============================== PLATE OCR (canvas-based, no Tesseract) ===============================
function binarize(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const sat = new Uint32Array((canvas.width + 1) * (canvas.height + 1));
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      d[i] = d[i + 1] = d[i + 2] = g;
      sat[(y + 1) * (canvas.width + 1) + (x + 1)] = g + sat[y * (canvas.width + 1) + (x + 1)] + sat[(y + 1) * (canvas.width + 1) + x] - sat[y * (canvas.width + 1) + x];
    }
  }
  const half = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) / 14) * 2 + 1);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const x1 = Math.max(0, x - half), y1 = Math.max(0, y - half);
      const x2 = Math.min(canvas.width, x + half), y2 = Math.min(canvas.height, y + half);
      const sum = sat[y2 * (canvas.width + 1) + x2] - sat[y1 * (canvas.width + 1) + x2] - sat[y2 * (canvas.width + 1) + x1] + sat[y1 * (canvas.width + 1) + x1];
      const local = sum / ((x2 - x1) * (y2 - y1)) - 8;
      const pi = (y * canvas.width + x) * 4;
      d[pi] = d[pi + 1] = d[pi + 2] = d[pi] > local ? 255 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function verticalProjection(canvas) {
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const proj = new Uint32Array(canvas.width);
  for (let x = 0; x < canvas.width; x++) {
    let count = 0;
    for (let y = 0; y < canvas.height; y++) {
      if (img.data[(y * canvas.width + x) * 4] === 0) count++;
    }
    proj[x] = count;
  }
  return proj;
}

function segmentChars(canvas) {
  const proj = verticalProjection(canvas);
  const chars = [];
  let start = -1;
  for (let x = 0; x < proj.length; x++) {
    if (proj[x] > canvas.height * 0.1 && start === -1) start = x;
    else if (proj[x] <= canvas.height * 0.1 && start !== -1) {
      if (x - start > canvas.width * 0.04) chars.push({ x: start, w: x - start });
      start = -1;
    }
  }
  if (start !== -1 && proj.length - start > canvas.width * 0.04) chars.push({ x: start, w: proj.length - start });
  return chars;
}

function charDensity(canvas, cx, cw) {
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const zones = [];
  const zoneW = Math.max(1, Math.floor(cw / 3));
  const zoneH = Math.max(1, Math.floor(canvas.height / 4));
  for (let zy = 0; zy < 4; zy++) {
    for (let zx = 0; zx < 3; zx++) {
      let black = 0, total = 0;
      for (let y = zy * zoneH; y < Math.min((zy + 1) * zoneH, canvas.height); y++) {
        for (let x = cx + zx * zoneW; x < Math.min(cx + (zx + 1) * zoneW, canvas.width); x++) {
          total++;
          if (img.data[(y * canvas.width + x) * 4] === 0) black++;
        }
      }
      zones.push(total > 0 ? black / total : 0);
    }
  }
  return zones;
}

function matchChar(density) {
  const templates = {
    '0': '011,101,101,011', '1': '001,111,001,001',
    '2': '110,001,010,111', '3': '111,001,001,111',
    '4': '101,111,001,001', '5': '111,100,011,111',
    '6': '011,100,111,111', '7': '111,001,010,010',
    '8': '011,101,011,111', '9': '111,111,001,010',
    'A': '010,101,111,101', 'B': '110,101,110,101',
    'C': '011,100,100,011', 'D': '110,101,101,110',
    'E': '111,100,110,111', 'F': '111,100,110,100',
    'G': '011,100,111,011', 'H': '101,111,111,101',
    'I': '111,010,010,111', 'J': '111,001,001,111',
    'K': '101,110,110,101', 'L': '100,100,100,111',
    'M': '101,111,111,101', 'N': '110,111,111,011',
    'O': '011,101,101,011', 'P': '110,101,110,100',
    'R': '110,101,111,101', 'S': '011,100,001,111',
    'T': '111,010,010,010', 'U': '101,101,101,011',
    'V': '101,101,101,010', 'X': '101,010,010,101',
    'Y': '101,010,010,010', 'Z': '111,001,010,111',
  };

  let best = null, bestScore = -1;
  for (const [ch, tmpl] of Object.entries(templates)) {
    const tArr = tmpl.split(',').map(r => [...r].map(c => parseInt(c)));
    let score = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 3; x++) {
        const t = tArr[y][x];
        const d = density[y * 3 + x];
        score += t === 1 ? d : (1 - d);
      }
    }
    if (score > bestScore) { bestScore = score; best = ch; }
  }
  return bestScore > 6 ? best : null;
}

function readPlate(canvas) {
  if (canvas.width < 40 || canvas.height < 20) return null;

  const s = 3;
  const scaled = document.createElement('canvas');
  scaled.width = Math.max(60, Math.round(canvas.width * s));
  scaled.height = Math.max(60, Math.round(canvas.height * s));
  scaled.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0, scaled.width, scaled.height);
  binarize(scaled);

  const chars = segmentChars(scaled);
  if (chars.length < 4 || chars.length > 8) return null;

  // Filter chars by height/width ratio
  const valid = chars.filter(c => c.w / scaled.height > 0.15 && c.w / scaled.height < 1.2);
  if (valid.length < 4) return null;

  let result = '';
  for (const c of valid) {
    const density = charDensity(scaled, c.x, c.w);
    const ch = matchChar(density);
    if (!ch) return null;
    result += ch;
  }

  return result;
}

function correctPlate(raw) {
  const corrections = {
    '0': 'O', 'O': '0', '1': 'I', 'I': '1', '2': 'Z', 'Z': '2',
    '5': 'S', 'S': '5', '8': 'B', 'B': '8', '6': 'G', 'G': '6', '4': 'A', 'A': '4',
  };
  if (PLATE_PATTERNS.some(p => p.test(raw))) return raw;
  for (let i = 0; i < raw.length; i++) {
    if (!corrections[raw[i]]) continue;
    for (const c of corrections[raw[i]]) {
      const t = raw.slice(0, i) + c + raw.slice(i + 1);
      if (PLATE_PATTERNS.some(p => p.test(t))) return t;
    }
  }
  return null;
}

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

// =============================== DETECTION PIPELINE ===============================
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
  const frame = captureFrame();
  if (!frame) return;

  let plate = null;
  const fw = frame.width, fh = frame.height;

  // Center regions
  const regions = [
    { x: fw * 0.1, y: fh * 0.3, w: fw * 0.8, h: fh * 0.4 },
    { x: fw * 0.05, y: fh * 0.45, w: fw * 0.9, h: fh * 0.35 },
  ];
  for (const r of regions) {
    if (plate) break;
    setStatus('Buscando...');
    try { plate = readPlate(crop(frame, r.x, r.y, r.w, r.h)); } catch (e) {}
  }

  // Vehicle detection via LiteRT.js
  if (!plate && litertReady) {
    try {
      setStatus('liteRT.js detectando...');
      const vehicles = await detectVehicles(video);
      for (const v of vehicles) {
        if (plate) break;
        setStatus('Leyendo patente...');
        plate = readPlate(crop(frame, v.x + v.w * 0.12, v.y + v.h * 0.5, v.w * 0.76, v.h * 0.35));
      }
    } catch (e) { console.warn('liteRT error:', e); }
  }

  if (plate) {
    const corrected = correctPlate(plate);
    if (corrected) processPlate(corrected);
    else setStatus('Patente invalida: ' + plate);
  } else {
    setStatus('Sin deteccion');
  }
}

function processPlate(plate) {
  setStatus('Patente: ' + plate);
  const result = document.getElementById('cam-result');
  result.classList.remove('hidden', 'success', 'danger', 'warning');
  document.getElementById('result-plate').textContent = plate;

  let st, css, ico;
  if (DB.stolen.includes(plate)) { st = '\u26A0 VEHICULO DENUNCIADO'; css = 'danger'; ico = '\u26A0'; scanCount.stolen++; }
  else if (DB.registered.includes(plate)) { st = '\u2713 Vehiculo registrado'; css = 'success'; ico = '\u2713'; scanCount.registered++; }
  else { st = '\u26A0 No registrado'; css = 'warning'; ico = '\u26A0'; scanCount.unknown++; }
  scanCount.total++;

  save('plateStats', scanCount); save('plateHistory', scanHistory);
  updateStats();
  result.className = 'camera-result ' + css;
  document.getElementById('result-icon').textContent = ico;
  document.getElementById('result-status').textContent = st;
  scanHistory.unshift({ plate, status: css, time: Date.now() });
  if (scanHistory.length > 20) scanHistory.pop();
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
  save('contacts', contacts);
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
  updateStats(); updateHistory(); renderContacts(); initLiteRT();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
