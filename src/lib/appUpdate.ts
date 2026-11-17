import { BUILD_INFO } from '@/lib/buildInfo';
import { RUNNING_BUILD, fetchLiveBuild, isNewerBuild, type BuildStamp } from '@/lib/buildUpdate';
import { logFormEvent, type FunnelForm } from '@/lib/formFunnel';

/**
 * Moving a phone onto the newest build, so agents stop hitting bugs that are already fixed
 * (17 Nov: an iPhone still ran the renewal code from before f345f10095).
 *
 *   - Before a Post / Resubmit / Renew the chat asks findNewerBuild() (the same /build-info.json
 *     check as the "A new version of Welile is ready" banner). A newer build: the chat is kept
 *     (t4Resume.ts) and reloadToBuild() reloads; the new build reopens it and continues.
 *   - On start, a build more than 1 hour behind the live one reloads at once (startupUpdate).
 *   - Once the new build is running, 'app_updated' { from_build, to_build } goes to
 *     request_form_log (settleAppUpdate).
 *
 * A reload that brings back the same old build (a cached page) is not tried again for
 * RELOAD_RETRY_MS, so a phone can never loop.
 */

export const UPDATE_MARKER_KEY = 'welile_app_update';
/** On start, a build this far behind the live one reloads at once. */
export const STARTUP_MAX_LAG_MS = 60 * 60 * 1000;
/** After a reload for a build, the same build is not reloaded for again within this time. */
export const RELOAD_RETRY_MS = 10 * 60 * 1000;
/** The check before a send gives up after this (slow network: send on this build). */
export const UPDATE_CHECK_TIMEOUT_MS = 4000;
export const UPDATING_LINE = 'Updating Welile… your answers are kept';

export type UpdateReason = 'send' | 'startup';

export interface UpdateMarker {
  /** The build that reloaded, and the one it reloaded for ("source@builtAt"). */
  from: string;
  to: string;
  fromSource: string;
  toSource: string;
  at: number;
  reason: UpdateReason;
  /** For a send: the chat's funnel form and session, so the event joins that session. */
  form?: FunnelForm;
  session?: string;
}

/** "source@builtAt": the same build reads the same on every phone. */
export const buildLabel = (b: BuildStamp): string => `${b.source || 'unknown'}@${b.builtAt || 'unknown'}`;

/** How far the live build is ahead of this one (0 unless it is newer). */
export function buildLagMs(local: BuildStamp, remote: BuildStamp): number {
  if (!isNewerBuild(local, remote)) return 0;
  return Date.parse(remote.builtAt as string) - Date.parse(local.builtAt as string);
}

export function readUpdateMarker(): UpdateMarker | null {
  try {
    const m = JSON.parse(localStorage.getItem(UPDATE_MARKER_KEY) ?? 'null') as UpdateMarker | null;
    return m && typeof m === 'object' && typeof m.toSource === 'string' ? m : null;
  } catch {
    return null;
  }
}
const writeMarker = (m: UpdateMarker) => { try { localStorage.setItem(UPDATE_MARKER_KEY, JSON.stringify(m)); } catch { /* ignore */ } };
const clearMarker = () => { try { localStorage.removeItem(UPDATE_MARKER_KEY); } catch { /* ignore */ } };

/** This phone already reloaded for that build a moment ago and still runs the old one: don't loop. */
function alreadyTried(live: BuildStamp, now: number): boolean {
  const m = readUpdateMarker();
  return !!m && m.toSource === live.source && now - m.at < RELOAD_RETRY_MS;
}

export interface CheckDeps {
  running?: BuildStamp;
  fetchLive?: (signal?: AbortSignal) => Promise<BuildStamp | null>;
  timeoutMs?: number;
  now?: () => number;
  /** Tests only: run outside a production build. */
  anyMode?: boolean;
}

/**
 * The live build when it is newer than this one (and not already tried), else null. Production
 * builds only; never throws; gives up after UPDATE_CHECK_TIMEOUT_MS.
 */
export async function findNewerBuild(deps: CheckDeps = {}): Promise<BuildStamp | null> {
  if (!deps.anyMode && BUILD_INFO.mode !== 'production') return null;
  const running = deps.running ?? RUNNING_BUILD;
  const now = deps.now ?? Date.now;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => { ctrl?.abort(); resolve(null); }, deps.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS);
    });
    const live = await Promise.race([(deps.fetchLive ?? fetchLiveBuild)(ctrl?.signal), timeout]);
    if (!live || !isNewerBuild(running, live) || alreadyTried(live, now())) return null;
    return live;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Reloads the page. One place, so tests can replace it. */
export function reloadPage(): void {
  window.location.reload();
}

/** Notes what is being updated (for the log and the loop guard), then reloads. */
export function reloadToBuild(
  live: BuildStamp,
  info: { reason: UpdateReason; form?: FunnelForm; session?: string },
  deps: { running?: BuildStamp; now?: () => number; reload?: () => void } = {},
): void {
  const running = deps.running ?? RUNNING_BUILD;
  writeMarker({
    from: buildLabel(running), to: buildLabel(live), fromSource: running.source ?? 'unknown', toSource: live.source ?? 'unknown',
    at: (deps.now ?? Date.now)(), reason: info.reason, ...(info.form ? { form: info.form } : {}), ...(info.session ? { session: info.session } : {}),
  });
  (deps.reload ?? reloadPage)();
}

/**
 * On start: a build more than 1 hour behind the live one reloads at once. Returns true when it
 * reloads.
 */
export async function startupUpdate(deps: CheckDeps & { reload?: () => void } = {}): Promise<boolean> {
  const running = deps.running ?? RUNNING_BUILD;
  const live = await findNewerBuild(deps);
  if (!live || buildLagMs(running, live) <= STARTUP_MAX_LAG_MS) return false;
  reloadToBuild(live, { reason: 'startup' }, { running, now: deps.now, reload: deps.reload });
  return true;
}

/**
 * On start, after an update: logs 'app_updated' { from_build, to_build } once the new build runs,
 * and clears the note. A reload that brought back the old build keeps the note (the loop guard)
 * until RELOAD_RETRY_MS has passed. Returns what was logged.
 */
export function settleAppUpdate(deps: {
  running?: BuildStamp;
  now?: () => number;
  log?: typeof logFormEvent;
} = {}): { from_build: string; to_build: string; reason: UpdateReason } | null {
  const m = readUpdateMarker();
  if (!m) return null;
  const running = deps.running ?? RUNNING_BUILD;
  const now = (deps.now ?? Date.now)();
  if (!running.source || running.source === 'unknown' || running.source === m.fromSource) {
    if (now - m.at >= RELOAD_RETRY_MS) clearMarker();
    return null;
  }
  clearMarker();
  const meta = { from_build: m.from, to_build: buildLabel(running), reason: m.reason };
  (deps.log ?? logFormEvent)(m.form ?? 'agent_post', 'app_updated', meta, m.session ?? null);
  return meta;
}
