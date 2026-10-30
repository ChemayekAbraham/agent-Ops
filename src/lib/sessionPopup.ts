/**
 * One interruption dialog per browser tab session.
 *
 * Concerns, email collection and the budget reminder for budget-workflow
 * roles used to open together and cover Partner Ops. The highest-priority
 * dialog that is actually ready claims the session. Dismissing it — Escape
 * and click-outside both arrive as a close — consumes the slot until the
 * tab session ends. A budget banner does not use this slot.
 */

export type SessionPopupId = 'concerns' | 'email' | 'budget';
export type SessionPopupPhase = 'unknown' | 'idle' | 'ready';

const PRIORITY: SessionPopupId[] = ['concerns', 'email', 'budget'];
const STORAGE_KEY = 'welile.sessionPopup.slot';

/** How long a lower-priority dialog waits for a higher one that has not mounted. */
export const SESSION_POPUP_HOLD_MS = 500;

type SlotState = { phase: SessionPopupPhase };

const slots = new Map<SessionPopupId, SlotState>();
const listeners = new Set<() => void>();
let memorySlot: string | null = null;
let holdAnchor: number | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let nowFn = () => Date.now();

function readSlot(): string | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw == null) {
      memorySlot = null;
      return null;
    }
    memorySlot = raw;
    return raw;
  } catch {
    return memorySlot;
  }
}

function writeSlot(value: string) {
  memorySlot = value;
  try {
    sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* in-memory mirror covers private mode */
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

function higherPriorityMissingWhileLowerReady(): boolean {
  return PRIORITY.some((id, index) => {
    if (slots.has(id)) return false;
    return PRIORITY.slice(index + 1).some((lower) => slots.get(lower)?.phase === 'ready');
  });
}

function noteHold() {
  if (!higherPriorityMissingWhileLowerReady()) {
    holdAnchor = null;
    return;
  }
  if (holdAnchor == null) holdAnchor = nowFn();
  if (holdTimer) return;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    emit();
  }, SESSION_POPUP_HOLD_MS);
}

export function registerSessionPopup(id: SessionPopupId, phase: SessionPopupPhase) {
  slots.set(id, { phase });
  noteHold();
  emit();
}

export function unregisterSessionPopup(id: SessionPopupId) {
  slots.delete(id);
  noteHold();
  emit();
}

/** The single dialog allowed to open, or null when none should. */
export function activeSessionPopup(): SessionPopupId | null {
  if (readSlot() === 'dismissed') return null;
  const claimed = readSlot();
  if (claimed && claimed !== 'dismissed' && (PRIORITY as string[]).includes(claimed)) {
    const id = claimed as SessionPopupId;
    return slots.get(id)?.phase === 'ready' ? id : null;
  }

  const now = nowFn();
  for (let i = 0; i < PRIORITY.length; i++) {
    const id = PRIORITY[i];
    const slot = slots.get(id);
    if (!slot) {
      const lowerReady = PRIORITY.slice(i + 1).some((lower) => slots.get(lower)?.phase === 'ready');
      if (lowerReady && holdAnchor != null && now - holdAnchor < SESSION_POPUP_HOLD_MS) return null;
      continue;
    }
    if (slot.phase === 'unknown') return null;
    if (slot.phase === 'ready') return id;
  }
  return null;
}

export function claimSessionPopup(id: SessionPopupId) {
  if (readSlot() === 'dismissed') return;
  if (!readSlot()) writeSlot(id);
}

export function dismissSessionPopup() {
  writeSlot('dismissed');
  emit();
}

export function subscribeSessionPopup(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSessionPopupClockForTests(fn: () => number) {
  nowFn = fn;
}

export function resetSessionPopupForTests() {
  slots.clear();
  listeners.clear();
  memorySlot = null;
  holdAnchor = null;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  nowFn = () => Date.now();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
