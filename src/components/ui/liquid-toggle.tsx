"use client";

import React from 'react';
import { cn } from '@/lib/utils';

const variantColors = {
  default: 'bg-blue-600',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
};

interface ToggleProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

export function Toggle({
  checked = false,
  onCheckedChange,
  className,
  variant = 'default',
}: ToggleProps) {
  const [isChecked, setIsChecked] = React.useState(checked);

  React.useEffect(() => {
    setIsChecked(checked);
  }, [checked]);

  const handleClick = () => {
    const next = !isChecked;
    setIsChecked(next);
    onCheckedChange?.(next);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isChecked}
      onClick={handleClick}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/40',
        isChecked ? variantColors[variant] : 'bg-gray-200 dark:bg-gray-700',
        className,
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-in-out',
          isChecked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/** No-op — kept for backward compat so existing code doesn't break. */
export function GooeyFilter() {
  return null;
}

/** @deprecated Use Toggle instead */
export { Toggle as LiquidToggle };
