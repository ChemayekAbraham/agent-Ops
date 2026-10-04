/** String.prototype.padStart + padEnd (ES2017). */
/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any */
function buildPad(len: number, padString: string): string {
  let pad = '';
  while (pad.length < len) pad += padString;
  return pad.slice(0, len);
}
if (typeof (String.prototype as any).padStart !== 'function') {
  (String.prototype as any).padStart = function (targetLength: number, padString?: string) {
    targetLength = targetLength >> 0;
    const p = String(padString !== undefined ? padString : ' ');
    if (this.length >= targetLength || !p) return String(this);
    return buildPad(targetLength - this.length, p) + String(this);
  };
}
if (typeof (String.prototype as any).padEnd !== 'function') {
  (String.prototype as any).padEnd = function (targetLength: number, padString?: string) {
    targetLength = targetLength >> 0;
    const p = String(padString !== undefined ? padString : ' ');
    if (this.length >= targetLength || !p) return String(this);
    return String(this) + buildPad(targetLength - this.length, p);
  };
}
export {};
