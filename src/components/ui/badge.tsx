import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-lg border px-2.5 py-0.5 text-xs font-semibold tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow-sm",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-destructive/20 bg-destructive/10 text-destructive",
        success: "border-success/20 bg-success/10 text-success",
        warning: "border-warning/20 bg-warning/10 text-warning",
        outline: "text-foreground border-border/60 bg-transparent",
        primary: "border-transparent bg-primary text-white",
        muted: "border-transparent bg-muted text-muted-foreground"
      },
      size: {
        sm: "px-2 py-0 text-[10px] rounded-md",
        default: "px-2.5 py-0.5 text-xs",
        lg: "px-3 py-1 text-sm rounded-xl"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <div className={cn(badgeVariants({ variant, size }), className)} ref={ref} {...props} />
    );
  }
);
Badge.displayName = "Badge";

export { Badge, badgeVariants };