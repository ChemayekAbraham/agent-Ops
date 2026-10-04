/** Object.hasOwn (ES2022). */
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof (Object as any).hasOwn !== 'function') {
  (Object as any).hasOwn = function (obj: any, prop: PropertyKey) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  };
}
export {};
