import "@testing-library/jest-dom";
import { vi } from "vitest";

// Browser shims only apply under jsdom; suites that opt into `@vitest-environment node` (e.g. the PGlite database
// tests) have no window.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });

  // jsdom doesn't implement these — silence noisy warnings during tests
  if (!("scrollTo" in window)) {
    // @ts-expect-error jsdom polyfill
    window.scrollTo = () => {};
  }
}

// Radix UI (Slider, etc.) relies on ResizeObserver, which jsdom lacks.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserver as unknown as typeof globalThis.ResizeObserver;
}

// Stub haptics so tests don't try to vibrate
vi.mock("@/lib/haptics", () => ({
  hapticTap: () => {},
  hapticSelection: () => {},
}));