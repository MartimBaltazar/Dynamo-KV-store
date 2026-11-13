/** Final avalanche step of MurmurHash3: spreads every input bit over the output. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 32-bit string hash: FNV-1a followed by the murmur3 finalizer. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/** Order-sensitive combination of two 32-bit hashes. */
export function mix32(a: number, b: number): number {
  return fmix32(Math.imul(a ^ 0x9e3779b9, 0x01000193) ^ b);
}
