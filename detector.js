import * as ort from 'onnxruntime-web';

export class PlateDetector {
  constructor(options = {}) {
    this.session = null;
    this.inputSize = options.inputSize || 640;
    this.confThreshold = options.confThreshold || 0.5;
    this.iouThreshold = options.iouThreshold || 0.45;

    this.fbEdge = options.fbEdge ?? 0.08;
    this.fbRowFactor = options.fbRowFactor ?? 0.10;
    this.fbColFactor = options.fbColFactor ?? 0.12;
    this.fbMinHeight = options.fbMinHeight ?? 4;
    this.fbSizeLimit = options.fbSizeLimit ?? 0.95;

    this.mock = true;
    this._transform = null;
    this._smoothBox = null;

    this._yoloCounter = 0;
    this._yoloSkip = 2;
    this._lastGoodBox = null;
    this._goodBoxAge = 0;
    this._lastFallback = false;
    this._lastRawPreds = 0;
    this._lastMaxConf = 0;

    this._preprocCanvas = null;
    this._preprocCtx = null;
    this._fbCanvas = null;
    this._fbCtx = null;
    this._fbGray = null;
    this._fbGrad = null;
    this._fbRowCount = null;
    this._fbColCount = null;
    this._cropCanvas = null;
    this._cropCtx = null;
  }

  async loadModel(modelPath) {
    try {
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['webgl', 'wasm'],
      });
      this.mock = false;
    } catch (e) {
      console.warn('[Detector] ONNX load failed:', e.message);
    }
    return !this.mock;
  }

  async warmup() {
    if (this.mock) return;
    const sz = this.inputSize;
    const dummy = new ort.Tensor('float32', new Float32Array(3 * sz * sz), [1, 3, sz, sz]);
    await this.session.run({ [this.session.inputNames[0]]: dummy });
  }

  async detect(video) {
    if (this.mock) return [];

    this._yoloCounter++;
    const skip = (this._yoloCounter % this._yoloSkip !== 0) && this._lastGoodBox && this._goodBoxAge < 8;
    if (skip) {
      this._goodBoxAge++;
      return [{ ...this._lastGoodBox }];
    }

    const input = this._preprocess(video);
    const results = await this.session.run({ [this.session.inputNames[0]]: input });
    const output = results[this.session.outputNames[0]];

    const rawBoxes = this._decodeAll(output.data, output.dims);
    const nmsBoxes = this._nms(rawBoxes);
    const highConf = nmsBoxes.filter(b => b.score >= this.confThreshold);
    let mapped = highConf.map(b => this._toOriginal(b)).filter(b => {
      const w = b.x2 - b.x1;
      const h = b.y2 - b.y1;
      return w >= 30 && h >= 10 && w / h < 12;
    });

    this._lastRawPreds = rawBoxes.length;
    this._lastMaxConf = rawBoxes.length ? Math.max(...rawBoxes.map(b => b.score)) : 0;
    this._lastFallback = mapped.length > 0 && rawBoxes.filter(b => b.score >= this.confThreshold).length === 0;

    if (mapped.length === 0) {
      const fallback = this._detectFallback(video);
      if (fallback) {
        if (this._smoothBox) {
          const d = Math.hypot(fallback.x1 - this._smoothBox.x1, fallback.y1 - this._smoothBox.y1);
          const boxSz = Math.hypot(this._smoothBox.x2 - this._smoothBox.x1, this._smoothBox.y2 - this._smoothBox.y1);
          if (d > boxSz * 1.5) this._smoothBox = null;
        }
        if (this._smoothBox) {
          const alpha = 0.35;
          this._smoothBox.x1 += (fallback.x1 - this._smoothBox.x1) * alpha;
          this._smoothBox.y1 += (fallback.y1 - this._smoothBox.y1) * alpha;
          this._smoothBox.x2 += (fallback.x2 - this._smoothBox.x2) * alpha;
          this._smoothBox.y2 += (fallback.y2 - this._smoothBox.y2) * alpha;
          const t = this._transform;
          this._smoothBox.x1 = Math.max(0, this._smoothBox.x1);
          this._smoothBox.y1 = Math.max(0, this._smoothBox.y1);
          this._smoothBox.x2 = Math.min(t.vw, this._smoothBox.x2);
          this._smoothBox.y2 = Math.min(t.vh, this._smoothBox.y2);
          this._smoothBox.score = Math.max(0.5, fallback.score);
          this._smoothBox.hangCount = 0;
        } else {
          this._smoothBox = { x1: fallback.x1, y1: fallback.y1, x2: fallback.x2, y2: fallback.y2, score: fallback.score, hangCount: 0 };
        }
        mapped = [{ x1: this._smoothBox.x1, y1: this._smoothBox.y1, x2: this._smoothBox.x2, y2: this._smoothBox.y2, score: this._smoothBox.score }];
      } else if (this._smoothBox) {
        this._smoothBox.hangCount++;
        if (this._smoothBox.hangCount > 30) {
          this._smoothBox = null;
        } else {
          this._smoothBox.score = Math.max(0.2, this._smoothBox.score * 0.96);
          mapped = [{ x1: this._smoothBox.x1, y1: this._smoothBox.y1, x2: this._smoothBox.x2, y2: this._smoothBox.y2, score: this._smoothBox.score }];
        }
      }
    } else {
      this._smoothBox = null;
    }

    if (mapped.length > 0) {
      this._lastGoodBox = { ...mapped[0] };
      this._goodBoxAge = 0;
    } else {
      this._goodBoxAge++;
    }

    return mapped;
  }

  _vw(v) { return v.videoWidth || v.width || 0; }
  _vh(v) { return v.videoHeight || v.height || 0; }

  _preprocess(video) {
    const vw = this._vw(video);
    const vh = this._vh(video);
    const maxSize = Math.max(vw, vh);
    const isz = this.inputSize;
    const scale = isz / maxSize;
    const ox = (isz - vw * scale) / 2;
    const oy = (isz - vh * scale) / 2;

    this._transform = { scale, ox, oy, vw, vh };

    if (!this._preprocCanvas) {
      this._preprocCanvas = document.createElement('canvas');
      this._preprocCtx = this._preprocCanvas.getContext('2d', { willReadFrequently: true });
    }
    this._preprocCanvas.width = isz;
    this._preprocCanvas.height = isz;
    const ctx = this._preprocCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, isz, isz);
    ctx.drawImage(video, ox, oy, vw * scale, vh * scale);

    const rgba = ctx.getImageData(0, 0, isz, isz).data;
    const ch = isz * isz;
    const data = new Float32Array(3 * ch);
    for (let i = 0; i < ch; i++) {
      const pi = i << 2;
      data[i] = rgba[pi] / 255;
      data[ch + i] = rgba[pi + 1] / 255;
      data[2 * ch + i] = rgba[pi + 2] / 255;
    }
    return new ort.Tensor('float32', data, [1, 3, isz, isz]);
  }

  _decodeAll(data, dims) {
    const numPreds = dims[2];
    const raw = [];
    const sample = data instanceof Float32Array ? data : new Float32Array(data);
    const maxCx = Math.max(...Array.from(sample.subarray(0, Math.min(numPreds, 100))));
    const normalized = maxCx < 2;
    const scale = normalized ? this.inputSize : 1;

    for (let i = 0; i < numPreds; i++) {
      const cx = sample[i];
      const cy = sample[numPreds + i];
      const w = sample[2 * numPreds + i];
      const h = sample[3 * numPreds + i];
      const conf = sample[4 * numPreds + i];
      if (conf < 0.05) continue;
      raw.push({
        x1: (cx - w / 2) * scale,
        y1: (cy - h / 2) * scale,
        x2: (cx + w / 2) * scale,
        y2: (cy + h / 2) * scale,
        score: conf,
      });
    }
    return raw;
  }

  _nms(detections) {
    detections.sort((a, b) => b.score - a.score);
    const picked = new Array(detections.length).fill(false);
    const result = [];
    for (let i = 0; i < detections.length; i++) {
      if (picked[i]) continue;
      result.push(detections[i]);
      for (let j = i + 1; j < detections.length; j++) {
        if (picked[j]) continue;
        if (this._iou(detections[i], detections[j]) >= this.iouThreshold) {
          picked[j] = true;
        }
      }
    }
    return result;
  }

  _iou(a, b) {
    const x1 = Math.max(a.x1, b.x1);
    const y1 = Math.max(a.y1, b.y1);
    const x2 = Math.min(a.x2, b.x2);
    const y2 = Math.min(a.y2, b.y2);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    return inter / (areaA + areaB - inter + 1e-6);
  }

  _toOriginal(box) {
    const t = this._transform;
    return {
      x1: Math.max(0, (box.x1 - t.ox) / t.scale),
      y1: Math.max(0, (box.y1 - t.oy) / t.scale),
      x2: Math.min(t.vw, (box.x2 - t.ox) / t.scale),
      y2: Math.min(t.vh, (box.y2 - t.oy) / t.scale),
      score: box.score,
    };
  }

  _detectFallback(video) {
    const vw = this._vw(video);
    const vh = this._vh(video);
    if (vw < 50 || vh < 50) return null;

    if (!this._fbCanvas) {
      this._fbCanvas = document.createElement('canvas');
      this._fbCtx = this._fbCanvas.getContext('2d', { willReadFrequently: true });
    }
    this._fbCanvas.width = vw;
    this._fbCanvas.height = vh;
    const ctx = this._fbCtx;
    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, vw, vh);
    const data = imageData.data;

    const total = vw * vh;
    if (!this._fbGray || this._fbGray.length !== total) {
      this._fbGray = new Uint8Array(total);
      this._fbGrad = new Float32Array(total);
      this._fbRowCount = new Uint16Array(vh);
      this._fbColCount = new Uint16Array(vw);
    }
    const gray = this._fbGray;
    const grad = this._fbGrad;
    const rowCount = this._fbRowCount;
    const colCount = this._fbColCount;

    for (let i = 0; i < total; i++) {
      const pi = i << 2;
      gray[i] = (data[pi] * 0.299 + data[pi + 1] * 0.587 + data[pi + 2] * 0.114) | 0;
    }

    let maxGrad = 0;
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw - 1; x++) {
        const idx = y * vw + x;
        const g = Math.abs(gray[idx] - gray[idx + 1]);
        grad[idx] = g;
        if (g > maxGrad) maxGrad = g;
      }
    }
    if (maxGrad < 5) return null;

    const edgeThresh = maxGrad * this.fbEdge;

    for (let y = 0; y < vh; y++) {
      let c = 0;
      for (let x = 0; x < vw; x++) { if (grad[y * vw + x] > edgeThresh) c++; }
      rowCount[y] = c;
    }

    let maxR = 0;
    for (let y = 0; y < vh; y++) { if (rowCount[y] > maxR) maxR = rowCount[y]; }
    if (maxR < 3) return null;

    const rowMin = Math.max(3, maxR * this.fbRowFactor);
    let yS = -1, yE = -1;
    for (let y = 0; y < vh; y++) {
      if (rowCount[y] > rowMin) { if (yS === -1) yS = y; yE = y; }
    }
    if (yS === -1 || yE - yS < 3) return null;

    yS = Math.max(0, yS - 3);
    yE = Math.min(vh, yE + 3);

    for (let x = 0; x < vw; x++) {
      let c = 0;
      for (let y = yS; y < yE; y++) { if (grad[y * vw + x] > edgeThresh) c++; }
      colCount[x] = c;
    }

    let maxC = 0;
    for (let x = 0; x < vw; x++) { if (colCount[x] > maxC) maxC = colCount[x]; }
    if (maxC < 3) return null;

    const colMin = Math.max(3, maxC * this.fbColFactor);
    let xS = -1, xE = -1;
    for (let x = 0; x < vw; x++) {
      if (colCount[x] > colMin) { if (xS === -1) xS = x; xE = x; }
    }
    if (xS === -1 || xE - xS < 10) return null;

    xS = Math.max(0, xS - 4);
    xE = Math.min(vw, xE + 4);

    const pw = xE - xS;
    const ph = yE - yS;
    if (pw < 10 || ph < this.fbMinHeight) return null;
    if (pw > vw * this.fbSizeLimit || ph > vh * this.fbSizeLimit) return null;

    const aspect = pw / ph;
    const aspectScore = Math.max(0, 1 - Math.abs(aspect - 3.5) / 5);
    const densityScore = Math.min(1, (maxR + maxC) / (vw * 0.05 + vh * 0.5));
    const score = 0.2 + 0.4 * aspectScore + 0.4 * densityScore;

    return { x1: xS, y1: yS, x2: xE, y2: yE, score: Math.min(0.7, score) };
  }

  cropPlate(video, box) {
    const w = Math.round(box.x2 - box.x1);
    const h = Math.round(box.y2 - box.y1);
    if (w < 4 || h < 4) return null;
    if (!this._cropCanvas) {
      this._cropCanvas = document.createElement('canvas');
      this._cropCtx = this._cropCanvas.getContext('2d', { willReadFrequently: true });
    }
    this._cropCanvas.width = w;
    this._cropCanvas.height = h;
    this._cropCtx.drawImage(video, box.x1, box.y1, w, h, 0, 0, w, h);
    return this._cropCtx.getImageData(0, 0, w, h);
  }
}