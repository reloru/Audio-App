import { TruePeakLimiter } from '../dsp/limiter';

interface LimiterOptions {
  ceilingDb: number;
  enabled: boolean;
}

class BounceLimiter extends AudioWorkletProcessor {
  private lim: TruePeakLimiter;
  private enabled: boolean;
  private ceilingDb: number;
  private spare = new Float32Array(128);

  constructor(options: { processorOptions?: LimiterOptions }) {
    super();
    const o = options.processorOptions ?? { ceilingDb: -1, enabled: true };
    this.ceilingDb = o.ceilingDb;
    this.enabled = o.enabled;
    this.lim = this.make();
    this.port.onmessage = (e: MessageEvent<Partial<LimiterOptions>>) => {
      if (typeof e.data.enabled === 'boolean') this.enabled = e.data.enabled;
      if (typeof e.data.ceilingDb === 'number' && e.data.ceilingDb !== this.ceilingDb) {
        this.ceilingDb = e.data.ceilingDb;
        this.lim = this.make();
      }
    };
  }

  private make(): TruePeakLimiter {
    return new TruePeakLimiter({ sampleRate, channels: 2, ceilingDb: this.ceilingDb, lookaheadMs: 3 });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const n = output[0].length;
    if (this.spare.length < n) this.spare = new Float32Array(n);
    const oL = output[0];
    const oR = output[1] ?? this.spare;
    if (!input || input.length === 0) {
      // Keep feeding silence so the look-ahead tail drains.
      const z = [new Float32Array(n), new Float32Array(n)];
      if (this.enabled) this.lim.process(z, [oL, oR], n);
      else {
        oL.fill(0);
        oR.fill(0);
      }
      return true;
    }
    const iL = input[0];
    const iR = input[1] ?? input[0];
    if (!this.enabled) {
      oL.set(iL);
      oR.set(iR);
      return true;
    }
    this.lim.process([iL, iR], [oL, oR], n);
    return true;
  }
}

registerProcessor('bounce-limiter', BounceLimiter);
