// =============================== DATABASE ===============================
const DB = {
  registered: ['ABC123', 'DEF456', 'GHI789', 'JKL012', 'MNO345', 'PQR678', 'STU901'],
  stolen: ['XYZ789', 'LMN456', 'WVU321'],
};

let scanHistory = JSON.parse(localStorage.getItem('plateHistory') || '[]');
let scanCount = JSON.parse(localStorage.getItem('plateStats') || '{"total":0,"registered":0,"stolen":0,"unknown":0}');
let contacts = JSON.parse(localStorage.getItem('contacts') || '[]');

const defaultContacts = [
  { name: 'Polic&iacute;a', phone: '911', type: 'police', icon: '&#128110;' },
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
      tessedit_pageseg_mode: '7',
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
  if (label) label.textContent = 'Iniciar detecci\u00F3n';
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
    label.textContent = 'Iniciar detecci\u00F3n';
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
  label.textContent = 'Apagar c\u00E1mara';
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

async function readPlate(canvas) {
  const w = await getOCRWorker();
  const { data } = await w.recognize(canvas);
  const text = data.text.trim().toUpperCase();
  const cleaned = text.replace(/[^A-Z0-9]/g, '');
  if (cleaned.length >= 5 && cleaned.length <= 8) return cleaned;
  const match = text.match(/[A-Z0-9]{5,8}/);
  return match ? match[0] : null;
}

async function captureAndDetect() {
  const video = document.getElementById('video');
  if (!video || !video.videoWidth || !cocoModel) return;

  const frame = captureFrame();
  if (!frame) return;

  let plate = null;
  document.getElementById('cam-status').textContent = 'Buscando...';

  // Approach 1: detect vehicle -> crop plate region -> OCR
  try {
    const predictions = await cocoModel.detect(video);
    const VEHICLE_CLASSES = ['car', 'truck', 'bus', 'motorcycle'];
    const vehicles = predictions
      .filter(p => VEHICLE_CLASSES.includes(p.class) && p.score > 0.4)
      .sort((a, b) => b.score - a.score);

    if (vehicles.length > 0) {
      const best = vehicles[0];
      document.getElementById('cam-status').textContent = best.class + ' -> leyendo patente';
      const [bx, by, bw, bh] = best.bbox;
      const pc = cropCanvas(frame, bx + bw * 0.12, by + bh * 0.5, bw * 0.76, bh * 0.35);
      plate = await readPlate(pc);
      if (plate) document.getElementById('cam-status').textContent = 'Patente: ' + plate;
    }
  } catch (e) {
    console.warn('Vehicle detection error:', e);
  }

  // Approach 2: direct OCR on center scan region (for close-up plates)
  if (!plate) {
    try {
      document.getElementById('cam-status').textContent = 'Buscando patente directo...';
      const cw = frame.width * 0.75;
      const ch = frame.height * 0.35;
      const cx = (frame.width - cw) / 2;
      const cy = (frame.height - ch) / 2;
      const centerCrop = cropCanvas(frame, cx, cy, cw, ch);
      plate = await readPlate(centerCrop);
    } catch (e) {
      console.warn('Direct OCR error:', e);
    }
  }

  if (plate) {
    processPlate(plate);
  } else {
    document.getElementById('cam-status').textContent = 'Sin detecci\u00F3n';
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
    status = '&#9888; VEH&Iacute;CULO DENUNCIADO - Tomar precauciones';
    cssClass = 'danger';
    ico = '&#9888;';
    scanCount.stolen++;
  } else if (DB.registered.includes(plate)) {
    status = '&#10003; Veh&iacute;culo registrado - Sin novedades';
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
  if (!vehicle) { showToast('Seleccione tipo de veh&iacute;culo', 'error'); return; }
  if (!incident) { showToast('Seleccione tipo de incidente', 'error'); return; }

  const msg = [
    '\u{1F6A8} *REPORTE DE INCIDENTE*',
    '',
    '\u{1F539} *Patente:* ' + plate.toUpperCase(),
    '\u{1F539} *Veh&iacute;culo:* ' + vehicle,
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
