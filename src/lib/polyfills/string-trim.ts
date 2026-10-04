/** String.prototype.trimStart + trimEnd (ES2019). */
/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any */
if (typeof (String.prototype as any).trimStart !== 'function') {
  (String.prototype as any).trimStart = function () {
    return this.replace(/^[\s\uFEFF\xA0]+/, '');
  };
}
if (typeof (String.prototype as any).trimEnd !== 'function') {
  (String.prototype as any).trimEnd = function () {
    return this.replace(/[\s\uFEFF\xA0]+$/, '');
  };
}
export {};
