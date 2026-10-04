/** Array.prototype.includes (ES2016). */
/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any */
if (typeof (Array.prototype as any).includes !== 'function') {
  (Array.prototype as any).includes = function (search: any, fromIndex?: number) {
    const o = Object(this);
    const len = o.length >>> 0;
    if (len === 0) return false;
    let k = fromIndex ? fromIndex | 0 : 0;
    if (k < 0) k = Math.max(len + k, 0);
    const sameValueZero = (x: any, y: any) =>
      x === y || (typeof x === 'number' && typeof y === 'number' && x !== x && y !== y);
    for (; k < len; k++) if (sameValueZero(o[k], search)) return true;
    return false;
  };
}
export {};
