// =============================== DATABASE ===============================
const DB = {
  registered: ['ABC123', 'DEF456', 'GHI789', 'JKL012', 'MNO345', 'PQR678', 'STU901', 'BBBB10'],
  stolen: ['XYZ789', 'LMN456', 'WVU321'],
};

let scanHistory = JSON.parse(localStorage.getItem('plateHistory') || '[]');
let scanCount = JSON.parse(localStorage.getItem('plateStats') || '{"total":0,"registered":0,"stolen":0,"unknown":0}');
let contacts = JSON.parse(localStorage.getItem('contacts') || '[]');

const defaultContacts = [
  { name: 'Policia', phone: '911', type: 'police', icon: '&#128110;' },
  { name: 'Emergencias', phone: '107', type: 'emergency', icon: '&#128657;' },
  { name: 'Bomberos', phone: '100', type: 'fire', icon: '&#128293;' },
  { name: 'Hospital', phone: '108', type: 'hospital', icon: '&#127973;' },
];

if (!contacts.length) contacts = JSON.parse(JSON.stringify(defaultContacts));

function saveStats() { localStorage.setItem('plateStats', JSON.stringify(scanCount)); }
function saveHistory() { localStorage.setItem('plateHistory', JSON.stringify(scanHistory)); }
function saveContacts() { localStorage.setItem('contacts', JSON.stringify(contacts)); }

// =============================== NAVIGATION ===============================
function navigate(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const vEl = document.getElementById('view-' + view);
  if (vEl) vEl.classList.add('active');
  const nEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (nEl) nEl.classList.add('active');
  if (view !== 'camera') stopCamera();
  if (view === 'camera') { updateHistory(); loadDetector(); }
  if (view === 'home') updateStats();
  if (view === 'call') renderContacts();
}

// =============================== LITERT (MediaPipe Tasks Vision) ===============================
let detector = null;
let detectorLoading = false;

async function loadDetector() {
  if (detector || detectorLoading) return;
  detectorLoading = true;
  setStatus('Cargando liteRT...');
  try {
    const { FilesetResolver, ObjectDetector } = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.js'
    );
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm/'
    );
    detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite',
      },
      scoreThreshold: 0.4,
      maxResults: 5,
    });
    setStatus('liteRT listo');
  } catch (e) {
    console.warn('liteRT no disponible:', e);
    setStatus('Modo sin IA');
  }
  detectorLoading = false;
}

// =============================== PLATE PATTERNS (Chile) ===============================
const PLATE_PATTERNS = [/^[A-Z]{4}\d{2}$/, /^[A-Z]{2}\d{4}$/];
const OCR_CORRECTIONS = {
  '0': 'O', 'O': '0', '1': 'I', 'I': '1', '2': 'Z', 'Z': '2',
  '5': 'S', 'S': '5', '8': 'B', 'B': '8', '6': 'G', 'G': '6', '4': 'A', 'A': '4',
};

function validatePlate(text) { return PLATE_PATTERNS.some(p => p.test(text)); }

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
let mediaStream = null;
let isScanning = false;
let scanTimer = null;

async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const video = document.getElementById('video');
    video.srcObject = mediaStream;
    await video.play();
    setStatus('Listo');
    return true;
  } catch (e) {
    showToast('Error al acceder a la camara: ' + e.message, 'error');
    return false;
  }
}

function setStatus(msg) { const el = document.getElementById('cam-status'); if (el) el.textContent = msg; }

function setBadgeScanning(on) {
  const badge = document.getElementById('cam-status');
  if (on) badge.classList.add('scanning');
  else badge.classList.remove('scanning');
}

function stopCamera() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  isScanning = false;
  const toggle = document.getElementById('scan-toggle');
  if (toggle) toggle.checked = false;
  const label = document.getElementById('switch-label');
  if (label) label.textContent = 'Iniciar deteccion';
  setBadgeScanning(false);
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  setStatus('En espera');
}

async function toggleScan() {
  const toggle = document.getElementById('scan-toggle');
  const label = document.getElementById('switch-label');
  if (isScanning) {
    isScanning = false;
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    toggle.checked = false;
    label.textContent = 'Iniciar deteccion';
    setBadgeScanning(false);
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    setStatus('Detenido');
    return;
  }
  if (!mediaStream) { const ok = await startCamera(); if (!ok) { toggle.checked = false; return; } }
  isScanning = true;
  label.textContent = 'Apagar camara';
  setBadgeScanning(true);
  setStatus('Escaneando...');
  await captureAndDetect();
  scanTimer = setInterval(() => captureAndDetect(), 2500);
}

// =============================== ADAPTIVE THRESHOLD (integral images, O(n)) ===============================
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
      const i = (y * w + x) * 4;
      const v = d[i] > local ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// =============================== TESSERACT OCR ===============================
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

async function runOCR(canvas) {
  if (canvas.width < 20 || canvas.height < 20) return null;
  const w = await getOCRWorker();

  // Try raw crop
  let { data } = await w.recognize(canvas);
  let text = data.text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (text.length >= 5 && text.length <= 8) { const r = correctPlate(text) || (validatePlate(text) ? text : null); if (r) return r; }

  // Try scaled + adaptive threshold (best for plates)
  const s = 3;
  const p = document.createElement('canvas');
  p.width = Math.max(60, Math.round(canvas.width * s));
  p.height = Math.max(60, Math.round(canvas.height * s));
  const pctx = p.getContext('2d');
  pctx.drawImage(canvas, 0, 0, p.width, p.height);
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
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

function cropCanvas(src, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(30, Math.round(w));
  c.height = Math.max(30, Math.round(h));
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
    { x: fw * 0.1, y: fh * 0.3,  w: fw * 0.8, h: fh * 0.4 },
    { x: fw * 0.1, y: fh * 0.45, w: fw * 0.8, h: fh * 0.35 },
    { x: 0,        y: fh * 0.35, w: fw,       h: fh * 0.3 },
  ];

  for (const r of regions) {
    if (plate) break;
    setStatus('Buscando...');
    try {
      plate = await runOCR(cropCanvas(frame, r.x, r.y, r.w, r.h));
    } catch (e) { /* skip */ }
  }

  // Approach 2: Vehicle detection via liteRT
  if (!plate && detector) {
    try {
      setStatus('Buscando vehiculo...');
      const results = detector.detect(video);
      if (results && results.detections) {
        const vehicles = results.detections
          .filter(d => d.categories[0] && ['car', 'truck', 'bus', 'motorcycle'].includes(d.categories[0].categoryName) && d.categories[0].score > 0.35);
        for (const v of vehicles) {
          if (plate) break;
          const bb = v.boundingBox;
          plate = await runOCR(cropCanvas(frame, bb.originX + bb.width * 0.12, bb.originY + bb.height * 0.5, bb.width * 0.76, bb.height * 0.35));
        }
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

  let status, cssClass, ico;
  if (DB.stolen.includes(plate)) { status = '&#9888; VEHICULO DENUNCIADO'; cssClass = 'danger'; ico = '&#9888;'; scanCount.stolen++; }
  else if (DB.registered.includes(plate)) { status = '&#10003; Vehiculo registrado'; cssClass = 'success'; ico = '&#10003;'; scanCount.registered++; }
  else { status = '&#9888; No registrado'; cssClass = 'warning'; ico = '&#9888;'; scanCount.unknown++; }

  scanCount.total++;
  saveStats();
  updateStats();
  result.className = 'camera-result ' + cssClass;
  document.getElementById('result-icon').innerHTML = ico;
  document.getElementById('result-status').innerHTML = status;
  scanHistory.unshift({ plate, status: cssClass, time: Date.now() });
  if (scanHistory.length > 20) scanHistory.pop();
  saveHistory();
  updateHistory();
  if (navigator.vibrate) navigator.vibrate(100);
  document.getElementById('reg-plate').value = plate;
}

function clearCameraResult() { document.getElementById('cam-result').classList.add('hidden'); }

function updateHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (!scanHistory.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Sin detecciones recientes</div>'; return; }
  list.innerHTML = scanHistory.slice(0, 10).map(h => {
    const sClass = h.status === 'success' ? 'reg' : h.status === 'danger' ? 'stolen' : 'unk';
    const sText = h.status === 'success' ? 'Registrada' : h.status === 'danger' ? 'Denunciada' : 'Desconocida';
    return '<div class="history-item"><span class="h-plate">' + h.plate + '</span><span class="h-status ' + sClass + '">' + sText + '</span></div>';
  }).join('');
}

// =============================== STATS ===============================
function updateStats() {
  document.getElementById('stat-total').textContent = scanCount.total;
  document.getElementById('stat-reg').textContent = scanCount.registered;
  document.getElementById('stat-stolen').textContent = scanCount.stolen;
  document.getElementById('stat-unknown').textContent = scanCount.unknown;
}

// =============================== WHATSAPP ===============================
function sendWhatsApp() {
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
}

// =============================== CONTACTS ===============================
function renderContacts() {
  const grid = document.getElementById('contact-grid');
  grid.innerHTML = contacts.map(c => '<div class="contact-card"><div class="avatar ' + (c.type || 'custom') + '">' + (c.icon || '\u{1F4DE}') + '</div><div class="info"><div class="name">' + c.name + '</div><div class="phone">' + c.phone + '</div></div><button class="call-btn" onclick="callContact(\'' + c.phone + '\')" title="Llamar"><svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></button></div>').join('');
}

function callContact(phone) { window.location.href = 'tel:' + phone; }

function addContact() {
  const name = document.getElementById('new-contact-name').value.trim();
  const phone = document.getElementById('new-contact-phone').value.trim();
  if (!name || !phone) { showToast('Ingrese nombre y telefono', 'error'); return; }
  contacts.push({ name, phone, type: 'custom', icon: '\u{1F4DE}' });
  saveContacts();
  renderContacts();
  document.getElementById('new-contact-name').value = '';
  document.getElementById('new-contact-phone').value = '';
  showToast('Contacto agregado', 'success');
}

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
  updateStats();
  updateHistory();
  renderContacts();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});
