/**
 * Chart colours for the Call Centre overview.
 *
 * Every value below was run through the data-viz palette validator against this
 * app's own chart surfaces — light `--card` (#ffffff) and dark `--card`
 * (#0f1729) — rather than picked by eye. Dark is a *selected* set of steps for
 * the dark surface, not an automatic flip of the light one: the Tailwind-500
 * steps the rest of the app uses for charts sit above the dark lightness band
 * and fail it.
 *
 * Validator results (OKLab ΔE ×100, adjacent pairlist):
 *   trend pair  — light: CVD 24.7 / normal 33.6, contrast OK
 *                 dark:  CVD 26.8 / normal 31.8, contrast OK
 *   role slices — light: CVD  9.1 / normal 19.6, 3 hues under 3:1 contrast
 *                 dark:  CVD  8.4 / normal 19.3, contrast OK
 *
 * The light-mode contrast warning is why both charts ship visible value labels
 * and a numeric legend: the relief rule means colour is never the only way to
 * read a slice.
 *
 * Answered/rejected deliberately do NOT use the app's green/destructive tokens.
 * Green-vs-red is the classic red-green-blindness pair and measured ΔE 7.4
 * (project tokens) and 4.1 (pure status hues) — both under the ≥8 gate. The
 * blue/orange pair carries identity safely, and the accepted/rejected *meaning*
 * is carried by the legend, the axis labels and the KPI tiles, where status
 * colour always ships beside an icon and a word.
 */

export interface CallCentreChartTheme {
  /** Answered series. */
  answered: string;
  /** Rejected series. */
  rejected: string;
  /** Doughnut slices, in fixed order — never cycled, never reordered. */
  roleSlices: string[];
  /** Hairline gridline, one step off the surface. */
  grid: string;
  /** Axis / tick ink. */
  axis: string;
  /** Surface colour, used for the 2px gap between touching doughnut slices. */
  surface: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
}

const LIGHT: CallCentreChartTheme = {
  answered: '#2a78d6',
  rejected: '#eb6834',
  roleSlices: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'],
  grid: '#e1e0d9',
  axis: '#898781',
  surface: '#ffffff',
  tooltipBg: '#ffffff',
  tooltipBorder: 'rgba(11,11,11,0.10)',
  tooltipText: '#0b0b0b',
};

const DARK: CallCentreChartTheme = {
  answered: '#3987e5',
  rejected: '#d95926',
  roleSlices: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'],
  grid: '#2c2c2a',
  axis: '#898781',
  surface: '#0f1729',
  tooltipBg: '#111a2e',
  tooltipBorder: 'rgba(255,255,255,0.12)',
  tooltipText: '#ffffff',
};

export const CALL_CENTRE_CHART_THEME = { light: LIGHT, dark: DARK } as const;

/**
 * Recharts needs concrete colour strings, not CSS custom properties, so the
 * theme has to be chosen in JS rather than by a media query. Reads the `dark`
 * class this app toggles on `<html>`.
 */
export function resolveChartTheme(isDark: boolean): CallCentreChartTheme {
  return isDark ? DARK : LIGHT;
}
