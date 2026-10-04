/** structuredClone (ES2022) — recursive fallback for common structured types. */
/* eslint-disable @typescript-eslint/no-explicit-any */
const G: any =
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : (self as any);

if (typeof G.structuredClone !== 'function') {
  const clone = (val: any, seen: WeakMap<any, any>): any => {
    if (val === null || typeof val !== 'object') return val;
    if (seen.has(val)) return seen.get(val);
    if (val instanceof Date) return new Date(val.getTime());
    if (val instanceof RegExp) return new RegExp(val.source, val.flags);
    if (Array.isArray(val)) {
      const arr: any[] = [];
      seen.set(val, arr);
      for (let i = 0; i < val.length; i++) arr[i] = clone(val[i], seen);
      return arr;
    }
    if (typeof Map !== 'undefined' && val instanceof Map) {
      const m = new Map();
      seen.set(val, m);
      val.forEach((v: any, k: any) => m.set(clone(k, seen), clone(v, seen)));
      return m;
    }
    if (typeof Set !== 'undefined' && val instanceof Set) {
      const s = new Set();
      seen.set(val, s);
      val.forEach((v: any) => s.add(clone(v, seen)));
      return s;
    }
    const out: any = {};
    seen.set(val, out);
    for (const key of Object.keys(val)) out[key] = clone(val[key], seen);
    return out;
  };
  G.structuredClone = function (val: any) {
    return clone(val, new WeakMap());
  };
}
export {};
