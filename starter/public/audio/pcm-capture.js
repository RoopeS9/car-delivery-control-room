// Mic capture for the in-app call screen: any context rate -> 24 kHz mono PCM16,
// 20 ms (480 sample) frames posted to the main thread. Box-filter resampling with
// fractional edges, the same method as the phone's own capture worklet.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 24000
    this.acc = 0
    this.fill = 0
    this.out = new Int16Array(480)
    this.n = 0
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      let weight = 1
      const value = input[i]
      while (weight > 1e-9) {
        const take = Math.min(weight, this.ratio - this.fill)
        this.acc += value * take
        this.fill += take
        weight -= take
        if (this.fill >= this.ratio - 1e-9) {
          const sample = Math.max(-1, Math.min(1, this.acc / this.ratio))
          this.out[this.n++] = sample < 0 ? sample * 32768 : sample * 32767
          this.acc = 0
          this.fill = 0
          if (this.n === 480) {
            this.port.postMessage(this.out.buffer, [this.out.buffer])
            this.out = new Int16Array(480)
            this.n = 0
          }
        }
      }
    }
    return true
  }
}
registerProcessor("pcm-capture", PcmCapture)
