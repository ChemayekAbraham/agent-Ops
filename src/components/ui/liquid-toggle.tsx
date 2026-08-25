import React from 'react';
import { cn } from '@/lib/utils';

const styles = {
  switch: `relative block cursor-pointer h-8 w-[52px] shrink-0
    [--c-active:hsl(var(--primary))]
    [--c-success:#10B981]
    [--c-warning:#F59E0B]
    [--c-danger:hsl(var(--destructive))]
    [--c-default:hsl(var(--muted))]
    [--c-default-dark:hsl(var(--muted-foreground)/0.35)]
    [transform:translateZ(0)]
    [backface-visibility:hidden]`,
  input: `h-full w-full cursor-pointer appearance-none rounded-full m-0
    bg-[--c-default] outline-none transition-colors duration-500
    hover:bg-[--c-default-dark]
    focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
    disabled:cursor-not-allowed disabled:opacity-50
    [transform:translate3d(0,0,0)]
    data-[checked=true]:bg-[--c-background]`,
  svg: `pointer-events-none absolute inset-0 fill-primary-foreground
    [transform:translate3d(0,0,0)]`,
  circle: `transform-gpu transition-transform duration-500
    [transform:translate3d(0,0,0)]
    [backface-visibility:hidden]`,
  dropCircle: `transform-gpu transition-transform duration-700
    [transform:translate3d(0,0,0)]`,
};

const variantStyles = {
  default: '[--c-background:var(--c-active)]',
  success: '[--c-background:var(--c-success)]',
  warning: '[--c-background:var(--c-warning)]',
  danger: '[--c-background:var(--c-danger)]',
};

interface ToggleProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

export function Toggle({
  checked = false,
  onCheckedChange,
  className,
  disabled,
  variant = 'default',
  ...rest
}: ToggleProps) {
  const [isChecked, setIsChecked] = React.useState(checked);

  React.useEffect(() => {
    setIsChecked(checked);
  }, [checked]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIsChecked(e.target.checked);
    onCheckedChange?.(e.target.checked);
  };

  return (
    <label className={cn(styles.switch, className)}>
      <input
        type="checkbox"
        role="switch"
        checked={isChecked}
        disabled={disabled}
        onChange={handleChange}
        data-checked={isChecked}
        className={cn(styles.input, variantStyles[variant])}
        {...rest}
      />
      <svg viewBox="0 0 52 32" filter="url(#goo)" className={styles.svg}>
        <circle
          className={styles.circle}
          cx="16"
          cy="16"
          r="10"
          style={{
            transformOrigin: '16px 16px',
            transform: `translateX(${isChecked ? '12px' : '0px'}) scale(${isChecked ? '0' : '1'})`,
          }}
        />
        <circle
          className={styles.circle}
          cx="36"
          cy="16"
          r="10"
          style={{
            transformOrigin: '36px 16px',
            transform: `translateX(${isChecked ? '0px' : '-12px'}) scale(${isChecked ? '1' : '0'})`,
          }}
        />
        {isChecked && <circle className={styles.dropCircle} cx="35" cy="-1" r="2.5" />}
      </svg>
    </label>
  );
}

export function GooeyFilter() {
  return (
    <svg className="fixed w-0 h-0" aria-hidden="true">
      <defs>
        <filter id="goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>
  );
}
