declare module '*generated/tuner' {
  interface TunerModule {
    ioError?: unknown;
    ccall(
      name: string,
      result: 'number',
      types: string[],
      args: number[],
      options: { async: true },
    ): Promise<number>;
  }
  export default function createTuner(options: {
    i2cRead: (address: number, length: number) => Promise<Uint8Array>;
    i2cWrite: (address: number, bytes: Uint8Array) => Promise<void>;
    printErr: (message: string) => void;
  }): Promise<TunerModule>;
}
