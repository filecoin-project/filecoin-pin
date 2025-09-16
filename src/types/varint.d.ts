declare module 'varint' {
  export function encode(num: number): number[]
  export function decode(buf: Uint8Array | number[], offset?: number): number
  export const encodingLength: (num: number) => number
}
