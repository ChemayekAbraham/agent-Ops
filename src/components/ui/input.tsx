import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Base styles with iOS-safe font size (16px prevents zoom on focus)
          "flex h-14 w-full rounded-lg border border-input bg-background px-4 py-3 text-base file:border-0 file:bg-transparent file:text-base file:font-medium file:text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0 focus:border-primary active:border-primary disabled:cursor-not-allowed disabled:opacity-50",
          // Stability: prevent transform animations and layout shifts
          "touch-manipulation transform-none will-change-auto",
          // Spacing below every input instance
          "mb-[5px]",
          className,
        )}
        ref={ref}
        autoComplete={props.autoComplete || "off"}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck="false"
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };