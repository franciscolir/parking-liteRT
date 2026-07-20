// OCR Worker - procesamiento pesado fuera del main thread
self.onmessage = function (e) {
  const { imageData, width, height } = e.data;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.putImageData(imageData, 0, 0);

    const plate = processCanvas(canvas);
    self.postMessage({ plate });
  } catch (err) {
    self.postMessage({ plate: null, error: err.message });
  }
};

function processCanvas(canvas) {
  if (canvas.width < 40 || canvas.height < 20) return null;

  // Limit input size
  let src = canvas;
  if (canvas.width > 300 || canvas.height > 200) {
    const r = Math.min(300 / canvas.width, 200 / canvas.height, 1);
    src = new OffscreenCanvas(Math.round(canvas.width * r), Math.round(canvas.height * r));
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, src.width, src.height);
  }

  // Scale 3x
  const scale = 3;
  const scaled = new OffscreenCanvas(Math.max(60, Math.round(src.width * scale)), Math.max(60, Math.round(src.height * scale)));
  const sctx = scaled.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0, scaled.width, scaled.height);

  binarize(scaled);

  const chars = segmentChars(scaled);
  if (chars.length < 4 || chars.length > 8) return null;

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

function binarize(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width, h = canvas.height;
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
      const local = sum / ((x2 - x1) * (y2 - y1)) - 8;
      const pi = (y * w + x) * 4;
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
        const d = density[y * 3 + x];
        score += tArr[y][x] === 1 ? d : (1 - d);
      }
    }
    if (score > bestScore) { bestScore = score; best = ch; }
  }
  return bestScore > 6 ? best : null;
}
