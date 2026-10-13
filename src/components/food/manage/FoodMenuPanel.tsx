import { useState } from 'react';
import FoodLoadError from '@/components/food/FoodLoadError';
import { Plus, Tags, UtensilsCrossed } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  useFoodMeals, useFoodCategories, useFoodServicePeriods, useFoodMenu,
  useUpsertFoodMeal, useSetFoodMealStatus, useScheduleFoodMeal, useSetFoodSoldOut,
  useUpsertFoodCategory, useArchiveFoodCategory, formatUgx, foodToday,
  type FoodMeal,
} from '@/hooks/useFoodService';

const STATUS_TONE: Record<string, string> = {
  published: 'border-success/30 bg-success/10 text-success',
  draft: 'border-border bg-muted text-muted-foreground',
  archived: 'border-border bg-muted text-muted-foreground line-through',
};

interface MealForm {
  id: string | null;
  name: string;
  description: string;
  categoryId: string;
  price: string;
}

const EMPTY: MealForm = { id: null, name: '', description: '', categoryId: '', price: '' };
const NO_CATEGORY = '__none__';

export default function FoodMenuPanel({ canAuthor }: { canAuthor: boolean }) {
  const mealsQ = useFoodMeals();
  const { data: meals, isLoading } = mealsQ;
  const categoriesQ = useFoodCategories();
  const { data: categories } = categoriesQ;
  const periodsQ = useFoodServicePeriods();
  const { data: periods } = periodsQ;
  const menuQ = useFoodMenu();
  const { data: menu } = menuQ;

  const upsertMeal = useUpsertFoodMeal();
  const setStatus = useSetFoodMealStatus();
  const schedule = useScheduleFoodMeal();
  const setSoldOut = useSetFoodSoldOut();
  const upsertCategory = useUpsertFoodCategory();
  const archiveCategory = useArchiveFoodCategory();

  const [form, setForm] = useState<MealForm>(EMPTY);
  const [mealOpen, setMealOpen] = useState(false);
  const [categoryName, setCategoryName] = useState('');

  const emptySched = () => ({ mealId: '', periodId: '', servings: '', price: '', date: foodToday() });
  const [sched, setSched] = useState(emptySched);
  // FM-26: the server refuses bad values too; these stop a pointless request.
  const servingsOk = sched.servings.trim() === ''
    || (/^\d{1,6}$/.test(sched.servings.trim()));
  const dayPriceOk = sched.price.trim() === ''
    || (Number.isFinite(Number(sched.price)) && Number(sched.price) >= 0);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(sched.date) && sched.date >= foodToday();

  const priceNumber = Number(form.price);
  const mealValid = form.name.trim().length > 0
    && form.price.trim().length > 0
    && Number.isFinite(priceNumber)
    && priceNumber >= 0;

  const openNew = () => { setForm(EMPTY); setMealOpen(true); };
  const openEdit = (m: FoodMeal) => {
    setForm({
      id: m.id, name: m.name, description: m.description ?? '',
      categoryId: m.category_id ?? '', price: String(m.price_ugx),
    });
    setMealOpen(true);
  };

  const saveMeal = () => {
    if (!mealValid) return;
    upsertMeal.mutate(
      {
        mealId: form.id,
        name: form.name.trim(),
        description: form.description.trim() || null,
        categoryId: form.categoryId || null,
        priceUgx: priceNumber,
      },
      { onSuccess: () => { setMealOpen(false); setForm(EMPTY); } },
    );
  };

  const published = (meals ?? []).filter((m) => m.status === 'published');
  const todaysItems = (menu?.periods ?? []).flatMap((p) =>
    p.meals.map((m) => ({ ...m, periodName: p.name })));

  return (
    <div className="space-y-6">
      <FoodLoadError queries={[mealsQ, categoriesQ, periodsQ, menuQ]} />
      {/* ── meals ───────────────────────────────────────────── */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <UtensilsCrossed className="h-4 w-4" aria-hidden="true" />
            Meals
          </h2>
          <Button size="sm" disabled={!canAuthor} onClick={openNew}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            Add meal
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : (meals ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            No meals yet. Add one to start building the menu.
          </p>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {(meals ?? []).map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <Badge variant="outline" className={STATUS_TONE[m.status]}>{m.status}</Badge>
                  </div>
                  {m.description && (
                    <p className="truncate text-xs text-muted-foreground">{m.description}</p>
                  )}
                </div>
                <span className="text-sm font-semibold tabular-nums">
                  {formatUgx(m.price_ugx)}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm" variant="ghost"
                    disabled={!canAuthor || m.status === 'archived'}
                    onClick={() => openEdit(m)}
                  >
                    Edit
                  </Button>
                  {m.status !== 'published' && m.status !== 'archived' && (
                    <Button
                      size="sm" variant="outline" disabled={!canAuthor}
                      onClick={() => setStatus.mutate({ mealId: m.id, status: 'published' })}
                    >
                      Publish
                    </Button>
                  )}
                  {m.status === 'published' && (
                    <Button
                      size="sm" variant="ghost" disabled={!canAuthor}
                      onClick={() => setStatus.mutate({ mealId: m.id, status: 'draft' })}
                    >
                      Unpublish
                    </Button>
                  )}
                  {m.status !== 'archived' && (
                    <Button
                      size="sm" variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={!canAuthor}
                      onClick={() => setStatus.mutate({ mealId: m.id, status: 'archived' })}
                    >
                      Archive
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── today's menu ─────────────────────────────────────── */}
      <section>
        <h2 className="mb-1 text-sm font-semibold">Today&rsquo;s menu</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Put a published meal on a service period, with an optional price for the day
          and a serving cap.
        </p>

        <div className="mb-3 grid gap-2 rounded-xl border border-border/70 bg-card p-3 sm:grid-cols-4">
          <Select
            value={sched.mealId}
            onValueChange={(v) => setSched((s) => ({ ...s, mealId: v }))}
            disabled={!canAuthor}
          >
            <SelectTrigger className="sm:col-span-2"><SelectValue placeholder="Meal" /></SelectTrigger>
            <SelectContent>
              {published.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sched.periodId}
            onValueChange={(v) => setSched((s) => ({ ...s, periodId: v }))}
            disabled={!canAuthor}
          >
            <SelectTrigger><SelectValue placeholder="Period" /></SelectTrigger>
            <SelectContent>
              {(periods ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number" min={0} step={1} inputMode="numeric" placeholder="Servings (blank = no cap)"
            aria-label="Serving cap" aria-invalid={!servingsOk}
            value={sched.servings} disabled={!canAuthor}
            onChange={(e) => setSched((s) => ({ ...s, servings: e.target.value }))}
          />
          <Input
            type="number" min={0} inputMode="numeric" placeholder="Price for the day (blank = standard)"
            aria-label="Price for the day" aria-invalid={!dayPriceOk}
            value={sched.price} disabled={!canAuthor}
            onChange={(e) => setSched((s) => ({ ...s, price: e.target.value }))}
          />
          <Input
            type="date" aria-label="Service date" min={foodToday()}
            value={sched.date} disabled={!canAuthor}
            onChange={(e) => setSched((s) => ({ ...s, date: e.target.value }))}
          />
          <Button
            disabled={!canAuthor || !sched.mealId || !sched.periodId || !servingsOk || !dayPriceOk
              || !dateOk || schedule.isPending}
            onClick={() => schedule.mutate(
              {
                serviceDate: sched.date,
                periodId: sched.periodId,
                mealId: sched.mealId,
                servingsTotal: sched.servings.trim() === '' ? null : Number(sched.servings),
                priceUgx: sched.price.trim() === '' ? null : Number(sched.price),
                publish: true,
              },
              { onSuccess: () => setSched(emptySched()) },
            )}
          >
            Add to menu
          </Button>
          {(!servingsOk || !dayPriceOk) && (
            <p className="text-xs text-destructive sm:col-span-4">
              {!servingsOk ? 'Servings must be a whole number of zero or more. ' : ''}
              {!dayPriceOk ? 'The price for the day must be zero or more.' : ''}
            </p>
          )}
        </div>

        {todaysItems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            Nothing published for today yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {todaysItems.map((item) => (
              <li key={item.menu_item_id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.periodName} &middot; {formatUgx(item.price_ugx)}
                    {item.servings_total !== null && (
                      <> &middot; {item.servings_remaining} of {item.servings_total} left</>
                    )}
                  </p>
                </div>
                {item.sold_out && (
                  <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
                    Sold out
                  </Badge>
                )}
                <Button
                  size="sm" variant="outline" disabled={!canAuthor || setSoldOut.isPending}
                  onClick={() => setSoldOut.mutate({
                    menuItemId: item.menu_item_id, soldOut: !item.sold_out,
                  })}
                >
                  {item.sold_out ? 'Mark available' : 'Mark sold out'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── categories ──────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Tags className="h-4 w-4" aria-hidden="true" />
          Categories
        </h2>

        <div className="mb-3 flex gap-2">
          <Input
            placeholder="New category name"
            value={categoryName}
            disabled={!canAuthor}
            onChange={(e) => setCategoryName(e.target.value)}
          />
          <Button
            disabled={!canAuthor || !categoryName.trim() || upsertCategory.isPending}
            onClick={() => upsertCategory.mutate(
              { name: categoryName.trim() },
              { onSuccess: () => setCategoryName('') },
            )}
          >
            Add
          </Button>
        </div>

        {(categories ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            No categories yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {(categories ?? []).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 p-3">
                <span className="text-sm">{c.name}</span>
                <Button
                  size="sm" variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={!canAuthor || archiveCategory.isPending}
                  onClick={() => archiveCategory.mutate({ categoryId: c.id })}
                >
                  Archive
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          A category cannot be archived while meals are still filed under it.
        </p>
      </section>

      {/* ── meal dialog ─────────────────────────────────────── */}
      <Dialog open={mealOpen} onOpenChange={setMealOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit meal' : 'Add meal'}</DialogTitle>
            <DialogDescription>
              New meals start as a draft. Publish one to put it on a menu.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="meal-name">Name</Label>
              <Input
                id="meal-name" value={form.name} maxLength={80}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              {form.name.trim().length === 0 && (
                <p className="text-[11px] text-muted-foreground">A name is required.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meal-desc">Description</Label>
              <Textarea
                id="meal-desc" rows={2} value={form.description} maxLength={240}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meal-price">Price (UGX)</Label>
              <Input
                id="meal-price" type="number" min={0} inputMode="numeric" value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              />
              {form.price !== '' && !(Number.isFinite(priceNumber) && priceNumber >= 0) && (
                <p className="text-[11px] text-destructive">
                  Enter a price of zero or more.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meal-cat">Category</Label>
              <Select
                value={form.categoryId || NO_CATEGORY}
                onValueChange={(v) => setForm((f) => ({
                  ...f, categoryId: v === NO_CATEGORY ? '' : v,
                }))}
              >
                <SelectTrigger id="meal-cat"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                  {(categories ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMealOpen(false)}>Cancel</Button>
            <Button disabled={!mealValid || upsertMeal.isPending} onClick={saveMeal}>
              {form.id ? 'Save changes' : 'Add meal'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
