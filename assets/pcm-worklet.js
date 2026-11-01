/* Scribe: turns mic audio (Float32, mono) into 16-bit little-endian PCM chunks of ~100 ms. */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.round(sampleRate / 10);
    this.buffer = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.peak = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.peak = Math.max(this.peak, Math.abs(s));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === this.chunkSize) {
        this.port.postMessage({ pcm: this.buffer.buffer, level: this.peak }, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.chunkSize);
        this.offset = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
