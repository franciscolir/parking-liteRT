import { Camera } from './camera.js';
import { PlateDetector } from './detector.js';
import { PlateOCR } from './ocr.js';
import { validatePlate, normalizePlate } from './validator.js';
import { Corrector } from './corrector.js';

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

let camera, detector, ocr, corrector;
let running = false;
let rafId = null;
let lastPlate = null;
let lastPlateBox = null;
let noDetectFrames = 0;
let frameCount = 0;
let lastFpsTime = performance.now();
let streakCandidate = null;
let streakCount = 0;
let streakRequired = 2;
let noDetectLimit = 20;

let lastRawText = '';
let lastCorrected = '';
let lastOCRValid = false;

let ocrCounter = 0;
let ocrSkipInterval = 3;
let lastBoxCenter = null;

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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

function updateFPS() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    const fps = Math.round(frameCount * 1000 / (now - lastFpsTime));
    const el = document.getElementById('hud-fps');
    if (el) el.textContent = 'FPS ' + fps;
    frameCount = 0;
    lastFpsTime = now;
  }
}

async function runDiagnostics() {
  const list = document.getElementById('check-list');
  const summary = document.getElementById('check-summary');
  if (!list) return;

  const items = { device: [], browser: [], models: [] };
  let errors = 0;
  let warnings = 0;

  // ---- Dispositivo ----
  const mem = navigator.deviceMemory;
  if (mem !== undefined) {
    if (mem < 2) { items.device.push({ icon: 'err', label: 'Memoria insuficiente', detail: mem + ' GB. Se recomienda minimo 2 GB.', fix: 'Cierra otras apps.' }); errors++; }
    else if (mem < 4) { items.device.push({ icon: 'warn', label: 'Memoria limitada', detail: mem + ' GB. Podria ser lento.' }); warnings++; }
    else { items.device.push({ icon: 'ok', label: 'Memoria ' + mem + ' GB' }); }
  }
  const cpu = navigator.hardwareConcurrency;
  if (cpu) {
    if (cpu < 4) { items.device.push({ icon: 'warn', label: 'Procesador ' + cpu + ' nucleos', detail: 'Deteccion mas lenta.' }); warnings++; }
    else { items.device.push({ icon: 'ok', label: 'Procesador ' + cpu + ' nucleos' }); }
  }
  items.device.push({ icon: 'ok', label: 'Modo ' + (isMobile ? 'MOVIL' : 'ESCRITORIO') });

// ---- Navegador ----
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    items.browser.push({ icon: 'err', label: 'Camara no soportada', fix: 'Usa Chrome o Safari reciente.' }); errors++;
  } else if (navigator.permissions && navigator.permissions.query) {
    try {
      const perm = await navigator.permissions.query({ name: 'camera' });
      if (perm.state === 'granted') {
        items.browser.push({ icon: 'ok', label: 'Camara con permiso' });
      } else if (perm.state === 'denied') {
        items.browser.push({ icon: 'err', label: 'Permiso de camara denegado', detail: 'Bloqueaste el acceso a la camara.', fix: 'Ve a ajustes del navegador y permite el acceso a la camara, luego recarga.' }); errors++;
      } else {
        items.browser.push({ icon: 'warn', label: 'Permiso de camara pendiente', detail: 'Se pedira al iniciar el escaneo.' });
      }
      perm.onchange = () => runDiagnostics();
    } catch (e) {
      items.browser.push({ icon: 'warn', label: 'Permiso de camara desconocido', detail: 'Se pedira al iniciar el escaneo.' });
    }
  } else {
    items.browser.push({ icon: 'warn', label: 'Permiso de camara no verificable', detail: 'Se pedira al iniciar el escaneo.' });
  }
  let webglOk = false;
  try { webglOk = !!document.createElement('canvas').getContext('webgl'); } catch (e) {}
  if (webglOk) { items.browser.push({ icon: 'ok', label: 'Aceleracion grafica (WebGL)' }); }
  else { items.browser.push({ icon: 'warn', label: 'Sin aceleracion grafica', detail: 'Usara CPU, mas lento.' }); warnings++; }
  const wasmOk = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  if (wasmOk) { items.browser.push({ icon: 'ok', label: 'WebAssembly' }); }
  else { items.browser.push({ icon: 'err', label: 'WebAssembly no soportado', fix: 'Actualiza tu navegador.' }); errors++; }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    items.browser.push({ icon: 'err', label: 'Conexion no segura', detail: 'La camara requiere HTTPS.', fix: 'Usa HTTPS.' }); errors++;
  }

  // ---- Modelos IA ----
  if (detector && !detector.mock) { items.models.push({ icon: 'ok', label: 'Detector YOLOv8 activo' }); }
  else { items.models.push({ icon: 'warn', label: 'Detector cargando...' }); warnings++; }
  if (ocr && !ocr.mock) { items.models.push({ icon: 'ok', label: 'OCR PP-OCRv4 activo' }); }
  else { items.models.push({ icon: 'warn', label: 'OCR cargando...' }); warnings++; }

  // ---- Resumen (1 linea) ----
  if (summary) {
    if (errors > 0) summary.innerHTML = '&#9888;&#65039; ' + errors + ' problema' + (errors > 1 ? 's' : '') + ' detectado' + (errors > 1 ? 's' : '');
    else if (warnings > 0) summary.innerHTML = '&#9888;&#65039; ' + warnings + ' aviso' + (warnings > 1 ? 's' : '');
    else if (detector && !detector.mock && ocr && !ocr.mock) summary.innerHTML = '&#9989; Todo listo para escanear';
    else summary.innerHTML = '&#8987; Cargando...';
  }

  // ---- HTML colapsable ----
  const sections = [
    { title: 'Dispositivo', items: items.device },
    { title: 'Navegador', items: items.browser },
    { title: 'Modelos de IA', items: items.models },
  ];
  let html = '';
  for (const s of sections) {
    let sectionErrors = 0;
    for (const it of s.items) { if (it.icon === 'err') sectionErrors++; }
    const badge = sectionErrors > 0 ? '<span class="check-section-badge err">' + sectionErrors + '</span>' : '';
    html += '<div class="check-acc" data-section="' + s.title + '">';
    html += '<button class="check-acc-header"><span>' + s.title + '</span>' + badge + '<svg class="check-acc-arrow" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>';
    html += '<div class="check-acc-body">';
    for (const it of s.items) {
      const iconSvg = it.icon === 'ok' ? '&#10003;' : it.icon === 'warn' ? '&#9888;' : '&#33;';
      html += '<div class="check-item"><div class="check-item-icon ' + it.icon + '">' + iconSvg + '</div><div class="check-item-text">';
      html += '<div class="check-item-label">' + it.label + '</div>';
      if (it.detail) html += '<div class="check-item-detail">' + it.detail + '</div>';
      if (it.fix) html += '<div class="check-item-fix">' + it.fix + '</div>';
      html += '</div></div>';
    }
    html += '</div></div>';
  }
  list.innerHTML = html;

  // Eventos acordeon principal
  const toggle = document.getElementById('check-toggle');
  const body = document.getElementById('check-body-outer');
  if (toggle && body) {
    toggle.onclick = () => {
      toggle.classList.toggle('open');
      body.classList.toggle('open');
    };
  }
  // Eventos sub-secciones
  list.querySelectorAll('.check-acc-header').forEach(h => {
    h.onclick = () => {
      const acc = h.parentElement;
      h.classList.toggle('open');
      const b = acc.querySelector('.check-acc-body');
      if (b) b.classList.toggle('open');
    };
  });
}

function renderPlatesTable(filter) {
  const table = document.getElementById('plates-table');
  if (!table) return;
  const all = [
    ...DB.registered.map(p => ({ plate: p, type: 'reg' })),
    ...DB.stolen.map(p => ({ plate: p, type: 'stolen' })),
  ];
  const q = (filter || '').toUpperCase().trim();
  const rows = q ? all.filter(r => r.plate.includes(q)) : all;
  if (!rows.length) { table.innerHTML = '<div class="plates-empty">Sin resultados</div>'; return; }
  table.innerHTML = rows.map(r =>
    '<div class="plate-row"><span class="plate-row-plate">' + r.plate + '</span><span class="plate-row-badge ' + r.type + '">' + (r.type === 'reg' ? 'Registrada' : 'Denunciada') + '</span></div>'
  ).join('');
}

async function initModels() {
  setStatus('Cargando modelos...');
  const hud = document.getElementById('hud-gpu');
  if (hud) hud.textContent = isMobile ? 'MOVIL' : 'DESK';

  corrector = new Corrector();
  detector = new PlateDetector({ inputSize: 640, confThreshold: 0.15 });
  if (isMobile) detector._yoloSkip = 3;
  ocr = new PlateOCR();
  if (isMobile) ocrSkipInterval = 2;

  setStatus('Cargando detector YOLOv8...');
  const detBuf = await fetch('models/yolov8_plate.onnx').then(r => r.arrayBuffer());
  const detLoaded = await detector.loadModel(detBuf);

  setStatus('Cargando OCR PP-OCRv4...');
  const ocrLoaded = await ocr.loadModel('models/ppocr_rec.onnx', 'models/ppocr_keys.json');

  setStatus('Calentando modelos...');
  try {
    await Promise.race([
      Promise.all([detector.warmup(), ocr.warmup()]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ]);
  } catch (e) { console.warn('warmup skip:', e.message); }

  runDiagnostics();
  if (detLoaded && ocrLoaded) setStatus('Listo. Presiona Iniciar');
  else setStatus('Modo demo - faltan modelos');
  console.log('Detector:', detLoaded ? 'OK' : 'FAIL', 'OCR:', ocrLoaded ? 'OK' : 'FAIL');
}

async function startCamera() {
  try {
    camera = new Camera(document.getElementById('video'));
    const resolution = isMobile ? '640x480' : '1280x720';
    await camera.start(resolution, 30);
    return true;
  } catch (e) {
    showToast('Error camara: ' + e.message, 'error');
    return false;
  }
}

function setStatus(msg) { const el = document.getElementById('cam-status'); if (el) el.textContent = msg; }

function stopCamera() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (camera) { camera.stop(); camera = null; }
  lastPlate = null;
  lastPlateBox = null;
  noDetectFrames = 0;
  streakCandidate = null;
  streakCount = 0;
  ocrCounter = 0;
  lastBoxCenter = null;
  if (detector) detector._smoothBox = null;
  document.getElementById('scan-toggle').checked = false;
  document.getElementById('switch-label').textContent = 'Iniciar deteccion';
  document.getElementById('cam-status').classList.remove('scanning');
  document.getElementById('cam-container').classList.remove('scanning');
  hideOverlay();
  clearCanvasOverlay();
  setStatus('En espera');
}

window.toggleScan = async function () {
  if (running) { stopCamera(); setStatus('Detenido'); return; }
  if (!camera && !(await startCamera())) { document.getElementById('scan-toggle').checked = false; return; }
  running = true;
  document.getElementById('switch-label').textContent = 'Apagar camara';
  document.getElementById('cam-status').classList.add('scanning');
  document.getElementById('cam-container').classList.add('scanning');
  setStatus('Escaneando...');
  lastPlate = null;
  noDetectFrames = 0;
  if (detector) detector._smoothBox = null;
  requestAnimationFrame(loop);
};

function resizeCanvas() {
  const video = document.getElementById('video');
  const canvas = document.getElementById('overlay-canvas');
  if (!video || !video.videoWidth || !canvas) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

async function loop() {
  if (!running) return;
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) { rafId = requestAnimationFrame(loop); return; }
  updateFPS();
  resizeCanvas();

  let boxes = [];
  if (detector && !detector.mock) {
    try {
      boxes = await detector.detect(video);
    } catch (e) { console.warn('detect error:', e); }
  }

  if (boxes.length > 0) {
    noDetectFrames = 0;
    const box = boxes[0];

    if (lastPlate || streakCandidate) {
      lastPlateBox = { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
    }

    const center = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
    const isStable = lastBoxCenter &&
      Math.abs(center.x - lastBoxCenter.x) < bw * 0.15 &&
      Math.abs(center.y - lastBoxCenter.y) < bh * 0.15;
    lastBoxCenter = center;

    ocrCounter++;
    const skipOCR = isStable && (ocrCounter % ocrSkipInterval !== 0);

    if (!skipOCR && ocr && !ocr.mock) {
      const crop = detector.cropPlate(video, box);
      if (crop) {
        let rawText = '';
        try { rawText = await ocr.recognize(crop); } catch (e) { console.warn('OCR error:', e); }
        lastRawText = rawText || '(vacio)';

        if (rawText) {
          const normalized = normalizePlate(rawText);
          const corrected = corrector.correct(normalized);
          lastCorrected = corrected || '(vacio)';
          lastOCRValid = validatePlate(corrected) && corrected.length === 6;

          if (lastOCRValid) {
            if (corrected === streakCandidate) streakCount++;
            else { streakCandidate = corrected; streakCount = 1; }

            if (streakCount >= streakRequired && streakCandidate !== lastPlate) {
              lastPlate = streakCandidate;
              lastPlateBox = { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
              processPlate(lastPlate);
              streakCount = 0;
            }
          } else {
            streakCandidate = null; streakCount = 0;
          }
        } else {
          lastCorrected = '(vacio)';
          lastOCRValid = false;
          streakCandidate = null; streakCount = 0;
        }
      }
    }
  } else {
    noDetectFrames++;
    streakCandidate = null; streakCount = 0;
    if (noDetectFrames > noDetectLimit && lastPlate) {
      lastPlate = null; lastPlateBox = null;
      hideOverlay();
    }
  }

  drawCanvasOverlay(boxes);
  rafId = requestAnimationFrame(loop);
}

function drawCanvasOverlay(boxes) {
  const canvas = document.getElementById('overlay-canvas');
  if (!canvas || !canvas.width) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const d of boxes) {
    const iw = d.x2 - d.x1;
    const ih = d.y2 - d.y1;
    if (iw < 2 || ih < 2) continue;
    ctx.strokeStyle = d.score > 0.5 ? '#00ff66' : '#ffcc00';
    ctx.lineWidth = 3;
    ctx.strokeRect(d.x1, d.y1, iw, ih);
    ctx.fillStyle = d.score > 0.5 ? '#00ff66' : '#ffcc00';
    ctx.font = 'bold 13px monospace';
    ctx.fillText((d.score * 100).toFixed(0) + '%', d.x1, d.y1 - 5);
  }

  if (lastPlate && lastPlateBox) {
    const box = lastPlateBox;
    const iw = box.x2 - box.x1, ih = box.y2 - box.y1;
    ctx.strokeStyle = '#00ff66';
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x1, box.y1, iw, ih);

    const display = formatPlate(lastPlate);
    ctx.font = 'bold 20px monospace';
    const tw = ctx.measureText(display).width;
    const lx = box.x1;
    const ly = Math.max(4, box.y1 - 34);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(lx, ly, tw + 16, 30);
    ctx.fillStyle = '#00ff66';
    ctx.fillText(display, lx + 8, ly + 22);
  }

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(cx - 30, cy); ctx.lineTo(cx + 30, cy);
  ctx.moveTo(cx, cy - 30); ctx.lineTo(cx, cy + 30);
  ctx.stroke();
  ctx.setLineDash([]);

  if (boxes.length === 0 && !lastPlate) {
    ctx.fillStyle = 'rgba(255,50,50,0.6)';
    ctx.font = '14px sans-serif';
    ctx.fillText('Sin deteccion', 10, 20);
  }
}

function clearCanvasOverlay() {
  const canvas = document.getElementById('overlay-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function formatPlate(p) {
  if (/^[A-Z]{4}\d{2}$/.test(p)) return p.slice(0, 4) + ' ' + p.slice(4);
  if (/^[A-Z]{2}\d{4}$/.test(p)) return p.slice(0, 2) + ' ' + p.slice(2);
  return p;
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

window.navigate = function (view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const vEl = document.getElementById('view-' + view);
  if (vEl) vEl.classList.add('active');
  const nEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (nEl) nEl.classList.add('active');
  if (view !== 'camera') stopCamera();
  if (view === 'camera') updateHistory();
  if (view === 'home') runDiagnostics();
  if (view === 'plates') renderPlatesTable();
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
  document.getElementById('btn-home-plates').onclick = () => window.navigate('plates');
  document.getElementById('btn-plates-back').onclick = () => window.navigate('home');
  document.getElementById('plate-search').oninput = function() { renderPlatesTable(this.value); };
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
  updateHistory(); renderContacts(); initDB(); initModels(); runDiagnostics();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});