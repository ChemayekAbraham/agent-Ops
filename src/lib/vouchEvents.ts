/**
 * Lightweight cross-component bus for "a collection just landed, refresh
 * any vouch / trust UI that's mounted". Avoids prop-drilling and works
 * across the dashboard, profile pages, and lender panel without coupling.
 */
export const VOUCH_UPDATED_EVENT = 'welile:vouch:updated';

export interface VouchUpdatedDetail {
  agentId?: string;
  aiId?: string;
  collectionId?: string;
  deltaUgx?: number;
}

export function emitVouchUpdated(detail: VouchUpdatedDetail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<VouchUpdatedDetail>(VOUCH_UPDATED_EVENT, { detail }));
}

export function onVouchUpdated(handler: (detail: VouchUpdatedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<VouchUpdatedDetail>).detail || {});
  window.addEventListener(VOUCH_UPDATED_EVENT, listener);
  return () => window.removeEventListener(VOUCH_UPDATED_EVENT, listener);
}