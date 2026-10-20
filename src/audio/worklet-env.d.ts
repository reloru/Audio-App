// Minimal AudioWorkletGlobalScope typings (not part of the DOM lib).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new (options: never) => AudioWorkletProcessor): void;
declare const sampleRate: number;
