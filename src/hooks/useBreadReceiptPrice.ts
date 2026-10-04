import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export const WELILE_BREAD_PRICE = 6500;
export const WELILE_BREAD_DISCOUNT_RATE = 0.05;
export const WELILE_BREAD_MIN_PAYABLE = 500;
const DISCOUNT_RATE = WELILE_BREAD_DISCOUNT_RATE;
const MIN_PAYABLE = WELILE_BREAD_MIN_PAYABLE;
const RECEIPT_STORAGE_KEY = 'welile.bread.receipt.v1';
const RECEIPT_HISTORY_KEY = 'welile.bread.receipt.history.v1';
const MAX_HISTORY = 5;
export const BREAD_RECEIPT_EVENT = 'welile-bread-receipt-changed';
const BROADCAST_CHANNEL_NAME = 'welile-bread-price';
const REALTIME_CHANNEL_NAME = 'welile-bread-price-global';
const REALTIME_EVENT = 'bread-price-changed';

export function broadcastBreadPriceChange() {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(BREAD_RECEIPT_EVENT));
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      bc.postMessage({ type: 'changed', at: Date.now() });
      bc.close();
    }
    supabase
      .channel(REALTIME_CHANNEL_NAME)
      .send({ type: 'broadcast', event: REALTIME_EVENT, payload: { at: Date.now() } })
      .catch(() => {});
  } catch {
    /* noop */
  }
}

interface BreadReceipt {
  number: string;
  amount: number;
  savedAt: number;
}

export interface BreadReceiptHistoryEntry {
  number: string;
  amount: number;
  savedAt: number;
  credit: number;
  freeBreads: number;
  reducedPrice: number;
}

export interface BreadPriceState {
  basePrice: number;
  reducedPrice: number;
  freeBreads: number;
  hasReceipt: boolean;
  receiptAmount: number;
  savedAt: number | null;
}

function compute(): BreadPriceState {
  const base: BreadPriceState = {
    basePrice: WELILE_BREAD_PRICE,
    reducedPrice: WELILE_BREAD_PRICE,
    freeBreads: 0,
    hasReceipt: false,
    receiptAmount: 0,
    savedAt: null,
  };
  if (typeof window === 'undefined') return base;
  try {
    const raw = localStorage.getItem(RECEIPT_STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as BreadReceipt;
    if (!parsed?.amount || parsed.amount <= 0) return base;
    const credit = Math.round(parsed.amount * DISCOUNT_RATE);
    const freeBreads = Math.floor(credit / WELILE_BREAD_PRICE);
    const remainder = credit - freeBreads * WELILE_BREAD_PRICE;
    const nextDiscount = Math.min(remainder, Math.max(0, WELILE_BREAD_PRICE - MIN_PAYABLE));
    const reducedPrice = freeBreads > 0 ? 0 : Math.max(MIN_PAYABLE, WELILE_BREAD_PRICE - nextDiscount);
    return {
      basePrice: WELILE_BREAD_PRICE,
      reducedPrice,
      freeBreads,
      hasReceipt: true,
      receiptAmount: parsed.amount,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : null,
    };
  } catch {
    return base;
  }
}

export interface BreadPriceWithSync extends BreadPriceState {
  syncing: boolean;
}

export function useBreadReceiptPrice(): BreadPriceWithSync {
  const [state, setState] = useState<BreadPriceState>(() => compute());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let clearId: number | undefined;
    const refresh = () => {
      setSyncing(true);
      setState(compute());
      if (clearId) window.clearTimeout(clearId);
      clearId = window.setTimeout(() => setSyncing(false), 600);
    };
    window.addEventListener(BREAD_RECEIPT_EVENT, refresh);
    window.addEventListener('storage', refresh);
    let bc: BroadcastChannel | null = null;
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      bc.onmessage = refresh;
    }
    const channel = supabase
      .channel(REALTIME_CHANNEL_NAME)
      .on('broadcast', { event: REALTIME_EVENT }, refresh)
      .subscribe();
    return () => {
      window.removeEventListener(BREAD_RECEIPT_EVENT, refresh);
      window.removeEventListener('storage', refresh);
      if (bc) bc.close();
      supabase.removeChannel(channel);
      if (clearId) window.clearTimeout(clearId);
    };
  }, []);

  return { ...state, syncing };
}

function readHistory(): BreadReceiptHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECEIPT_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e) => e && typeof e.amount === 'number' && typeof e.savedAt === 'number',
    );
  } catch {
    return [];
  }
}

export function appendBreadReceiptHistory(receipt: { number: string; amount: number; savedAt: number }) {
  if (typeof window === 'undefined') return;
  const credit = Math.round(receipt.amount * DISCOUNT_RATE);
  const freeBreads = Math.floor(credit / WELILE_BREAD_PRICE);
  const remainder = credit - freeBreads * WELILE_BREAD_PRICE;
  const nextDiscount = Math.min(remainder, Math.max(0, WELILE_BREAD_PRICE - MIN_PAYABLE));
  const reducedPrice = freeBreads > 0 ? 0 : Math.max(MIN_PAYABLE, WELILE_BREAD_PRICE - nextDiscount);
  const entry: BreadReceiptHistoryEntry = {
    number: receipt.number,
    amount: receipt.amount,
    savedAt: receipt.savedAt,
    credit,
    freeBreads,
    reducedPrice,
  };
  const existing = readHistory();
  // De-duplicate by receipt number; newest first.
  const filtered = existing.filter((e) => e.number !== entry.number);
  const next = [entry, ...filtered].slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(RECEIPT_HISTORY_KEY, JSON.stringify(next));
    broadcastBreadPriceChange();
  } catch {
    /* noop */
  }
}

export function useBreadReceiptHistory(): BreadReceiptHistoryEntry[] {
  const [items, setItems] = useState<BreadReceiptHistoryEntry[]>(() => readHistory());
  useEffect(() => {
    const refresh = () => setItems(readHistory());
    window.addEventListener(BREAD_RECEIPT_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(BREAD_RECEIPT_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return items;
}