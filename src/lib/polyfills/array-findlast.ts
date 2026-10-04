/** Array.prototype.findLast + findLastIndex (ES2023). */
/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any */
function findLast(this: any, pred: any, thisArg?: any) {
  const o = Object(this);
  const len = o.length >>> 0;
  for (let i = len - 1; i >= 0; i--) if (pred.call(thisArg, o[i], i, o)) return o[i];
  return undefined;
}
function findLastIndex(this: any, pred: any, thisArg?: any) {
  const o = Object(this);
  const len = o.length >>> 0;
  for (let i = len - 1; i >= 0; i--) if (pred.call(thisArg, o[i], i, o)) return i;
  return -1;
}
if (typeof (Array.prototype as any).findLast !== 'function') (Array.prototype as any).findLast = findLast;
if (typeof (Array.prototype as any).findLastIndex !== 'function') (Array.prototype as any).findLastIndex = findLastIndex;
export {};
