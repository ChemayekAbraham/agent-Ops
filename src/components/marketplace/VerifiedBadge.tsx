import { BadgeCheck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface VerifiedBadgeProps {
  size?: "sm" | "md" | "lg";
  showTooltip?: boolean;
  className?: string;
}

export function VerifiedBadge({ size = "md", showTooltip = true, className = "" }: VerifiedBadgeProps) {
  const sizeClasses = {
    sm: "h-3.5 w-3.5",
    md: "h-4 w-4",
    lg: "h-5 w-5",
  };

  const badge = (
    <BadgeCheck 
      className={`${sizeClasses[size]} text-primary fill-primary/20 ${className}`}
    />
  );

  if (!showTooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help">{badge}</span>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">Verified Seller</p>
      </TooltipContent>
    </Tooltip>
  );
}
