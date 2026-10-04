import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  getReadableTextColor,
  assertReadableContrast,
  AA_NORMAL,
  AA_LARGE,
} from '@/lib/contrast';

interface ContrastPanelProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'> {
  /** Solid background colour (hex or hsl). Text colour is auto-derived. */
  background: string;
  /** Override the auto text colour (still contrast-checked in dev). */
  textColor?: string;
  /** Render as a different element (e.g. 'button'). */
  as?: React.ElementType;
  /** Use large-text WCAG threshold (3:1) instead of 4.5:1. */
  largeText?: boolean;
  /** Label used in dev contrast warnings. */
  label?: string;
}

/**
 * A panel/card surface that guarantees readable text by deriving the
 * foreground colour from its solid background via WCAG luminance.
 *
 * Use this for promo banners and card panels so buttons and labels can
 * never collapse into a low-contrast "whitish" state again.
 */
export const ContrastPanel = React.forwardRef<HTMLElement, ContrastPanelProps>(
  (
    {
      background,
      textColor,
      as: Component = 'div',
      largeText = false,
      label = 'ContrastPanel',
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const color = textColor ?? getReadableTextColor(background);

    if (import.meta.env?.DEV) {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      React.useEffect(() => {
        assertReadableContrast(
          color,
          background,
          label,
          largeText ? AA_LARGE : AA_NORMAL,
        );
      }, [color, background, label, largeText]);
    }

    return (
      <Component
        ref={ref}
        className={cn(className)}
        style={{ background, color, ...style }}
        {...props}
      >
        {children}
      </Component>
    );
  },
);
ContrastPanel.displayName = 'ContrastPanel';