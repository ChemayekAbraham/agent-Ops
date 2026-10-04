/** Number.isNaN / isFinite / isInteger (ES2015 statics missing on ancient engines). */
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof (Number as any).isNaN !== 'function') {
  (Number as any).isNaN = function (v: any) { return typeof v === 'number' && v !== v; };
}
if (typeof (Number as any).isFinite !== 'function') {
  (Number as any).isFinite = function (v: any) { return typeof v === 'number' && isFinite(v); };
}
if (typeof (Number as any).isInteger !== 'function') {
  (Number as any).isInteger = function (v: any) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  };
}
export {};
