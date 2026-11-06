import { useCallback, useEffect, useState } from 'react';

/** Large is the default. People who find it too big can pick Medium or Small. */
export const RENT_REQUEST_CHAT_TEXT_SIZES = ['large', 'medium', 'small'] as const;
export type RentRequestChatTextSize = (typeof RENT_REQUEST_CHAT_TEXT_SIZES)[number];

const SHARED_KEY = 'welile.rent-request-chat.text-size';

export function rentRequestChatTextSizeStorageKey(userId?: string | null): string {
  return userId ? `${SHARED_KEY}:${userId}` : SHARED_KEY;
}

export function isRentRequestChatTextSize(value: unknown): value is RentRequestChatTextSize {
  return value === 'large' || value === 'medium' || value === 'small';
}

export function readRentRequestChatTextSize(userId?: string | null): RentRequestChatTextSize {
  if (typeof window === 'undefined') return 'large';
  try {
    const own = window.localStorage.getItem(rentRequestChatTextSizeStorageKey(userId));
    if (isRentRequestChatTextSize(own)) return own;
    if (userId) {
      const shared = window.localStorage.getItem(SHARED_KEY);
      if (isRentRequestChatTextSize(shared)) return shared;
    }
  } catch {
    /* private mode or a blocked storage read stays on Large */
  }
  return 'large';
}

export function writeRentRequestChatTextSize(size: RentRequestChatTextSize, userId?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(rentRequestChatTextSizeStorageKey(userId), size);
  } catch {
    /* quota or private mode: the choice still applies for this visit */
  }
}

export function useRentRequestChatTextSize(userId?: string | null) {
  const [size, setSize] = useState<RentRequestChatTextSize>(() => readRentRequestChatTextSize(userId));

  useEffect(() => {
    setSize(readRentRequestChatTextSize(userId));
  }, [userId]);

  const update = useCallback((next: RentRequestChatTextSize) => {
    setSize(next);
    writeRentRequestChatTextSize(next, userId);
  }, [userId]);

  return [size, update] as const;
}
