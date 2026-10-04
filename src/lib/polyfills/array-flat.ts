/** Array.prototype.flat + flatMap (ES2019). */
/* eslint-disable no-extend-native, @typescript-eslint/no-explicit-any */
if (typeof (Array.prototype as any).flat !== 'function') {
  (Array.prototype as any).flat = function (depth = 1) {
    const flatten = (arr: any[], d: number): any[] =>
      d < 1
        ? arr.slice()
        : arr.reduce(
            (acc: any[], v: any) => acc.concat(Array.isArray(v) ? flatten(v, d - 1) : v),
            [],
          );
    return flatten(this, depth);
  };
}
if (typeof (Array.prototype as any).flatMap !== 'function') {
  (Array.prototype as any).flatMap = function (cb: any, thisArg: any) {
    return this.map((v: any, i: number, a: any[]) => cb.call(thisArg, v, i, a)).flat();
  };
}
export {};
