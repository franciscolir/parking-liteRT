// camera.js - Control de camara con MediaDevices API
export class Camera {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.constraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'environment' },
      audio: false
    };
  }

  async start(resolution = '1280x720', fps = 30) {
    const [w, h] = resolution.split('x').map(Number);
    this.constraints.video.width = { ideal: w };
    this.constraints.video.height = { ideal: h };
    this.constraints.video.frameRate = { ideal: fps };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(this.constraints);
      this.video.srcObject = this.stream;
      await this.video.play();

      // Activar linterna si el dispositivo lo soporta
      const track = this.stream.getVideoTracks()[0];
      if (track && 'torch' in track) {
        try { track.applyConstraints({ advanced: [{ torch: true }] }); } catch (_) {}
      }
      return true;
    } catch (e) {
      console.error('[Camera] Failed:', e);
      throw e;
    }
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  getVideo() {
    return this.video;
  }
}