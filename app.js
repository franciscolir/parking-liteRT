// =============================== IMPORTS ===============================
import { loadLiteRt, loadAndCompile, Tensor } from 'https://cdn.jsdelivr.net/npm/@litertjs/core/+esm';

// =============================== DATABASE ===============================
const DB = {
  registered: ['ABC123', 'DEF456', 'GHI789', 'JKL012', 'MNO345', 'PQR678', 'STU901', 'BBBB10'],
  stolen: ['XYZ789', 'LMN456', 'WVU321'],
};

let scanHistory = JSON.parse(localStorage.getItem('plateHistory') || '[]');
let scanCount = JSON.parse(localStorage.getItem('plateStats') || '{"total":0,"registered":0,"stolen":0,"unknown":0}');
let contacts = JSON.parse(localStorage.getItem('contacts') || '[]');

const defaultContacts = [
  { name: 'Policia', phone: '911', type: 'police', icon: '\u{1F6A8}' },
  { name: 'Emergencias', phone: '107', type: 'emergency', icon: '\u{1F691}' },
  { name: 'Bomberos', phone: '100', type: 'fire', icon: '\u{1F525}' },
  { name: 'Hospital', phone: '108', type: 'hospital', icon: '\u{1F3E5}' },
];

if (!contacts.length) contacts = JSON.parse(JSON.stringify(defaultContacts));

function saveStats() { localStorage.setItem('plateStats', JSON.stringify(scanCount)); }
function saveHistory() { localStorage.setItem('plateHistory', JSON.stringify(scanHistory)); }
function saveContacts() { localStorage.setItem('contacts', JSON.stringify(contacts)); }

// =============================== LITERT.JS ENGINE ===============================
let liteModel = null;
let litertReady = false;
let INPUT_SIZE = 320;

const VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle'];
const COCO_LABELS = [
  'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
  'traffic light','fire hydrant','street sign','stop sign','parking meter','bench',
  'bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe',
  'hat','backpack','umbrella','shoe','eye glasses','handbag','tie','suitcase',
  'frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove',
  'skateboard','surfboard','tennis racket','bottle','plate','wine glass','cup',
  'fork','knife','spoon','bowl','banana','apple','sandwich','orange','broccoli',
  'carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed',
  'mirror','dining table','window','desk','toilet','door','tv','laptop','mouse',
  'remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator',
  'blender','book','clock','vase','scissors','teddy bear','hair drier','toothbrush','hair brush'
];

async function initLiteRT() {
  setStatus('Cargando liteRT.js...');
  try {
    await loadLiteRt('https://cdn.jsdelivr.net/npm/@litertjs/core/wasm/', { jspi: true });
    liteModel = await loadAndCompile(
      'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite',
      { accelerator: 'wasm' }
    );
    const inDetails = liteModel.getInputDetails();
    if (inDetails.length > 0) INPUT_SIZE = inDetails[0].shape[1];
    const outDetails = liteModel.getOutputDetails();
    console.log('liteRT outputs:', outDetails.map(d => d.name + ' ' + JSON.stringify(d.shape)));
    setStatus('liteRT.js listo');
    litertReady = true;
  } catch (e) {
    console.warn('liteRT.js no disponible:', e);
    setStatus('Modo sin IA');
  }
}

function iou(b1, b2) {
  const x1 = Math.max(b1.x, b2.x), y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + b1.w, b2.x + b2.w), y2 = Math.min(b1.y + b1.h, b2.y + b2.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area1 = b1.w * b1.h, area2 = b2.w * b2.h;
  return inter / (area1 + area2 - inter);
}

function nms(boxes, scores, iouThresh) {
  const idx = boxes.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];
  while (idx.length > 0) {
    const i = idx.shift();
    keep.push(i);
    for (let j = idx.length - 1; j >= 0; j--) {
      if (iou(boxes[i], boxes[idx[j]]) > iouThresh) idx.splice(j, 1);
    }
  }
  return keep;
}

function findOutputTensor(outputs, details, hints, fallbackIdx) {
  for (const hint of hints) {
    for (let i = 0; i < details.length; i++) {
      const name = details[i].name.toLowerCase();
      if (name.includes(hint)) return { tensor: outputs[i], detail: details[i], idx: i };
    }
  }
  if (fallbackIdx !== undefined && fallbackIdx < details.length) {
    return { tensor: outputs[fallbackIdx], detail: details[fallbackIdx], idx: fallbackIdx };
  }
  for (let i = 0; i < details.length; i++) {
    const d = details[i];
    const flat = d.shape.reduce((a, b) => a * b, 1);
    if (flat > 0 && flat < 10) continue;
    return { tensor: outputs[i], detail: d, idx: i };
  }
  return null;
}

function classifyTensor(detail, flatSize) {
  const name = detail.name.toLowerCase();
  const shape = detail.shape;
  if (name.includes('box') || (shape.length >= 2 && shape[shape.length - 1] === 4)) return 'boxes';
  if (name.includes('num_det') || name.includes('numdet') || flatSize <= 4) return 'num';
  if (name.includes('score') || name.includes('conf')) return 'scores';
  return 'classes';
}

async function detectVehicles(frame) {
  if (!liteModel || !litertReady) return [];

  const canvas = document.createElement('canvas');
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  canvas.getContext('2d').drawImage(frame, 0, 0, INPUT_SIZE, INPUT_SIZE);

  const imgData = canvas.getContext('2d').getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const pixels = imgData.data;
  const input = new Float32Array(1 * INPUT_SIZE * INPUT_SIZE * 3);
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    input[i * 3] = pixels[i * 4] / 255.0;
    input[i * 3 + 1] = pixels[i * 4 + 1] / 255.0;
    input[i * 3 + 2] = pixels[i * 4 + 2] / 255.0;
  }

  const inputTensor = new Tensor(input, [1, INPUT_SIZE, INPUT_SIZE, 3]);
  const outputs = await liteModel.run(inputTensor);
  inputTensor.delete();

  const details = liteModel.getOutputDetails();
  const tensors = {};
  const flatSizes = [];

  for (let i = 0; i < details.length; i++) {
    const flat = details[i].shape.reduce((a, b) => a * b, 1);
    flatSizes.push(flat);
    const type = classifyTensor(details[i], flat);
    if (!tensors[type]) tensors[type] = { tensor: outputs[i], detail: details[i], flat };
  }

  // Ensure boxes is always found
  if (!tensors.boxes) {
    const fallback = findOutputTensor(outputs, details, ['box', 'detection'], 0);
    if (fallback) tensors.boxes = { tensor: fallback.tensor, detail: fallback.detail, flat: fallback.detail.shape.reduce((a, b) => a * b, 1) };
  }

  if (!tensors.boxes) {
    console.warn('liteRT: no se encontraron bounding boxes');
    outputs.forEach(o => o.delete());
    return [];
  }

  const boxData = await tensors.boxes.tensor.toTypedArray();
  const scoreData = tensors.scores ? await tensors.scores.tensor.toTypedArray() : [];
  const classData = tensors.classes ? await tensors.classes.tensor.toTypedArray() : [];

  outputs.forEach(o => o.delete());

  const boxShape = tensors.boxes.detail.shape;
  const numBoxes = boxShape.length === 3 ? boxShape[1] : Math.floor(boxData.length / 4);

  const fw = frame.width, fh = frame.height;
  const vehBoxes = [];

  for (let i = 0; i < numBoxes; i++) {
    const score = scoreData[i] || 0;
    if (score < 0.35) continue;

    const cls = Math.round(classData[i] || 0);
    if (!VEHICLE_CLASSES.includes(COCO_LABELS[cls])) continue;

    const ymin = boxData[i * 4], xmin = boxData[i * 4 + 1];
    const ymax = boxData[i * 4 + 2], xmax = boxData[i * 4 + 3];

    vehBoxes.push({
      x: xmin * fw, y: ymin * fh,
      w: (xmax - xmin) * fw, h: (ymax - ymin) * fh,
      score,
    });
  }

  const keep = nms(vehBoxes, vehBoxes.map(v => v.score), 0.5);
  return keep.map(i => vehBoxes[i]);
}

// =============================== PLATE PATTERNS (Chile) ===============================
const PLATE_PATTERNS = [/^[A-Z]{4}\d{2}$/, /^[A-Z]{2}\d{4}$/];
const OCR_CORRECTIONS = {
  '0': 'O', 'O': '0', '1': 'I', 'I': '1', '2': 'Z', 'Z': '2',
  '5': 'S', 'S': '5', '8': 'B', 'B': '8', '6': 'G', 'G': '6', '4': 'A', 'A': '4',
};
function validatePlate(t) { return PLATE_PATTERNS.some(p => p.test(t)); }
function correctPlate(raw) {
  if (validatePlate(raw)) return raw;
  for (let i = 0; i < raw.length; i++) {
    if (!OCR_CORRECTIONS[raw[i]]) continue;
    for (const c of OCR_CORRECTIONS[raw[i]]) {
      const t = raw.slice(0, i) + c + raw.slice(i + 1);
      if (validatePlate(t)) return t;
    }
  }
  return null;
}

// =============================== CAMERA ===============================
let mediaStream = null, isScanning = false, scanTimer = null;
let ocrWorker = null;

async function getOCRWorker() {
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      logger: m => { if (m.status === 'recognizing text') setStatus('OCR ' + Math.round(m.progress * 100) + '%'); },
    });
    await ocrWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
  }
  return ocrWorker;
}

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
  const toggle = document.getElementById('scan-toggle');
  const label = document.getElementById('switch-label');
  if (isScanning) {
    isScanning = false;
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    toggle.checked = false; label.textContent = 'Iniciar deteccion';
    document.getElementById('cam-status').classList.remove('scanning');
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    setStatus('Detenido'); return;
  }
  if (!mediaStream) { const ok = await startCamera(); if (!ok) { toggle.checked = false; return; } }
  if (!litertReady && !window._liteLoading) {
    window._liteLoading = true;
    initLiteRT();
  }
  isScanning = true;
  label.textContent = 'Apagar camara';
  document.getElementById('cam-status').classList.add('scanning');
  setStatus('Escaneando...');
  await captureAndDetect();
  scanTimer = setInterval(captureAndDetect, 2500);
};

// =============================== ADAPTIVE THRESHOLD ===============================
function adaptiveThreshold(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height, d = img.data;
  const sat = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      d[i] = d[i + 1] = d[i + 2] = g;
      sat[(y + 1) * (w + 1) + (x + 1)] = g + sat[y * (w + 1) + (x + 1)] + sat[(y + 1) * (w + 1) + x] - sat[y * (w + 1) + x];
    }
  }
  const half = Math.max(3, Math.round(Math.min(w, h) / 14) * 2 + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), y1 = Math.max(0, y - half);
      const x2 = Math.min(w, x + half), y2 = Math.min(h, y + half);
      const sum = sat[y2 * (w + 1) + x2] - sat[y1 * (w + 1) + x2] - sat[y2 * (w + 1) + x1] + sat[y1 * (w + 1) + x1];
      const local = sum / ((x2 - x1) * (y2 - y1)) - 6;
      const pi = (y * w + x) * 4;
      const v = d[pi] > local ? 255 : 0;
      d[pi] = d[pi + 1] = d[pi + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// =============================== OCR ===============================
async function runOCR(canvas) {
  if (canvas.width < 20 || canvas.height < 20) return null;
  const w = await getOCRWorker();
  let { data } = await w.recognize(canvas);
  let text = data.text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (text.length >= 5 && text.length <= 8) { const r = correctPlate(text) || (validatePlate(text) ? text : null); if (r) return r; }

  const s = 3;
  const p = document.createElement('canvas');
  p.width = Math.max(60, Math.round(canvas.width * s));
  p.height = Math.max(60, Math.round(canvas.height * s));
  p.getContext('2d').drawImage(canvas, 0, 0, p.width, p.height);
  adaptiveThreshold(p);

  ({ data } = await w.recognize(p));
  text = data.text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (text.length >= 5 && text.length <= 8) { const r = correctPlate(text) || (validatePlate(text) ? text : null); if (r) return r; }
  const m = text.match(/[A-Z0-9]{5,8}/);
  if (m) return correctPlate(m[0]) || (validatePlate(m[0]) ? m[0] : null);
  return null;
}

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
  c.width = Math.max(30, Math.round(w)); c.height = Math.max(30, Math.round(h));
  c.getContext('2d').drawImage(src, Math.round(x), Math.round(y), Math.round(w), Math.round(h), 0, 0, c.width, c.height);
  return c;
}

async function captureAndDetect() {
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) return;
  const frame = captureFrame();
  if (!frame) return;

  let plate = null;
  const fw = frame.width, fh = frame.height;

  // Approach 1: Direct OCR on center regions
  const regions = [
    { x: fw * 0.1, y: fh * 0.3, w: fw * 0.8, h: fh * 0.4 },
    { x: fw * 0.1, y: fh * 0.45, w: fw * 0.8, h: fh * 0.35 },
    { x: 0, y: fh * 0.35, w: fw, h: fh * 0.3 },
  ];
  for (const r of regions) {
    if (plate) break;
    setStatus('Buscando...');
    try { plate = await runOCR(crop(frame, r.x, r.y, r.w, r.h)); } catch (e) {}
  }

  // Approach 2: Vehicle detection via LiteRT.js
  if (!plate) {
    try {
      setStatus('liteRT.js detectando...');
      const vehicles = await detectVehicles(video);
      for (const v of vehicles) {
        if (plate) break;
        setStatus('Vehiculo -> OCR');
        plate = await runOCR(crop(frame, v.x + v.w * 0.12, v.y + v.h * 0.5, v.w * 0.76, v.h * 0.35));
      }
    } catch (e) { console.warn('liteRT error:', e); }
  }

  if (plate) processPlate(plate);
  else setStatus('Sin deteccion');
}

function processPlate(plate) {
  setStatus('Patente: ' + plate);
  const result = document.getElementById('cam-result');
  result.classList.remove('hidden', 'success', 'danger', 'warning');
  document.getElementById('result-plate').textContent = plate;
  let status, css, ico;
  if (DB.stolen.includes(plate)) { status = '\u26A0 VEHICULO DENUNCIADO'; css = 'danger'; ico = '\u26A0'; scanCount.stolen++; }
  else if (DB.registered.includes(plate)) { status = '\u2713 Vehiculo registrado'; css = 'success'; ico = '\u2713'; scanCount.registered++; }
  else { status = '\u26A0 No registrado'; css = 'warning'; ico = '\u26A0'; scanCount.unknown++; }
  scanCount.total++; saveStats(); updateStats();
  result.className = 'camera-result ' + css;
  document.getElementById('result-icon').textContent = ico;
  document.getElementById('result-status').textContent = status;
  scanHistory.unshift({ plate, status: css, time: Date.now() });
  if (scanHistory.length > 20) scanHistory.pop();
  saveHistory(); updateHistory();
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

// =============================== NAVIGATION ===============================
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

// =============================== WHATSAPP ===============================
window.sendWhatsApp = function () {
  const plate = document.getElementById('reg-plate').value.trim();
  const vehicle = document.getElementById('reg-vehicle').value;
  const incident = document.getElementById('reg-incident').value;
  const location = document.getElementById('reg-location').value.trim();
  const desc = document.getElementById('reg-desc').value.trim();
  if (!plate) { showToast('Ingrese una patente', 'error'); return; }
  if (!vehicle) { showToast('Seleccione tipo de vehiculo', 'error'); return; }
  if (!incident) { showToast('Seleccione tipo de incidente', 'error'); return; }
  const msg = ['\u{1F6A8} *REPORTE DE INCIDENTE*', '', '\u{1F539} *Patente:* ' + plate.toUpperCase(), '\u{1F539} *Vehiculo:* ' + vehicle, '\u{1F539} *Incidente:* ' + incident, location ? '\u{1F539} *Ubicacion:* ' + location : '', desc ? '\u{1F539} *Descripcion:* ' + desc : '', '', '\u{1F4F1} Enviado desde PlateDetect'].filter(Boolean).join('\n');
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
  showToast('Abriendo WhatsApp...', 'success');
};

// =============================== CONTACTS ===============================
function renderContacts() {
  const grid = document.getElementById('contact-grid');
  grid.innerHTML = contacts.map(c => '<div class="contact-card"><div class="avatar ' + (c.type || 'custom') + '">' + (c.icon || '\u{1F4DE}') + '</div><div class="info"><div class="name">' + c.name + '</div><div class="phone">' + c.phone + '</div></div><button class="call-btn" onclick="callContact(\'' + c.phone + '\')"><svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></button></div>').join('');
}
window.callContact = function (p) { window.location.href = 'tel:' + p; };
window.addContact = function () {
  const name = document.getElementById('new-contact-name').value.trim();
  const phone = document.getElementById('new-contact-phone').value.trim();
  if (!name || !phone) { showToast('Ingrese nombre y telefono', 'error'); return; }
  contacts.push({ name, phone, type: 'custom', icon: '\u{1F4DE}' });
  saveContacts(); renderContacts();
  document.getElementById('new-contact-name').value = '';
  document.getElementById('new-contact-phone').value = '';
  showToast('Contacto agregado', 'success');
};

// =============================== TOAST ===============================
function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.innerHTML = msg;
  el.className = 'toast';
  if (type) el.classList.add('toast-' + type);
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3000);
}

// =============================== INIT ===============================
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-home-scan').addEventListener('click', () => window.navigate('camera'));
  document.getElementById('scan-toggle').addEventListener('change', window.toggleScan);
  document.getElementById('btn-send-whatsapp').addEventListener('click', window.sendWhatsApp);
  document.getElementById('btn-add-contact').addEventListener('click', window.addContact);

  document.querySelectorAll('.nav-item[data-view]').forEach(n => {
    n.addEventListener('click', () => {
      window.navigate(n.dataset.view);
      if (n.dataset.view === 'camera' && !window._liteInit) { window._liteInit = true; initLiteRT(); }
    });
  });

  document.getElementById('cam-result').addEventListener('click', function () {
    if (document.getElementById('result-plate').textContent !== '---') {
      document.getElementById('reg-plate').value = document.getElementById('result-plate').textContent;
      window.navigate('register');
    }
  });

  updateStats(); updateHistory(); renderContacts();
  initLiteRT();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Nueva version disponible. Recarga la pagina.', 'success');
          }
        });
      });
    }).catch(() => {});

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  }
});
