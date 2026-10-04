import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ThemeToggle() {
  const { setTheme, theme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="ghost" 
          size="icon" 
          className="h-11 w-11 min-w-[44px] min-h-[44px] text-white/90 hover:text-white hover:bg-white/15 rounded-xl touch-manipulation"
        >
          <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="rounded-xl border-2 p-1">
        <DropdownMenuItem onClick={() => setTheme('light')} className="py-3 px-3 rounded-lg text-base font-medium touch-manipulation">
          <Sun className="mr-3 h-5 w-5" />
          ☀️ Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')} className="py-3 px-3 rounded-lg text-base font-medium touch-manipulation">
          <Moon className="mr-3 h-5 w-5" />
          🌙 Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')} className="py-3 px-3 rounded-lg text-base font-medium touch-manipulation">
          <span className="mr-3 text-lg">💻</span>
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
