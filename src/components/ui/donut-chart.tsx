import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

export interface DonutChartSegment {
  value: number;
  /** Any valid CSS colour, e.g. hsl(var(--primary)). */
  color: string;
  label: string;
}

interface DonutChartProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  data: DonutChartSegment[];
  /** Defaults to the sum of the segments. */
  totalValue?: number;
  size?: number;
  strokeWidth?: number;
  animationDuration?: number;
  animationDelayPerSegment?: number;
  highlightOnHover?: boolean;
  centerContent?: React.ReactNode;
  /** Controlled highlight (e.g. a legend row being hovered). Leave undefined to let the chart manage it. */
  activeLabel?: string | null;
  /** Called with the hovered segment, or null when the pointer leaves. */
  onSegmentHover?: (segment: DonutChartSegment | null) => void;
}

/** Gap between neighbouring segments, in px along the ring. */
const SEGMENT_GAP = 3;

const DonutChart = React.forwardRef<HTMLDivElement, DonutChartProps>(
  (
    {
      data,
      totalValue,
      size = 200,
      strokeWidth = 20,
      animationDuration = 1,
      animationDelayPerSegment = 0.05,
      highlightOnHover = true,
      centerContent,
      activeLabel,
      onSegmentHover,
      className,
      ...props
    },
    ref,
  ) => {
    const reduceMotion = useReducedMotion();
    const [internalActive, setInternalActive] = React.useState<string | null>(null);
    const active = activeLabel !== undefined ? activeLabel : internalActive;

    const total = totalValue || data.reduce((sum, s) => sum + s.value, 0);
    const radius = size / 2 - strokeWidth / 2;
    const circumference = 2 * Math.PI * radius;

    // Where each segment starts along the ring, computed up front (not mutated while rendering).
    const segments = React.useMemo(() => {
      let start = 0;
      return data
        .filter((s) => s.value > 0)
        .map((s) => {
          const length = total === 0 ? 0 : (s.value / total) * circumference;
          const seg = { ...s, start, length };
          start += length;
          return seg;
        });
    }, [data, total, circumference]);

    const hover = (segment: DonutChartSegment | null) => {
      setInternalActive(segment?.label ?? null);
      onSegmentHover?.(segment);
    };

    return (
      <div
        ref={ref}
        className={cn('relative flex items-center justify-center', className)}
        style={{ width: size, height: size }}
        onMouseLeave={() => hover(null)}
        {...props}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="overflow-visible -rotate-90" // start at 12 o'clock
          role="img"
          aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}
        >
          {/* Track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="hsl(var(--border) / 0.5)"
            strokeWidth={strokeWidth}
          />

          {segments.map((segment, index) => {
            const isActive = active === segment.label;
            const dimmed = active != null && !isActive;
            // Leave a small gap, but never let a tiny segment vanish.
            const visible = Math.max(Math.min(segment.length, 1), segment.length - SEGMENT_GAP);
            const delay = reduceMotion ? 0 : index * animationDelayPerSegment;

            return (
              <motion.circle
                key={segment.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="transparent"
                stroke={segment.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${visible} ${circumference}`}
                initial={{ opacity: 0, strokeDashoffset: circumference, scale: 1 }}
                animate={{
                  opacity: dimmed ? 0.45 : 1,
                  strokeDashoffset: -segment.start,
                  scale: isActive ? 1.03 : 1,
                }}
                transition={{
                  opacity: { duration: 0.25, delay: dimmed || isActive ? 0 : delay },
                  scale: { duration: 0.2 },
                  strokeDashoffset: {
                    duration: reduceMotion ? 0 : animationDuration,
                    delay,
                    ease: 'easeOut',
                  },
                }}
                className={cn(highlightOnHover && 'cursor-pointer')}
                style={{
                  filter: isActive ? `drop-shadow(0px 0px 6px ${segment.color})` : 'none',
                  transition: 'filter 0.2s ease-out',
                }}
                onMouseEnter={highlightOnHover ? () => hover(segment) : undefined}
              />
            );
          })}
        </svg>

        {centerContent && (
          <div
            className="absolute flex flex-col items-center justify-center pointer-events-none"
            style={{ width: size - strokeWidth * 2.5, height: size - strokeWidth * 2.5 }}
          >
            {centerContent}
          </div>
        )}
      </div>
    );
  },
);

DonutChart.displayName = 'DonutChart';

export { DonutChart };
