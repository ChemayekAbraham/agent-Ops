import { useState, useEffect, forwardRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Trash2, Target, TrendingUp } from 'lucide-react';
import { format, addMonths } from 'date-fns';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { InvestmentGoal } from './InvestmentGoals';

interface SetGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal?: InvestmentGoal;
  onSave: (goal: Omit<InvestmentGoal, 'id' | 'currentAmount' | 'createdAt'>) => void;
  onDelete?: () => void;
}

const COLORS = [
  { id: 'blue', label: 'Blue', class: 'bg-blue-500' },
  { id: 'green', label: 'Green', class: 'bg-green-500' },
  { id: 'purple', label: 'Purple', class: 'bg-purple-500' },
  { id: 'orange', label: 'Orange', class: 'bg-orange-500' },
  { id: 'pink', label: 'Pink', class: 'bg-pink-500' },
];

const PRESETS = [
  { label: 'UGX 500K', value: 500000 },
  { label: 'UGX 1M', value: 1000000 },
  { label: 'UGX 2M', value: 2000000 },
  { label: 'UGX 5M', value: 5000000 },
];

export function SetGoalDialog({ open, onOpenChange, goal, onSave, onDelete }: SetGoalDialogProps) {
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [deadline, setDeadline] = useState<Date>(addMonths(new Date(), 1));
  const [color, setColor] = useState('blue');

  useEffect(() => {
    if (goal) {
      setName(goal.name);
      setTargetAmount(goal.targetAmount.toString());
      setDeadline(new Date(goal.deadline));
      setColor(goal.color);
    } else {
      setName('');
      setTargetAmount('');
      setDeadline(addMonths(new Date(), 1));
      setColor('blue');
    }
  }, [goal, open]);

  const handleSave = () => {
    const amount = parseInt(targetAmount.replace(/,/g, '')) || 0;
    if (name.trim() && amount > 0) {
      onSave({
        name: name.trim(),
        targetAmount: amount,
        deadline: deadline.toISOString(),
        color,
      });
    }
  };

  const requiredInvestment = (parseInt(targetAmount.replace(/,/g, '')) || 0) / 0.15;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent stable className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            {goal ? 'Edit Goal' : 'Set Investment Goal'}
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-5 py-4">
          {/* Goal Name */}
          <div className="space-y-2">
            <Label htmlFor="goal-name">Goal Name</Label>
            <Input
              id="goal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Monthly Savings, Emergency Fund..."
              className="bg-secondary/50"
            />
          </div>

          {/* Target Amount */}
          <div className="space-y-2">
            <Label>Monthly Earning Target (UGX)</Label>
            <Input
              value={parseInt(targetAmount.replace(/,/g, '') || '0').toLocaleString()}
              onChange={(e) => setTargetAmount(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="Enter target amount"
              className="bg-secondary/50 text-lg font-semibold"
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTargetAmount(preset.value.toString())}
                  className={cn(
                    "text-xs",
                    parseInt(targetAmount) === preset.value && "bg-primary text-primary-foreground"
                  )}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Investment Required Info */}
          {parseInt(targetAmount) > 0 && (
            <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
              <div className="flex items-center gap-2 text-sm">
                <TrendingUp className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">To earn this, you need to invest:</span>
              </div>
              <p className="text-lg font-bold text-primary mt-1">
                {formatUGX(requiredInvestment)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">at 15% monthly ROI</p>
            </div>
          )}

          {/* Deadline */}
          <div className="space-y-2">
            <Label>Target Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal bg-secondary/50",
                    !deadline && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {deadline ? format(deadline, "PPP") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={deadline}
                  onSelect={(date) => date && setDeadline(date)}
                  disabled={(date) => date < new Date()}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Color */}
          <div className="space-y-2">
            <Label>Goal Color</Label>
            <RadioGroup value={color} onValueChange={setColor} className="flex gap-3">
              {COLORS.map((c) => (
                <div key={c.id} className="flex items-center">
                  <RadioGroupItem value={c.id} id={`color-${c.id}`} className="sr-only" />
                  <Label
                    htmlFor={`color-${c.id}`}
                    className={`w-8 h-8 rounded-full cursor-pointer ring-2 ring-offset-2 ring-offset-background transition-all ${c.class} ${
                      color === c.id ? 'ring-foreground' : 'ring-transparent hover:ring-muted-foreground/50'
                    }`}
                  />
                </div>
              ))}
            </RadioGroup>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {goal && onDelete && (
            <Button 
              variant="destructive" 
              onClick={onDelete}
              className="w-full sm:w-auto gap-1.5"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <div className="flex gap-2 w-full sm:w-auto">
            <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
              Cancel
            </Button>
            <Button 
              onClick={handleSave} 
              disabled={!name.trim() || !parseInt(targetAmount)}
              className="flex-1"
            >
              {goal ? 'Save Changes' : 'Create Goal'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
