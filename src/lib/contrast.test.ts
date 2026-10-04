import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseColor,
  relativeLuminance,
  contrastRatio,
  getReadableTextColor,
  meetsContrast,
  assertReadableContrast,
  READABLE_LIGHT,
  READABLE_DARK,
  AA_NORMAL,
  AA_LARGE,
} from "./contrast";

describe("parseColor", () => {
  it("parses 6-digit hex", () => {
    expect(parseColor("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#0f172a")).toEqual({ r: 15, g: 23, b: 42 });
    expect(parseColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("parses 3-digit hex shorthand", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("parses hsl with comma separator", () => {
    const rgb = parseColor("hsl(150, 60%, 16%)");
    expect(rgb).not.toBeNull();
    expect(rgb!.r).toBeCloseTo(16, 0);
    expect(rgb!.g).toBeCloseTo(65, 0);
    expect(rgb!.b).toBeCloseTo(41, 0);
  });

  it("parses hsl with space separator", () => {
    const rgb = parseColor("hsl(150 60% 16%)");
    expect(rgb).not.toBeNull();
    expect(rgb!.r).toBeCloseTo(16, 0);
    expect(rgb!.g).toBeCloseTo(65, 0);
    expect(rgb!.b).toBeCloseTo(41, 0);
  });

  it("returns null for invalid strings", () => {
    expect(parseColor("")).toBeNull();
    expect(parseColor("rgb(255,0,0)")).toBeNull();
    expect(parseColor("#gggggg")).toBeNull();
    expect(parseColor("#12")).toBeNull();
  });

  it("returns null for null/undefined-like input", () => {
    expect(parseColor("")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("is 1 for pure white", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBe(1);
  });

  it("is 0 for pure black", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
  });

  it("matches known WCAG reference red", () => {
    expect(relativeLuminance({ r: 255, g: 0, b: 0 })).toBeCloseTo(0.2126, 4);
  });

  it("matches known WCAG reference green", () => {
    expect(relativeLuminance({ r: 0, g: 255, b: 0 })).toBeCloseTo(0.7152, 4);
  });

  it("matches known WCAG reference blue", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 255 })).toBeCloseTo(0.0722, 4);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black vs white", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBe(21);
  });

  it("is 1:1 for identical colours", () => {
    const grey = { r: 128, g: 128, b: 128 };
    expect(contrastRatio(grey, grey)).toBe(1);
  });

  it("is symmetric", () => {
    const a = { r: 100, g: 50, b: 200 };
    const b = { r: 200, g: 100, b: 50 };
    expect(contrastRatio(a, b)).toBe(contrastRatio(b, a));
  });

  it("exceeds AA_NORMAL for black on white", () => {
    expect(
      contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe("getReadableTextColor", () => {
  it("returns white on dark backgrounds", () => {
    expect(getReadableTextColor("#000000")).toBe(READABLE_LIGHT);
    expect(getReadableTextColor("#0f172a")).toBe(READABLE_LIGHT);
    expect(getReadableTextColor("hsl(150 60% 16%)")).toBe(READABLE_LIGHT);
  });

  it("returns dark on light backgrounds", () => {
    expect(getReadableTextColor("#ffffff")).toBe(READABLE_DARK);
    expect(getReadableTextColor("#f0f9ff")).toBe(READABLE_DARK);
    expect(getReadableTextColor("#e2e8f0")).toBe(READABLE_DARK);
  });

  it("falls back to white for unparsable input", () => {
    expect(getReadableTextColor("")).toBe(READABLE_LIGHT);
    expect(getReadableTextColor("banana")).toBe(READABLE_LIGHT);
  });

  it("always meets WCAG AA against the background it was chosen for", () => {
    const backgrounds = [
      "#000000",
      "#ffffff",
      "#0f172a",
      "#e2e8f0",
      "#ef4444",
      "#22c55e",
      "#3b82f6",
      "#f59e0b",
      "hsl(150 60% 16%)",
      "hsl(200 80% 90%)",
      "#991b1b",
      "#1e3a8a",
    ];

    for (const bg of backgrounds) {
      const fg = getReadableTextColor(bg);
      const ratio = contrastRatio(parseColor(fg)!, parseColor(bg)!);
      expect(ratio, `contrast for ${fg} on ${bg}`).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it("corrects the low-contrast case that caused the original bug (white-on-near-white)", () => {
    const nearWhiteBg = "#fafafa";
    const chosen = getReadableTextColor(nearWhiteBg);
    expect(chosen).toBe(READABLE_DARK);
    const ratio = contrastRatio(parseColor(chosen)!, parseColor(nearWhiteBg)!);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("selects white for mid-dark backgrounds even if the margin is thin", () => {
    // #4a4a4a is a grey where both white and dark are close;
    // white should still win by a small margin.
    const bg = "#4a4a4a";
    const chosen = getReadableTextColor(bg);
    const ratio = contrastRatio(parseColor(chosen)!, parseColor(bg)!);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe("meetsContrast", () => {
  it("passes for black on white at normal threshold", () => {
    expect(meetsContrast("#000000", "#ffffff", AA_NORMAL)).toBe(true);
  });

  it("fails for medium-grey on light-grey at normal threshold", () => {
    expect(meetsContrast("#999999", "#cccccc", AA_NORMAL)).toBe(false);
  });

  it("passes at large-text threshold for a pair between 3:1 and 4.5:1", () => {
    // #333333 on #888888 ≈ 3.75:1 (passes 3:1, fails 4.5:1)
    expect(meetsContrast("#333333", "#888888", AA_LARGE)).toBe(true);
    expect(meetsContrast("#333333", "#888888", AA_NORMAL)).toBe(false);
  });

  it("returns true when colours are unparsable (fail-open)", () => {
    expect(meetsContrast("bad", "#ffffff")).toBe(true);
    expect(meetsContrast("#ffffff", "")).toBe(true);
  });

  it("uses AA_NORMAL as default threshold", () => {
    // #777 on #fff is ~4.47, just under 4.5
    expect(meetsContrast("#777777", "#ffffff")).toBe(false);
    // #666 on #fff is ~5.74, passes
    expect(meetsContrast("#666666", "#ffffff")).toBe(true);
  });
});

describe("assertReadableContrast", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns in development for low-contrast pairs", () => {
    assertReadableContrast("#cccccc", "#dddddd", "test-panel", AA_NORMAL, false);
    expect(warnSpy).toHaveBeenCalledOnce();
    const call = warnSpy.mock.calls[0] as [string];
    expect(call[0]).toContain("Low contrast");
    expect(call[0]).toContain("test-panel");
  });

  it("does not warn for high-contrast pairs", () => {
    assertReadableContrast("#000000", "#ffffff", "ok-panel", AA_NORMAL, false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("no-ops in production", () => {
    assertReadableContrast("#cccccc", "#dddddd", "prod-panel", AA_NORMAL, true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("no-ops for unparsable colours", () => {
    assertReadableContrast("bad", "#ffffff", "unparsable-panel", AA_NORMAL, false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("low-contrast regression suite", () => {
  it("guarantees correction for every problematic banner background", () => {
    const bannerBackgrounds = [
      "#0f172a",
      "#064e3b",
      "#14532d",
      "#7c2d12",
      "#fef3c7",
      "#ffffff",
      "#f8fafc",
      "hsl(150 60% 16%)",
      "hsl(22 80% 30%)",
      "#991b1b",
      "#1e3a8a",
      "#eab308",
    ];

    for (const bg of bannerBackgrounds) {
      const chosen = getReadableTextColor(bg);
      const bgRgb = parseColor(bg);
      const fgRgb = parseColor(chosen);
      expect(bgRgb, `background ${bg} should parse`).not.toBeNull();
      expect(fgRgb, `chosen text ${chosen} should parse`).not.toBeNull();

      const ratio = contrastRatio(fgRgb!, bgRgb!);
      expect(
        ratio,
        `${chosen} on ${bg} = ${ratio.toFixed(2)}:1 (needs ≥${AA_NORMAL}:1)`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});
