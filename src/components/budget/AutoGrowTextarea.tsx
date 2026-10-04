import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A single-line textarea that grows vertically to fit its content,
 * so long text is never hidden behind a scrollbar.
 */
export const AutoGrowTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, value, onChange, ...props }, ref) => {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

  const resize = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  React.useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
  };

  return (
    <textarea
      ref={setRefs}
      rows={1}
      value={value}
      onChange={onChange}
      className={cn(
        'flex w-full resize-none overflow-hidden rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 touch-manipulation',
        className,
      )}
      {...props}
    />
  );
});
AutoGrowTextarea.displayName = 'AutoGrowTextarea';

export default AutoGrowTextarea;
