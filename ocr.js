import * as ort from 'onnxruntime-web';

export class PlateOCR {
  constructor() {
    this.session = null;
    this.chars = [''];
    this.inputHeight = 48;
    this.mock = true;
    this._srcCanvas = null;
    this._dstCanvas = null;
  }

  async loadModel(modelPath, keysPath) {
    try {
      const [session, chars] = await Promise.all([
        ort.InferenceSession.create(modelPath, {
          executionProviders: ['webgl', 'wasm'],
        }),
        fetch(keysPath).then(r => r.json()),
      ]);
      this.session = session;
      this.chars = chars;
      this.mock = false;
    } catch (e) {
      console.warn('[OCR] ONNX load failed:', e.message);
      this.mock = true;
    }
    return !this.mock;
  }

  async warmup() {
    if (this.mock) return;
    const dummyW = 100;
    const dummy = new ort.Tensor('float32', new Float32Array(3 * this.inputHeight * dummyW), [1, 3, this.inputHeight, dummyW]);
    await this.session.run({ [this.session.inputNames[0]]: dummy });
  }

  async recognize(imageData) {
    if (this.mock) return '';
    const { data, shape } = this._preprocess(imageData);
    const ortTensor = new ort.Tensor('float32', data, shape);
    const results = await this.session.run({ [this.session.inputNames[0]]: ortTensor });
    const output = results[this.session.outputNames[0]];
    return this._ctcGreedyDecode(output.data, output.dims);
  }

  _preprocess(imageData) {
    const oldW = imageData.width;
    const oldH = imageData.height;
    const newH = this.inputHeight;
    const newW = Math.max(1, Math.round(oldW * (newH / oldH)));

    if (!this._srcCanvas) {
      this._srcCanvas = document.createElement('canvas');
      this._dstCanvas = document.createElement('canvas');
    }
    this._srcCanvas.width = oldW;
    this._srcCanvas.height = oldH;
    this._srcCanvas.getContext('2d').putImageData(imageData, 0, 0);

    this._dstCanvas.width = newW;
    this._dstCanvas.height = newH;
    const dstCtx = this._dstCanvas.getContext('2d', { willReadFrequently: true });
    dstCtx.drawImage(this._srcCanvas, 0, 0, newW, newH);

    const resized = dstCtx.getImageData(0, 0, newW, newH);
    const pixels = resized.data;

    const nchw = new Float32Array(3 * newH * newW);
    for (let y = 0; y < newH; y++) {
      for (let x = 0; x < newW; x++) {
        const srcIdx = (y * newW + x) * 4;
        const dstIdx = y * newW + x;
        nchw[dstIdx] = pixels[srcIdx] / 127.5 - 1.0;
        nchw[newH * newW + dstIdx] = pixels[srcIdx + 1] / 127.5 - 1.0;
        nchw[2 * newH * newW + dstIdx] = pixels[srcIdx + 2] / 127.5 - 1.0;
      }
    }

    return { data: nchw, shape: [1, 3, newH, newW] };
  }

  _ctcGreedyDecode(data, dims) {
    const timeSteps = dims[1];
    const vocabSize = dims[2];
    const arr = data instanceof Float32Array ? data : new Float32Array(data);
    let prev = 0;
    let result = '';
    for (let t = 0; t < timeSteps; t++) {
      let bestIdx = 0;
      let bestVal = -Infinity;
      const offset = t * vocabSize;
      for (let v = 0; v < vocabSize; v++) {
        if (arr[offset + v] > bestVal) {
          bestVal = arr[offset + v];
          bestIdx = v;
        }
      }
      if (bestIdx !== 0 && bestIdx !== prev) {
        result += this.chars[bestIdx] || '';
      }
      prev = bestIdx;
    }
    return result;
  }
}