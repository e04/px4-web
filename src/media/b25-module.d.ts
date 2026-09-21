declare module '*generated/b25.js' {
  interface B25Module {
    HEAPU8: Uint8Array;
    cardError?: string;
    ccall(
      name: string,
      result: string | null,
      types: string[],
      values: number[],
      options?: { async: boolean },
    ): number | Promise<number>;
    _b25_input(): number;
    _b25_get(): number;
    _b25_output(): number;
    _b25_close(): void;
  }
  export default function create(options: {
    apdu(bytes: Uint8Array): Promise<Uint8Array>;
  }): Promise<B25Module>;
}
