import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { hapticTap } from "@/lib/haptics";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-background transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.97] select-none cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-md hover:bg-primary/90 hover:shadow-lg active:shadow-md",
        destructive: "bg-destructive text-destructive-foreground shadow-md hover:bg-destructive/90 hover:shadow-lg active:shadow-md",
        outline: "border border-border/60 bg-background hover:bg-accent/30 hover:border-border active:bg-accent/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/90",
        ghost: "hover:bg-accent/40 active:bg-accent/60",
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
        success: "bg-success text-success-foreground shadow-md hover:bg-success/90 hover:shadow-lg active:shadow-md",
        warning: "bg-warning text-warning-foreground shadow-md hover:bg-warning/90 hover:shadow-lg active:shadow-md",
        soft: "bg-primary/10 text-primary hover:bg-primary/15 active:bg-primary/20",
      },
      size: {
        default: "h-11 px-5 py-2.5 min-h-[44px]",
        sm: "h-9 rounded-lg px-3 text-xs min-h-[36px]",
        lg: "h-12 rounded-xl px-6 min-h-[48px]",
        xl: "h-14 rounded-2xl px-8 text-base min-h-[56px]",
        icon: "h-11 w-11 min-h-[44px] min-w-[44px]",
        "icon-sm": "h-9 w-9 rounded-lg min-h-[36px] min-w-[36px]",
        "icon-lg": "h-12 w-12 rounded-xl min-h-[48px] min-w-[48px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  haptic?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, haptic = true, onClick, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    
    const handleClick = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
      if (haptic && !props.disabled) {
        hapticTap();
      }
      onClick?.(e);
    }, [haptic, onClick, props.disabled]);
    
    return (
      <Comp 
        className={cn(buttonVariants({ variant, size, className }))} 
        ref={ref} 
        onClick={asChild ? onClick : handleClick}
        style={{ 
          WebkitTapHighlightColor: 'transparent', 
          touchAction: 'manipulation',
          WebkitUserSelect: 'none',
          userSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
        {...props} 
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };