/** Object.entries + Object.values (ES2017). */
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof (Object as any).values !== 'function') {
  (Object as any).values = function (obj: any) {
    return Object.keys(obj).map((k) => obj[k]);
  };
}
if (typeof (Object as any).entries !== 'function') {
  (Object as any).entries = function (obj: any) {
    return Object.keys(obj).map((k) => [k, obj[k]]);
  };
}
export {};
