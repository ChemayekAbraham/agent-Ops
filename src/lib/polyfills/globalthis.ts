/** globalThis (ES2020) — some deps reference it directly. */
/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof (window as any).globalThis === 'undefined') {
  (window as any).globalThis = window;
}
export {};
