/** Promise.any (ES2021). */
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof (Promise as any).any !== 'function') {
  (Promise as any).any = function (promises: any[]) {
    return new Promise((resolve, reject) => {
      const arr = Array.from(promises);
      let rejections = 0;
      const errors: any[] = [];
      if (arr.length === 0) reject(new Error('All promises were rejected'));
      arr.forEach((p, i) => {
        Promise.resolve(p).then(resolve, (err) => {
          errors[i] = err;
          rejections += 1;
          if (rejections === arr.length) reject(new Error('All promises were rejected'));
        });
      });
    });
  };
}
export {};
