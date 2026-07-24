export class FallbackDetector {
  constructor(options = {}) {
    this.fbEdge = options.fbEdge ?? 0.08;
    this.fbRowFactor = options.fbRowFactor ?? 0.10;
    this.fbColFactor = options.fbColFactor ?? 0.12;
    this.fbMinHeight = options.fbMinHeight ?? 4;
    this.fbSizeLimit = options.fbSizeLimit ?? 0.95;
    this._smoothBox = null;
    this._fbCanvas = null;
    this._fbCtx = null;
    this._fbGray = null;
    this._fbGrad = null;
    this._fbRowCount = null;
    this._fbColCount = null;
  }

  detect(video) {
    const vw = video.videoWidth || video.width || 0;
    const vh = video.videoHeight || video.height || 0;
    if (vw < 50 || vh < 50) return this._handleHang();

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
    if (maxGrad < 5) return this._handleHang();

    const edgeThresh = maxGrad * this.fbEdge;

    for (let y = 0; y < vh; y++) {
      let c = 0;
      for (let x = 0; x < vw; x++) { if (grad[y * vw + x] > edgeThresh) c++; }
      rowCount[y] = c;
    }

    let maxR = 0;
    for (let y = 0; y < vh; y++) { if (rowCount[y] > maxR) maxR = rowCount[y]; }
    if (maxR < 3) return this._handleHang();

    const rowMin = Math.max(3, maxR * this.fbRowFactor);
    let yS = -1, yE = -1;
    for (let y = 0; y < vh; y++) {
      if (rowCount[y] > rowMin) { if (yS === -1) yS = y; yE = y; }
    }
    if (yS === -1 || yE - yS < 3) return this._handleHang();

    yS = Math.max(0, yS - 3);
    yE = Math.min(vh, yE + 3);

    for (let x = 0; x < vw; x++) {
      let c = 0;
      for (let y = yS; y < yE; y++) { if (grad[y * vw + x] > edgeThresh) c++; }
      colCount[x] = c;
    }

    let maxC = 0;
    for (let x = 0; x < vw; x++) { if (colCount[x] > maxC) maxC = colCount[x]; }
    if (maxC < 3) return this._handleHang();

    const colMin = Math.max(3, maxC * this.fbColFactor);
    let xS = -1, xE = -1;
    for (let x = 0; x < vw; x++) {
      if (colCount[x] > colMin) { if (xS === -1) xS = x; xE = x; }
    }
    if (xS === -1 || xE - xS < 10) return this._handleHang();

    xS = Math.max(0, xS - 4);
    xE = Math.min(vw, xE + 4);

    const pw = xE - xS;
    const ph = yE - yS;
    if (pw < 10 || ph < this.fbMinHeight) return this._handleHang();
    if (pw > vw * this.fbSizeLimit || ph > vh * this.fbSizeLimit) return this._handleHang();

    const aspect = pw / ph;
    const aspectScore = Math.max(0, 1 - Math.abs(aspect - 3.5) / 5);
    const densityScore = Math.min(1, (maxR + maxC) / (vw * 0.05 + vh * 0.5));
    const score = 0.2 + 0.4 * aspectScore + 0.4 * densityScore;

    const result = { x1: xS, y1: yS, x2: xE, y2: yE, score: Math.min(0.7, score) };

    if (this._smoothBox) {
      const d = Math.hypot(result.x1 - this._smoothBox.x1, result.y1 - this._smoothBox.y1);
      const boxSz = Math.hypot(this._smoothBox.x2 - this._smoothBox.x1, this._smoothBox.y2 - this._smoothBox.y1);
      if (d > boxSz * 1.5) this._smoothBox = null;
    }
    if (this._smoothBox) {
      const alpha = 0.35;
      this._smoothBox.x1 += (result.x1 - this._smoothBox.x1) * alpha;
      this._smoothBox.y1 += (result.y1 - this._smoothBox.y1) * alpha;
      this._smoothBox.x2 += (result.x2 - this._smoothBox.x2) * alpha;
      this._smoothBox.y2 += (result.y2 - this._smoothBox.y2) * alpha;
      this._smoothBox.x1 = Math.max(0, this._smoothBox.x1);
      this._smoothBox.y1 = Math.max(0, this._smoothBox.y1);
      this._smoothBox.x2 = Math.min(vw, this._smoothBox.x2);
      this._smoothBox.y2 = Math.min(vh, this._smoothBox.y2);
      this._smoothBox.score = Math.max(0.5, result.score);
      this._smoothBox.hangCount = 0;
    } else {
      this._smoothBox = { x1: result.x1, y1: result.y1, x2: result.x2, y2: result.y2, score: result.score, hangCount: 0 };
    }
    return { x1: this._smoothBox.x1, y1: this._smoothBox.y1, x2: this._smoothBox.x2, y2: this._smoothBox.y2, score: this._smoothBox.score };
  }

  _handleHang() {
    if (this._smoothBox) {
      this._smoothBox.hangCount++;
      if (this._smoothBox.hangCount > 30) {
        this._smoothBox = null;
        return null;
      }
      this._smoothBox.score = Math.max(0.2, this._smoothBox.score * 0.96);
      return { x1: this._smoothBox.x1, y1: this._smoothBox.y1, x2: this._smoothBox.x2, y2: this._smoothBox.y2, score: this._smoothBox.score };
    }
    return null;
  }

  reset() {
    this._smoothBox = null;
  }
}
