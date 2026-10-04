import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'recently_viewed_products';
const MAX_ITEMS = 10;

interface RecentlyViewedItem {
  productId: string;
  viewedAt: number;
}

export function useRecentlyViewed() {
  const [recentIds, setRecentIds] = useState<string[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const items: RecentlyViewedItem[] = JSON.parse(stored);
        // Sort by most recent first
        items.sort((a, b) => b.viewedAt - a.viewedAt);
        setRecentIds(items.map(item => item.productId));
      }
    } catch (error) {
      console.error('Error loading recently viewed:', error);
    }
  }, []);

  const addToRecentlyViewed = useCallback((productId: string) => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      let items: RecentlyViewedItem[] = stored ? JSON.parse(stored) : [];
      
      // Remove if already exists
      items = items.filter(item => item.productId !== productId);
      
      // Add to beginning
      items.unshift({ productId, viewedAt: Date.now() });
      
      // Keep only MAX_ITEMS
      items = items.slice(0, MAX_ITEMS);
      
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      setRecentIds(items.map(item => item.productId));
    } catch (error) {
      console.error('Error saving recently viewed:', error);
    }
  }, []);

  const clearRecentlyViewed = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      setRecentIds([]);
    } catch (error) {
      console.error('Error clearing recently viewed:', error);
    }
  }, []);

  return {
    recentIds,
    addToRecentlyViewed,
    clearRecentlyViewed,
  };
}
