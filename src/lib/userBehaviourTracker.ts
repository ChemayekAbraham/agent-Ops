/**
 * User Behaviour Telemetry Tracker
 * 
 * Batched, low-bandwidth, non-blocking telemetry engine for Welile.
 * Collects user journeys, section views, taps, dialog interactions, and GPS/IP
 * across Tenant, Supporter, Agent, and Landlord dashboards.
 * 
 * Flushes to database via `ingest_user_telemetry_batch` RPC in throttled batches.
 */

import { supabase } from '@/integrations/supabase/client';
import { parseUserAgent } from './uaParser';

export interface TelemetryPayload {
  id?: string;
  session_id: string;
  role: string;
  event_type: 'tap' | 'page_view' | 'tab_switch' | 'dialog_open' | 'dialog_action' | 'dwell_time';
  path?: string;
  section?: string;
  target?: string;
  kind?: string;
  dialog_name?: string;
  dwell_time_ms?: number;
  metadata?: Record<string, any>;
  latitude?: number | null;
  longitude?: number | null;
  device_class?: string;
  user_agent?: string;
  created_at?: string;
}

const FLUSH_INTERVAL_MS = 45_000;
const MAX_QUEUE_SIZE = 25;
const SESSION_STORAGE_KEY = 'welile_telemetry_session_id';

class UserBehaviourTracker {
  private queue: TelemetryPayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentRole: string = 'visitor';
  private currentSection: string = 'home';
  private sectionStartTime: number = Date.now();
  private isInitialized = false;
  private lastTapTimestamp = 0;
  private lastTapKey = '';
  private cachedGps: { lat: number; lng: number; expiresAt: number } | null = null;

  /** Stable session ID per browser tab session */
  private getSessionId(): string {
    if (typeof window === 'undefined') return 'server-session';
    try {
      let id = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(SESSION_STORAGE_KEY, id);
      }
      return id;
    } catch {
      return 'fallback-session-' + Date.now();
    }
  }

  /** Detect device class on the fly with UA and viewport checks */
  private getDeviceClass(): string {
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      const parsed = parseUserAgent(navigator.userAgent);
      if (parsed.deviceClass) return parsed.deviceClass;
    }
    if (typeof window === 'undefined') return 'desktop';
    const w = window.innerWidth;
    if (w < 768) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  /**
   * Silently gets coordinates ONLY if the user has ALREADY granted permission.
   * Never triggers a permission dialog.
   */
  private async getSilentGps(): Promise<{ lat: number; lng: number } | null> {
    if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.permissions) {
      return null;
    }

    if (this.cachedGps && Date.now() < this.cachedGps.expiresAt) {
      return { lat: this.cachedGps.lat, lng: this.cachedGps.lng };
    }

    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' });
      if (permission.state === 'granted') {
        return new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const coords = {
                lat: Number(pos.coords.latitude.toFixed(6)),
                lng: Number(pos.coords.longitude.toFixed(6)),
              };
              this.cachedGps = { ...coords, expiresAt: Date.now() + 5 * 60 * 1000 };
              resolve(coords);
            },
            () => resolve(null),
            { maximumAge: 120_000, timeout: 3_000 }
          );
        });
      }
    } catch {
      // Permission API not supported or failed
    }

    return null;
  }

  /** Initialize the tracker and lifecycle listeners */
  public init() {
    if (this.isInitialized || typeof window === 'undefined') return;
    this.isInitialized = true;

    // Periodic flush timer
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);

    // Lifecycle exits (tab closed, tab hidden, navigation)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.trackSectionDwell();
        void this.flush();
      }
    });

    window.addEventListener('pagehide', () => {
      this.trackSectionDwell();
      void this.flush();
    });

    this.bindGlobalClickListener();
  }

  /** Set active user role (e.g. from AuthContext or active dashboard) */
  public setRole(role: string | null | undefined) {
    if (role && role !== this.currentRole) {
      this.currentRole = role;
    }
  }

  /** Record navigating into a new section / screen */
  public setSection(section: string, role?: string) {
    if (role) this.setRole(role);
    if (this.currentSection === section) return;

    // Record dwell time for old section
    this.trackSectionDwell();

    this.currentSection = section;
    this.sectionStartTime = Date.now();

    this.trackEvent({
      event_type: 'page_view',
      section,
      path: window.location.pathname,
    });
  }

  private trackSectionDwell() {
    const elapsed = Date.now() - this.sectionStartTime;
    if (elapsed > 1000 && elapsed < 1800000) { // between 1s and 30m
      this.trackEvent({
        event_type: 'dwell_time',
        section: this.currentSection,
        dwell_time_ms: elapsed,
        path: window.location.pathname,
      });
    }
    this.sectionStartTime = Date.now();
  }

  /** Check if current path belongs to internal executive/admin tooling */
  private isAdminPath(pathname: string): boolean {
    const p = pathname.toLowerCase();
    return (
      p.startsWith('/cfo') ||
      p.startsWith('/executive') ||
      p.startsWith('/admin') ||
      p.startsWith('/crm') ||
      p.startsWith('/cto') ||
      p.startsWith('/agent-ops') ||
      p.startsWith('/tenant-ops') ||
      p.startsWith('/landlord-ops') ||
      p.startsWith('/partners-ops') ||
      p.startsWith('/fin-ops') ||
      p.includes('cfo-dashboard')
    );
  }

  /** Infer active role dynamically from explicit role or route pathname */
  private getEffectiveRole(overrideRole?: string): string {
    if (overrideRole && overrideRole !== 'visitor') return overrideRole;
    if (typeof window !== 'undefined') {
      const p = window.location.pathname.toLowerCase();
      if (p.includes('/dashboard/agent') || p === '/agent' || p.startsWith('/agent/')) return 'agent';
      if (p.includes('/dashboard/funder') || p.includes('/supporter') || p.includes('/funder')) return 'supporter';
      if (p.includes('/dashboard/tenant') || p === '/tenant' || p.startsWith('/tenant/')) return 'tenant';
      if (p.includes('/dashboard/landlord') || p === '/landlord' || p.startsWith('/landlord/')) return 'landlord';
    }
    if (this.currentRole && this.currentRole !== 'visitor') return this.currentRole;
    return 'visitor';
  }

  /** Queue a telemetry event */
  public trackEvent(event: Omit<TelemetryPayload, 'session_id' | 'role'> & { role?: string }) {
    if (typeof window !== 'undefined' && this.isAdminPath(window.location.pathname)) {
      return; // Do not record user journeys on internal admin/staff tooling
    }

    void (async () => {
      const gps = await this.getSilentGps();

      const item: TelemetryPayload = {
        id: crypto.randomUUID(),
        session_id: this.getSessionId(),
        role: this.getEffectiveRole(event.role),
        path: window.location.pathname,
        section: event.section || this.currentSection,
        device_class: this.getDeviceClass(),
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        latitude: gps?.lat ?? null,
        longitude: gps?.lng ?? null,
        created_at: new Date().toISOString(),
        ...event,
      };

      this.queue.push(item);

      if (this.queue.length >= MAX_QUEUE_SIZE) {
        void this.flush();
      }
    })();
  }

  /** Send batched queue to database */
  public async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = [...this.queue];
    this.queue = [];

    try {
      // Ingest via idempotent SECURITY DEFINER RPC
      const { error } = await supabase.rpc('ingest_user_telemetry_batch' as any, {
        p_events: batch as any,
      });

      if (error) {
        // If RPC isn't deployed yet or network failed, fail silently
        if (import.meta.env.DEV) {
          console.debug('[UserBehaviourTracker] Telemetry drop (silent):', error.message);
        }
      }
    } catch (err) {
      // Telemetry must never crash the app
    }
  }

  /** Automatically capture clicks and taps on the fly */
  private bindGlobalClickListener() {
    document.addEventListener(
      'click',
      (event) => {
        const targetEl = (event.target as HTMLElement)?.closest(
          'button, a, [role="button"], [role="tab"], input[type="submit"]'
        ) as HTMLElement | null;

        if (!targetEl) return;

        // Extract label
        const customTrack = targetEl.getAttribute('data-track');
        const customTarget = targetEl.getAttribute('data-track-target');
        const customSection = targetEl.getAttribute('data-track-section');
        const ariaLabel = targetEl.getAttribute('aria-label');
        const innerText = targetEl.innerText?.trim().replace(/\s+/g, ' ').slice(0, 50);
        const elementId = targetEl.id;

        const label = customTarget || customTrack || ariaLabel || innerText || elementId || targetEl.tagName.toLowerCase();
        if (!label) return;

        // Double-tap debounce check (350ms on same element)
        const tapKey = `${label}:${this.currentSection}`;
        const now = Date.now();
        if (tapKey === this.lastTapKey && now - this.lastTapTimestamp < 350) {
          return;
        }
        this.lastTapKey = tapKey;
        this.lastTapTimestamp = now;

        // Detect if clicked inside a dialog / modal / drawer
        const dialogEl = targetEl.closest('[role="dialog"]');
        let dialogName: string | undefined = undefined;
        let eventType: TelemetryPayload['event_type'] = 'tap';

        if (dialogEl) {
          const titleEl = dialogEl.querySelector('h1, h2, h3, [id*="title"], [data-dialog-title]');
          dialogName = titleEl?.textContent?.trim().slice(0, 60) || 'Active Dialog';
          eventType = 'dialog_action';
        }

        const roleAttr = targetEl.getAttribute('role');
        const kind = roleAttr || targetEl.tagName.toLowerCase();
        if (roleAttr === 'tab') {
          eventType = 'tab_switch';
        }

        this.trackEvent({
          event_type: eventType,
          section: customSection || this.currentSection,
          target: label,
          kind,
          dialog_name: dialogName,
          metadata: {
            href: targetEl.getAttribute('href') || undefined,
          },
        });
      },
      { passive: true }
    );
  }
}

export const userBehaviourTracker = new UserBehaviourTracker();
