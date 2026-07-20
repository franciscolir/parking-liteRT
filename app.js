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
  if (view === 'camera') { updateHistory(); loadModel(); }
  if (view === 'home') updateStats();
  if (view === 'call') renderContacts();
}

// =============================== IA MODEL (lazy) ===============================
let cocoModel = null;
let modelLoading = false;

async function loadModel() {
  if (cocoModel || modelLoading) return;
  modelLoading = true;
  try {
    cocoModel = await cocoSsd.load();
  } catch (e) {
    console.warn('COCO-SSD no disponible, solo OCR directo');
  }
  modelLoading = false;
}

// =============================== PLATE PATTERNS ===============================
const PLATE_PATTERNS = [
  /^[A-Z]{3}\d{3}$/,          // ABC 123
  /^[A-Z]{2}\d{3}[A-Z]{2}$/,  // AB 123 CD (Mercosur)
  /^\d{3}[A-Z]{3}$/,          // 123 ABC
  /^[A-Z]{4}\d{2}$/,          // ABCD 12
  /^[A-Z]{2}\d{4}$/,          // AB 1234
  /^[A-Z]\d{3}[A-Z]{3}$/,     // A 123 BCD
  /^\d{3}[A-Z]{2}\d{2}$/,     // 123 AB 45
  /^[A-Z]{3}\d{2}[A-Z]$/,     // ABC 12 D
  /^[A-Z]\d{4}[A-Z]$/,        // A 1234 B
  /^\d{4}[A-Z]{3}$/,          // 1234 ABC
];

const OCR_CORRECTIONS = {
  '0': 'O', 'O': '0', '1': 'I', 'I': '1', '2': 'Z', 'Z': '2',
  '5': 'S', 'S': '5', '8': 'B', 'B': '8', '6': 'G', 'G': '6',
  '4': 'A', 'A': '4',
};

function validatePlate(text) {
  return PLATE_PATTERNS.some(p => p.test(text));
}

function correctPlate(raw) {
  if (validatePlate(raw)) return raw;
  const chars = [...OCR_CORRECTIONS.entries()].flatMap(([k, v]) => v.split('').map(c => [k, c]));

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!OCR_CORRECTIONS[ch]) continue;
    for (const c2 of OCR_CORRECTIONS[ch]) {
      const t = raw.slice(0, i) + c2 + raw.slice(i + 1);
      if (validatePlate(t)) return t;
    }
  }

  for (let i = 0; i < raw.length; i++) {
    if (!OCR_CORRECTIONS[raw[i]]) continue;
    for (const c1 of OCR_CORRECTIONS[raw[i]]) {
      const t1 = raw.slice(0, i) + c1 + raw.slice(i + 1);
      for (let j = 0; j < t1.length; j++) {
        if (j === i) continue;
        if (!OCR_CORRECTIONS[t1[j]]) continue;
        for (const c2 of OCR_CORRECTIONS[t1[j]]) {
          const t2 = t1.slice(0, j) + c2 + t1.slice(j + 1);
          if (validatePlate(t2)) return t2;
        }
      }
    }
  }
  return null;
}

// =============================== IMAGE PROCESSING ===============================
function computeIntegral(img) {
  const w = img.width, h = img.height, d = img.data;
  const sat = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const idx = (y + 1) * (w + 1) + (x + 1);
      sat[idx] = g + sat[idx - 1] + sat[idx - (w + 1)] - sat[idx - (w + 2)];
      d[i] = d[i + 1] = d[i + 2] = g;
    }
  }
  return { sat, w: w + 1, h: h + 1 };
}

function boxAvg(sat, sw, x, y, bw, bh) {
  const x1 = Math.max(0, x), y1 = Math.max(0, y);
  const x2 = Math.min(sw - 1, x + bw), y2 = Math.min(sat.length / sw - 1, y + bh);
  const sum = sat[y2 * sw + x2] - sat[y1 * sw + x2] - sat[y2 * sw + x1] + sat[y1 * sw + x1];
  const count = (x2 - x1) * (y2 - y1);
  return count > 0 ? sum / count : 128;
}

function adaptiveThreshold(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height, d = img.data;
  const { sat, w: sw } = computeIntegral(img);
  const half = Math.max(2, Math.round(Math.min(w, h) / 12));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const local = boxAvg(sat, sw, x - half, y - half, half * 2 + 1, half * 2 + 1);
      const i = (y * w + x) * 4;
      const v = d[i] > local - 8 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function preprocessForOCR(canvas) {
  const s = 2.5;
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * s);
  out.height = Math.round(canvas.height * s);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  adaptiveThreshold(out);
  return out;
}

// =============================== TESSERACT OCR ===============================
let ocrWorker = null;

async function getOCRWorker() {
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          document.getElementById('cam-status').textContent = 'OCR ' + Math.round(m.progress * 100) + '%';
        }
      },
    });
    await ocrWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    });
  }
  return ocrWorker;
}

async function tryOCR(canvas, psm) {
  const w = await getOCRWorker();
  await w.setParameters({ tessedit_pageseg_mode: psm.toString() });
  const { data } = await w.recognize(canvas);
  const text = data.text.trim().toUpperCase();
  const conf = data.confidence || 0;
  const cleaned = text.replace(/[^A-Z0-9]/g, '');

  let best = null;
  if (cleaned.length >= 5 && cleaned.length <= 8) {
    best = correctPlate(cleaned) || (validatePlate(cleaned) ? cleaned : null);
  }
  if (!best) {
    const m = text.match(/[A-Z0-9]{5,8}/);
    if (m) best = correctPlate(m[0]) || (validatePlate(m[0]) ? m[0] : null);
  }
  return { plate: best, raw: cleaned || text.replace(/\s+/g, ''), conf };
}

async function readPlate(canvas, debugEl) {
  // Raw OCR (PSM 7 and 8)
  const r1 = await tryOCR(canvas, 7);
  if (debugEl) debugEl.textContent = 'RAW: "' + r1.raw + '" conf:' + Math.round(r1.conf);
  if (r1.plate && r1.conf > 20) return r1.plate;

  const r2 = await tryOCR(canvas, 8);
  if (debugEl) debugEl.textContent = 'RAW2: "' + r2.raw + '" conf:' + Math.round(r2.conf);
  if (r2.plate && r2.conf > 20) return r2.plate;

  // Preprocessed OCR (PSM 7 and 8)
  const proc = preprocessForOCR(canvas);
  const p1 = await tryOCR(proc, 7);
  if (debugEl) debugEl.textContent = 'PP: "' + p1.raw + '" conf:' + Math.round(p1.conf);
  if (p1.plate && p1.conf > 20) return p1.plate;

  const p2 = await tryOCR(proc, 8);
  if (debugEl) debugEl.textContent = 'PP2: "' + p2.raw + '" conf:' + Math.round(p2.conf);
  if (p2.plate && p2.conf > 20) return p2.plate;

  return null;
}

// =============================== CAMERA ===============================
let mediaStream = null;
let isScanning = false;
let scanTimer = null;

async function startCamera() {
  try {
    const constraints = {
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('video');
    video.srcObject = mediaStream;
    await video.play();
    document.getElementById('cam-status').textContent = 'Listo';
    return true;
  } catch (e) {
    showToast('Error al acceder a la camara: ' + e.message, 'error');
    return false;
  }
}

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
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  document.getElementById('cam-status').textContent = 'En espera';
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
    document.getElementById('cam-status').textContent = 'Detenido';
    return;
  }

  if (!mediaStream) {
    const ok = await startCamera();
    if (!ok) { toggle.checked = false; return; }
  }

  isScanning = true;
  label.textContent = 'Apagar camara';
  setBadgeScanning(true);
  document.getElementById('cam-status').textContent = 'Escaneando...';

  await captureAndDetect();
  scanTimer = setInterval(() => captureAndDetect(), isScanning ? 2000 : 4000);
}

function captureFrame() {
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas;
}

function cropCanvas(source, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext('2d').drawImage(source, Math.round(x), Math.round(y), Math.round(w), Math.round(h), 0, 0, c.width, c.height);
  return c;
}

async function captureAndDetect() {
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) return;

  const frame = captureFrame();
  if (!frame) return;

  let plate = null;
  const debug = document.getElementById('ocr-debug');

  // === Direct OCR on strategic regions ===
  const fw = frame.width, fh = frame.height;
  const regions = [
    // Center band (where users naturally point)
    { x: fw * 0.1, y: fh * 0.3,  w: fw * 0.8, h: fh * 0.4 },
    // Lower-center (common for close plates)
    { x: fw * 0.15, y: fh * 0.45, w: fw * 0.7, h: fh * 0.35 },
    // Full-width strip (catches misaligned shots)
    { x: 0,         y: fh * 0.35, w: fw,       h: fh * 0.3 },
  ];

  for (const r of regions) {
    if (plate) break;
    document.getElementById('cam-status').textContent = 'Buscando...';
    try {
      const crop = cropCanvas(frame, r.x, r.y, r.w, r.h);
      plate = await readPlate(crop, debug);
    } catch (e) { /* skip */ }
  }

  // === Vehicle detection fallback ===
  if (!plate && cocoModel) {
    try {
      document.getElementById('cam-status').textContent = 'Buscando vehiculo...';
      const predictions = await cocoModel.detect(video);
      const vehicles = predictions
        .filter(p => ['car', 'truck', 'bus', 'motorcycle'].includes(p.class) && p.score > 0.35)
        .sort((a, b) => b.score - a.score);

      if (vehicles.length > 0) {
        const b = vehicles[0];
        const [bx, by, bw, bh] = b.bbox;
        const pc = cropCanvas(frame, bx + bw * 0.12, by + bh * 0.5, bw * 0.76, bh * 0.35);
        plate = await readPlate(pc, debug);
      }
    } catch (e) { console.warn('Vehicle detection error:', e); }
  }

  if (plate) {
    processPlate(plate);
    if (scanTimer) { clearInterval(scanTimer); scanTimer = setInterval(() => captureAndDetect(), 3000); }
  } else {
    document.getElementById('cam-status').textContent = 'Sin deteccion';
    if (scanTimer) { clearInterval(scanTimer); scanTimer = setInterval(() => captureAndDetect(), 2000); }
  }
}

function processPlate(plate) {
  document.getElementById('cam-status').textContent = 'Patente: ' + plate;

  const result = document.getElementById('cam-result');
  const icon = document.getElementById('result-icon');
  const plateEl = document.getElementById('result-plate');
  const statusEl = document.getElementById('result-status');
  const debug = document.getElementById('ocr-debug');

  result.classList.remove('hidden', 'success', 'danger', 'warning');
  plateEl.textContent = plate;
  if (debug) debug.textContent = '';

  let status, cssClass, ico;

  if (DB.stolen.includes(plate)) {
    status = '&#9888; VEHICULO DENUNCIADO - Tomar precauciones';
    cssClass = 'danger';
    ico = '&#9888;';
    scanCount.stolen++;
  } else if (DB.registered.includes(plate)) {
    status = '&#10003; Vehiculo registrado - Sin novedades';
    cssClass = 'success';
    ico = '&#10003;';
    scanCount.registered++;
  } else {
    status = '&#9888; No registrado en la base de datos local';
    cssClass = 'warning';
    ico = '&#9888;';
    scanCount.unknown++;
  }

  scanCount.total++;
  saveStats();
  updateStats();

  result.className = 'camera-result ' + cssClass;
  icon.innerHTML = ico;
  statusEl.innerHTML = status;

  scanHistory.unshift({ plate, status: cssClass, time: Date.now() });
  if (scanHistory.length > 20) scanHistory.pop();
  saveHistory();
  updateHistory();

  if (navigator.vibrate) navigator.vibrate(100);
  document.getElementById('reg-plate').value = plate;
}

function clearCameraResult() {
  document.getElementById('cam-result').classList.add('hidden');
}

function updateHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (!scanHistory.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Sin detecciones recientes</div>';
    return;
  }
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

  const msg = [
    '\u{1F6A8} *REPORTE DE INCIDENTE*',
    '',
    '\u{1F539} *Patente:* ' + plate.toUpperCase(),
    '\u{1F539} *Vehiculo:* ' + vehicle,
    '\u{1F539} *Incidente:* ' + incident,
    location ? '\u{1F539} *Ubicacion:* ' + location : '',
    desc ? '\u{1F539} *Descripcion:* ' + desc : '',
    '',
    '\u{1F4F1} Enviado desde PlateDetect',
  ].filter(Boolean).join('\n');

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
});
