/** Object.fromEntries (ES2019). */
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof (Object as any).fromEntries !== 'function') {
  (Object as any).fromEntries = function (entries: any) {
    const obj: any = {};
    // Works with arrays, Maps, and any iterable of [key, value] pairs.
    for (const pair of Array.from(entries as Iterable<any>)) {
      obj[pair[0]] = pair[1];
    }
    return obj;
  };
}
export {};
