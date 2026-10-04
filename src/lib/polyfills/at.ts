/** Array.prototype.at + String.prototype.at (ES2022). */
/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any */
function atPolyfill(this: any, n: number) {
  n = Math.trunc(n) || 0;
  if (n < 0) n += this.length;
  if (n < 0 || n >= this.length) return undefined;
  return this[n];
}
if (typeof (Array.prototype as any).at !== 'function') (Array.prototype as any).at = atPolyfill;
if (typeof (String.prototype as any).at !== 'function') (String.prototype as any).at = atPolyfill;
export {};
