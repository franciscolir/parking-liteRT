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
  if (view === 'camera') updateHistory();
  if (view === 'home') updateStats();
  if (view === 'call') renderContacts();
}

// =============================== IA MODEL ===============================
let cocoModel = null;
let modelLoading = false;

async function loadModel() {
  if (cocoModel) return true;
  if (modelLoading) return false;
  modelLoading = true;
  try {
    document.getElementById('cam-status').textContent = 'Cargando modelo IA...';
    cocoModel = await cocoSsd.load();
    modelLoading = false;
    document.getElementById('cam-status').textContent = 'Modelo listo';
    return true;
  } catch (e) {
    modelLoading = false;
    showToast('Error al cargar modelo IA: ' + e.message, 'error');
    document.getElementById('cam-status').textContent = 'Error modelo';
    return false;
  }
}

// =============================== CAMERA ===============================
let mediaStream = null;
let isScanning = false;
let scanTimer = null;
let ocrWorker = null;

const PLATE_PATTERNS = [
  /^[A-Z]{4}\d{2}$/,          // ABCD 12
  /^[A-Z]{2}\d{4}$/,          // AB 1234
  ///^[A-Z]{3}\d{3}$/,          // ABC 123
 // /^[A-Z]{2}\d{3}[A-Z]{2}$/,  // AB 123 CD (Mercosur)
  // /^\d{3}[A-Z]{3}$/,          // 123 ABC
  // /^[A-Z]\d{3}[A-Z]{3}$/,     // A 123 BCD
  ///^\d{3}[A-Z]{2}\d{2}$/,     // 123 AB 45
];

const OCR_CORRECTIONS = {
  '0': 'O', 'O': '0',
  '1': 'I', 'I': '1',
  '2': 'Z', 'Z': '2',
  '5': 'S', 'S': '5',
  '8': 'B', 'B': '8',
  '6': 'G', 'G': '6',
  '4': 'A', 'A': '4',
};

function validatePlate(text) {
  return PLATE_PATTERNS.some(p => p.test(text));
}

function correctPlate(raw) {
  if (validatePlate(raw)) return raw;

  for (let i = 0; i < raw.length; i++) {
    const swaps = OCR_CORRECTIONS[raw[i]];
    if (!swaps) continue;
    for (const ch of swaps) {
      const test = raw.slice(0, i) + ch + raw.slice(i + 1);
      if (validatePlate(test)) return test;
    }
  }

  for (let i = 0; i < raw.length; i++) {
    const swaps = OCR_CORRECTIONS[raw[i]];
    if (!swaps) continue;
    for (const ch of swaps) {
      const test = raw.slice(0, i) + ch + raw.slice(i + 1);
      for (let j = 0; j < test.length; j++) {
        if (j === i) continue;
        const swaps2 = OCR_CORRECTIONS[test[j]];
        if (!swaps2) continue;
        for (const ch2 of swaps2) {
          const test2 = test.slice(0, j) + ch2 + test.slice(j + 1);
          if (validatePlate(test2)) return test2;
        }
      }
    }
  }
  return null;
}

function adaptiveThreshold(canvas, blockSize) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width;
  const h = canvas.height;
  const half = Math.floor(blockSize / 2);

  // Grayscale
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    d[i] = d[i + 1] = d[i + 2] = g;
  }

  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      gray[y * w + x] = d[(y * w + x) * 4];
    }
  }

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let ky = -half; ky <= half; ky++) {
        for (let kx = -half; kx <= half; kx++) {
          const px = x + kx;
          const py = y + ky;
          if (px >= 0 && px < w && py >= 0 && py < h) {
            sum += gray[py * w + px];
            count++;
          }
        }
      }
      const localThresh = sum / count - 10;
      out[y * w + x] = gray[y * w + x] > localThresh ? 255 : 0;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = out[y * w + x];
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
  ctx.scale(s, s);
  ctx.drawImage(canvas, 0, 0);
  ctx.scale(1 / s, 1 / s);
  ctx.filter = 'contrast(200%) brightness(110%)';
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';
  adaptiveThreshold(out, Math.max(3, Math.round(Math.min(out.width, out.height) / 10) * 2 + 1));
  return out;
}

async function getOCRWorker() {
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          document.getElementById('cam-status').textContent =
            'OCR ' + Math.round(m.progress * 100) + '%';
        }
      },
    });
    await ocrWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    });
  }
  return ocrWorker;
}

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
    showToast('Error al acceder a la c&aacute;mara: ' + e.message, 'error');
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
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    document.getElementById('cam-status').textContent = 'Detenido';
    return;
  }

  if (!mediaStream) {
    const ok = await startCamera();
    if (!ok) { toggle.checked = false; return; }
  }

  const modelOk = await loadModel();
  if (!modelOk) { toggle.checked = false; showToast('Error al cargar IA', 'error'); return; }

  isScanning = true;
  label.textContent = 'Apagar camara';
  setBadgeScanning(true);
  document.getElementById('cam-status').textContent = 'Escaneando...';

  await captureAndDetect();
  scanTimer = setInterval(captureAndDetect, 2500);
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

async function tryOCR(canvas, psm) {
  const w = await getOCRWorker();
  await w.setParameters({ tessedit_pageseg_mode: psm.toString() });
  const { data } = await w.recognize(canvas);
  const text = data.text.trim().toUpperCase();
  const cleaned = text.replace(/[^A-Z0-9]/g, '');
  if (cleaned.length >= 5 && cleaned.length <= 8) {
    const corrected = correctPlate(cleaned);
    if (corrected) return corrected;
    if (validatePlate(cleaned)) return cleaned;
  }
  const m = text.match(/[A-Z0-9]{5,8}/);
  if (m) {
    const corrected = correctPlate(m[0]);
    if (corrected) return corrected;
    if (validatePlate(m[0])) return m[0];
  }
  return null;
}

async function readPlate(canvas) {
  const raw = await tryOCR(canvas, 7);
  if (raw) return raw;
  const raw2 = await tryOCR(canvas, 8);
  if (raw2) return raw2;

  const proc = preprocessForOCR(canvas);
  const p1 = await tryOCR(proc, 7);
  if (p1) return p1;
  const p2 = await tryOCR(proc, 8);
  if (p2) return p2;

  return null;
}

async function captureAndDetect() {
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) return;

  const frame = captureFrame();
  if (!frame) return;

  let plate = null;
  document.getElementById('cam-status').textContent = 'Analizando...';

  const cw = frame.width * 0.7;
  const ch = frame.height * 0.3;
  const cx = (frame.width - cw) / 2;
  const cy = (frame.height - ch) / 2;

  const regions = [
    { x: cx, y: cy, w: cw, h: ch },
    { x: cx + cw * 0.15, y: cy + ch * 0.1, w: cw * 0.7, h: ch * 0.8 },
    { x: cx + cw * 0.05, y: cy + ch * 0.2, w: cw * 0.9, h: ch * 0.6 },
    { x: cx + cw * 0.05, y: cy + ch * 0.35, w: cw * 0.9, h: ch * 0.4 },
    { x: 0, y: frame.height * 0.5, w: frame.width, h: frame.height * 0.25 },
    { x: frame.width * 0.1, y: frame.height * 0.55, w: frame.width * 0.8, h: frame.height * 0.15 },
  ];

  for (const r of regions) {
    if (plate) break;
    document.getElementById('cam-status').textContent = 'Buscando...';
    try {
      const crop = cropCanvas(frame, r.x, r.y, r.w, r.h);
      plate = await readPlate(crop);
    } catch (e) { /* skip */ }
  }

  if (!plate && cocoModel) {
    try {
      document.getElementById('cam-status').textContent = 'Buscando...';
      const predictions = await cocoModel.detect(video);
      const vehicles = predictions
        .filter(p => ['car', 'truck', 'bus', 'motorcycle'].includes(p.class) && p.score > 0.35)
        .sort((a, b) => b.score - a.score);

      if (vehicles.length > 0) {
        const b = vehicles[0];
        const [bx, by, bw, bh] = b.bbox;
        const pc = cropCanvas(frame, bx + bw * 0.12, by + bh * 0.5, bw * 0.76, bh * 0.35);
        plate = await readPlate(pc);
      }
    } catch (e) {
      console.warn('Vehicle detection error:', e);
    }
  }

  if (plate) {
    processPlate(plate);
  } else {
    document.getElementById('cam-status').textContent = 'Sin deteccion';
  }
}

function processPlate(plate) {
  document.getElementById('cam-status').textContent = 'Patente: ' + plate;

  const result = document.getElementById('cam-result');
  const icon = document.getElementById('result-icon');
  const plateEl = document.getElementById('result-plate');
  const statusEl = document.getElementById('result-status');

  result.classList.remove('hidden', 'success', 'danger', 'warning');
  plateEl.textContent = plate;

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
    list.innerHTML =
      '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Sin detecciones recientes</div>';
    return;
  }

  list.innerHTML = scanHistory.slice(0, 10).map(h => {
    const sClass = h.status === 'success' ? 'reg' : h.status === 'danger' ? 'stolen' : 'unk';
    const sText = h.status === 'success' ? 'Registrada' : h.status === 'danger' ? 'Denunciada' : 'Desconocida';
    return `<div class="history-item">
      <span class="h-plate">${h.plate}</span>
      <span class="h-status ${sClass}">${sText}</span>
    </div>`;
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
    location ? '\u{1F539} *Ubicaci&oacute;n:* ' + location : '',
    desc ? '\u{1F539} *Descripci&oacute;n:* ' + desc : '',
    '',
    '\u{1F4F1} Enviado desde PlateDetect',
  ].filter(Boolean).join('\n');

  const url = 'https://wa.me/?text=' + encodeURIComponent(msg);
  window.open(url, '_blank');
  showToast('Abriendo WhatsApp...', 'success');
}

// =============================== CONTACTS ===============================
function renderContacts() {
  const grid = document.getElementById('contact-grid');
  grid.innerHTML = contacts.map(c => `
    <div class="contact-card">
      <div class="avatar ${c.type || 'custom'}">${c.icon || '\u{1F4DE}'}</div>
      <div class="info">
        <div class="name">${c.name}</div>
        <div class="phone">${c.phone}</div>
      </div>
      <button class="call-btn" onclick="callContact('${c.phone}')" title="Llamar">
        <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    </div>
  `).join('');
}

function callContact(phone) {
  window.location.href = 'tel:' + phone;
}

function addContact() {
  const name = document.getElementById('new-contact-name').value.trim();
  const phone = document.getElementById('new-contact-phone').value.trim();
  if (!name || !phone) { showToast('Ingrese nombre y tel&eacute;fono', 'error'); return; }
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
