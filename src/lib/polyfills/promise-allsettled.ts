/** Promise.allSettled (ES2020). */
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof (Promise as any).allSettled !== 'function') {
  (Promise as any).allSettled = function (promises: any[]) {
    return Promise.all(
      Array.from(promises).map((p) =>
        Promise.resolve(p).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }),
        ),
      ),
    );
  };
}
export {};
