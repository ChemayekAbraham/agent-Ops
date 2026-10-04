import { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PasswordStrengthIndicatorProps {
  password: string;
}

interface StrengthCriteria {
  label: string;
  met: boolean;
}

function getPasswordStrength(password: string): {
  score: number;
  label: string;
  color: string;
  criteria: StrengthCriteria[];
} {
  const criteria: StrengthCriteria[] = [
    { label: 'At least 6 characters', met: password.length >= 6 },
    { label: 'Contains uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'Contains lowercase letter', met: /[a-z]/.test(password) },
    { label: 'Contains a number', met: /[0-9]/.test(password) },
    { label: 'Contains special character', met: /[!@#$%^&*(),.?":{}|<>]/.test(password) },
  ];

  const metCount = criteria.filter(c => c.met).length;
  
  if (password.length === 0) {
    return { score: 0, label: '', color: '', criteria };
  }
  
  if (metCount <= 1) {
    return { score: 1, label: 'Weak', color: 'bg-destructive', criteria };
  }
  if (metCount === 2) {
    return { score: 2, label: 'Fair', color: 'bg-orange-500', criteria };
  }
  if (metCount === 3) {
    return { score: 3, label: 'Good', color: 'bg-yellow-500', criteria };
  }
  if (metCount === 4) {
    return { score: 4, label: 'Strong', color: 'bg-emerald-500', criteria };
  }
  return { score: 5, label: 'Very Strong', color: 'bg-emerald-600', criteria };
}

export default function PasswordStrengthIndicator({ password }: PasswordStrengthIndicatorProps) {
  const strength = useMemo(() => getPasswordStrength(password), [password]);

  if (password.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 mt-2">
      {/* Strength bars */}
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((level) => (
          <div
            key={level}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-all duration-300',
              strength.score >= level ? strength.color : 'bg-muted'
            )}
          />
        ))}
      </div>
      
      {/* Strength label */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Password strength:</span>
        <span className={cn(
          'text-xs font-medium',
          strength.score <= 1 ? 'text-destructive' :
          strength.score === 2 ? 'text-orange-500' :
          strength.score === 3 ? 'text-yellow-600' :
          'text-emerald-600'
        )}>
          {strength.label}
        </span>
      </div>

      {/* Criteria checklist */}
      <div className="grid grid-cols-1 gap-1 pt-1">
        {strength.criteria.map((criterion, idx) => (
          <div 
            key={idx} 
            className={cn(
              'flex items-center gap-1.5 text-xs transition-colors',
              criterion.met ? 'text-emerald-600' : 'text-muted-foreground'
            )}
          >
            {criterion.met ? (
              <Check className="h-3 w-3" />
            ) : (
              <X className="h-3 w-3" />
            )}
            <span>{criterion.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
