import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Smartphone, Tablet, Monitor, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MissionBanner, type MissionBannerData } from './MissionBanner';

/** Device breakpoints to preview the banner at. */
const DEVICES = [
  { key: 'mobile', label: 'Mobile', width: 390, icon: Smartphone },
  { key: 'tablet', label: 'Tablet', width: 768, icon: Tablet },
  { key: 'desktop', label: 'Desktop', width: 1024, icon: Monitor },
] as const;

/** Font-size scales applied (via CSS zoom) to preview text at different sizes. */
const FONT_SIZES = [
  { key: 'compact', label: 'Compact', scale: 0.9 },
  { key: 'default', label: 'Default', scale: 1 },
  { key: 'large', label: 'Large', scale: 1.15 },
] as const;

/**
 * Renders children inside a same-origin iframe at a fixed CSS width so that
 * Tailwind `sm:`/responsive breakpoints react to the iframe width rather than
 * the real viewport. App stylesheets and the dark-mode class are copied in.
 */
function BreakpointFrame({ width, children }: { width: number; children: React.ReactNode }) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(160);

  useEffect(() => {
    if (!frame) return;
    const doc = frame.contentDocument;
    if (!doc) return;

    // Copy stylesheets (dev <style> + prod <link>) into the iframe head.
    doc.head.innerHTML = '';
    document
      .querySelectorAll('style, link[rel="stylesheet"]')
      .forEach((node) => doc.head.appendChild(node.cloneNode(true)));

    // Mirror dark/light theme + base background.
    doc.documentElement.className = document.documentElement.className;
    doc.body.style.margin = '0';
    doc.body.style.background = 'transparent';
    setReady(true);

    // Auto-resize the iframe to its content height.
    const ro = new ResizeObserver(() => {
      setHeight(doc.body.scrollHeight || 160);
    });
    ro.observe(doc.body);
    return () => ro.disconnect();
  }, [frame]);

  const mountNode = ready ? frame?.contentDocument?.body : null;

  return (
    <iframe
      ref={setFrame}
      title="Mission banner preview"
      style={{ width, height, border: 0, maxWidth: '100%' }}
      className="block bg-transparent"
    >
      {mountNode && createPortal(children, mountNode)}
    </iframe>
  );
}

interface MissionBannerPreviewProps {
  dashboardRole: string;
  /** Draft mission data to preview; falls back to the saved mission when null. */
  missionOverride?: MissionBannerData | null;
  /**
   * Unique key (e.g. dashboard role + month) used to remember the chosen device
   * and font size per mission draft across sessions.
   */
  persistKey?: string;
}

type DeviceKey = (typeof DEVICES)[number]['key'];
type SizeKey = (typeof FONT_SIZES)[number]['key'];

const STORAGE_PREFIX = 'mission-preview-prefs:';

function loadPrefs(persistKey?: string): { device: DeviceKey; size: SizeKey } {
  const fallback = { device: 'mobile' as DeviceKey, size: 'default' as SizeKey };
  if (!persistKey || typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + persistKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<{ device: DeviceKey; size: SizeKey }>;
    return {
      device: DEVICES.some((d) => d.key === parsed.device) ? (parsed.device as DeviceKey) : fallback.device,
      size: FONT_SIZES.some((s) => s.key === parsed.size) ? (parsed.size as SizeKey) : fallback.size,
    };
  } catch {
    return fallback;
  }
}

/**
 * Interactive live preview of the mission banner with device-breakpoint and
 * font-size toggles, so the CEO can check readability before saving.
 */
export function MissionBannerPreview({ dashboardRole, missionOverride, persistKey }: MissionBannerPreviewProps) {
  const [device, setDevice] = useState<DeviceKey>(() => loadPrefs(persistKey).device);
  const [size, setSize] = useState<SizeKey>(() => loadPrefs(persistKey).size);

  // Re-load saved selections whenever the draft (persistKey) changes.
  useEffect(() => {
    const prefs = loadPrefs(persistKey);
    setDevice(prefs.device);
    setSize(prefs.size);
  }, [persistKey]);

  // Persist selections per draft.
  useEffect(() => {
    if (!persistKey || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_PREFIX + persistKey, JSON.stringify({ device, size }));
    } catch {
      /* ignore storage failures (private mode, quota) */
    }
  }, [persistKey, device, size]);

  const activeDevice = DEVICES.find((d) => d.key === device)!;
  const activeSize = FONT_SIZES.find((s) => s.key === size)!;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
          {DEVICES.map((d) => {
            const Icon = d.icon;
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => setDevice(d.key)}
                aria-pressed={device === d.key}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                  device === d.key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{d.label}</span>
              </button>
            );
          })}
        </div>

        <div className="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
          <Type className="ml-1.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {FONT_SIZES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSize(s.key)}
              aria-pressed={size === s.key}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors',
                size === s.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <span className="text-[11px] font-medium text-muted-foreground">
          {activeDevice.width}px · {Math.round(activeSize.scale * 100)}%
        </span>
      </div>

      <div className="flex justify-center overflow-auto rounded-xl border bg-muted/20 p-3 sm:p-4">
        <BreakpointFrame width={activeDevice.width}>
          {/* zoom scales font sizes (and layout) for the size toggle */}
          <div style={{ zoom: activeSize.scale, padding: 8 }}>
            <MissionBanner dashboardRole={dashboardRole} missionOverride={missionOverride} />
          </div>
        </BreakpointFrame>
      </div>
    </div>
  );
}