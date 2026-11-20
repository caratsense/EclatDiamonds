"use client";

/**
 * Theme-aware Apache ECharts wrapper for Eclat / CaratSense.
 *
 * Reads the active next-themes mode, resolves the luxury-minimal design
 * tokens from CSS variables (fonts, hairline axes, card-styled tooltip,
 * the --chart-* palette) and renders responsively.
 *
 * Phase B note: prefer the preset helpers (AreaChart / BarChart / DonutChart)
 * below — they cover the common module charts with minimal code. Drop down to
 * <EChart option={...}/> only when you need a bespoke option object.
 */
import * as React from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Token plumbing                                                      */
/* ------------------------------------------------------------------ */

/** Resolved design tokens read from the document's computed CSS variables. */
export interface ChartTokens {
  foreground: string;
  muted: string;
  border: string;
  card: string;
  popover: string;
  accent: string;
  fontSans: string;
  fontSerif: string;
  palette: string[];
}

function readVar(style: CSSStyleDeclaration, name: string, fallback: string) {
  const v = style.getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Resolve a CSS color variable to a concrete rgb()/rgba() string.
 *
 * Our design tokens are authored in `oklch()` (Tailwind v4). The browser
 * handles that fine in CSS, but ECharts' SVG renderer can NOT parse oklch
 * strings — series/axis colours silently break. So we paint the value onto a
 * throwaway element and read back the browser-resolved `color`, which is always
 * a plain rgb()/rgba(). One reused probe keeps this cheap.
 */
function makeColorResolver() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const rootStyle = getComputedStyle(document.documentElement);
  return {
    /*
     * Resolve a CSS custom property to a concrete colour, falling back when it
     * is genuinely absent.
     *
     * The fallback used to be unreachable. This set `probe.style.color =
     * "var(--x)"` and returned the fallback only when the computed value was
     * the empty string — but `getComputedStyle().color` NEVER returns "". When
     * the variable is undefined the declaration is invalid at computed-value
     * time, and `color`, being inherited, simply takes the parent's: the probe
     * reported the body's text colour. Measured on this app, an undefined
     * variable returned rgb(17,33,29), exactly `body`'s colour.
     *
     * So a missing palette did not fall back to six distinct defaults — every
     * entry came back as the same near-black, and a pie drawn from it was a
     * single black disc. That is the "Leads pie chart is entirely black" bug.
     *
     * Reading the variable off the root FIRST is the actual test of presence:
     * `getPropertyValue` returns "" for a variable that was never declared.
     * The probe is still used to turn whatever it holds into a concrete rgb(),
     * since a token may itself be a var() chain or a named colour.
     */
    resolve(varName: string, fallback: string) {
      const declared = rootStyle.getPropertyValue(varName).trim();
      if (!declared) return fallback;
      probe.style.color = "";
      probe.style.color = `var(${varName})`;
      const rgb = getComputedStyle(probe).color;
      // A declared-but-unparseable value lands back on the parent colour; the
      // fallback is better than inheriting the page's ink.
      return rgb && rgb !== "" ? rgb : fallback;
    },
    done() {
      probe.remove();
    },
  };
}

function resolveTokens(): ChartTokens {
  if (typeof window === "undefined") {
    // SSR-safe defaults; the client re-resolves on mount.
    return {
      foreground: "#1a1816",
      muted: "#6b655c",
      border: "#e6e1d8",
      card: "#ffffff",
      popover: "#ffffff",
      accent: "#b08d3b",
      fontSans: "ui-sans-serif, system-ui, sans-serif",
      fontSerif: "ui-serif, Georgia, serif",
      // jewel sequence — gold, graphite, emerald, garnet, sapphire, amber
      palette: ["#b08d3b", "#3f3a33", "#2f7d5b", "#9c3d3d", "#3e5c76", "#c8872b"],
    };
  }
  const s = getComputedStyle(document.documentElement);
  const c = makeColorResolver();
  const tokens: ChartTokens = {
    foreground: c.resolve("--foreground", "#37352f"),
    muted: c.resolve("--muted-foreground", "#787774"),
    border: c.resolve("--border", "#e9e9e7"),
    card: c.resolve("--card", "#ffffff"),
    popover: c.resolve("--popover", "#ffffff"),
    accent: c.resolve("--primary", "#2d7ff9"),
    // fonts are family strings, not colours — read raw.
    fontSans: readVar(s, "--font-sans", "ui-sans-serif, system-ui, sans-serif"),
    fontSerif: readVar(s, "--font-serif", "ui-serif, Georgia, serif"),
    palette: [
      c.resolve("--chart-1", "#2d7ff9"),
      c.resolve("--chart-2", "#18a0a0"),
      c.resolve("--chart-3", "#8b5cf6"),
      c.resolve("--chart-4", "#f5a623"),
      c.resolve("--chart-5", "#0f9d58"),
      c.resolve("--chart-6", "#9b9a97"),
    ],
  };
  c.done();
  return tokens;
}

/** Hook that resolves chart tokens and refreshes when the theme flips. */
export function useChartTokens(): ChartTokens {
  const { resolvedTheme } = useTheme();
  const [tokens, setTokens] = React.useState<ChartTokens>(() => resolveTokens());

  /*
   * Re-resolve on MOUNT as well as on a theme flip.
   *
   * The initial value is computed in the `useState` initialiser, during the
   * first client render — which can run before the stylesheet has applied. If
   * it does, every token resolves to an inherited default and, because this
   * effect used to depend on `resolvedTheme` alone, the wrong palette was
   * cached for the life of the component: the chart stayed black until
   * somebody happened to toggle the theme. Running once on mount corrects an
   * early read; the theme dependency still handles later flips.
   */
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setTokens(resolveTokens()));
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme]);

  return tokens;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Module-level so the subscription survives re-renders instead of churning. */
function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Whether the viewer has asked for reduced motion.
 *
 * `globals.css` already honours the query for CSS transitions, but ECharts
 * animates in JavaScript on a canvas/SVG it owns — no stylesheet reaches it. So
 * the same query is read here and the animation switched off at the option
 * level. Read as an external store rather than mirrored into state: the server
 * snapshot is `false`, so the server render and the hydration pass agree
 * without the extra render an effect-then-setState would schedule.
 */
export function usePrefersReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

/* ------------------------------------------------------------------ */
/* Base building blocks                                                */
/* ------------------------------------------------------------------ */

/** Shared base option carrying the luxury-minimal look (axes, tooltip, text). */
export function baseOption(t: ChartTokens, reducedMotion = false): EChartsOption {
  return {
    color: t.palette,
    textStyle: { fontFamily: t.fontSans, color: t.foreground },
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    // Enough motion to show that the figures changed, not enough to wait for.
    animation: !reducedMotion,
    animationDuration: 320,
    animationDurationUpdate: 240,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    legend: {
      // Scrolling rather than wrapping: the attendance trend carries eight
      // bands, and a wrapped legend silently ate the plot area.
      type: "scroll",
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      top: 0,
      right: 0,
      // Clicking an entry hides its series. This is the ECharts default and is
      // stated so it does not get switched off by a later `legend` override.
      selectedMode: true,
      textStyle: { color: t.muted, fontSize: 12, fontFamily: t.fontSans },
      // A hidden series must still be readable enough to click back on, which
      // ECharts' default near-white `inactiveColor` is not on a light card.
      inactiveColor: hexA(t.muted, 0.4),
      pageIconColor: t.muted,
      pageIconInactiveColor: hexA(t.muted, 0.35),
      pageIconSize: 10,
      pageTextStyle: { color: t.muted, fontSize: 11 },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: t.popover,
      borderColor: t.border,
      borderWidth: 1,
      padding: [8, 12],
      // Charts sit inside cards that clip their overflow, so a tooltip near the
      // edge was cut in half. Confining it keeps the whole row readable.
      confine: true,
      extraCssText: "border-radius:8px; box-shadow:0 4px 12px -4px rgba(0,0,0,0.1);",
      textStyle: { color: t.foreground, fontSize: 12, fontFamily: t.fontSans },
      axisPointer: { lineStyle: { color: t.border }, crossStyle: { color: t.border } },
    },
  };
}

const hairlineAxis = (t: ChartTokens) => ({
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: t.muted, fontSize: 12, fontFamily: t.fontSans },
});

const splitHairline = (t: ChartTokens) => ({
  show: true,
  lineStyle: { color: t.border, width: 1, type: [4, 4] as [number, number] },
});

/* ------------------------------------------------------------------ */
/* Tooltips                                                            */
/* ------------------------------------------------------------------ */

/**
 * Escape a label before it goes into a tooltip.
 *
 * ECharts injects a formatter's return value as HTML. Category labels are store
 * names, payment modes and product titles — all typed by a user into the ERP,
 * so an apostrophe or an angle bracket is a matter of when, not if.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One tooltip line: the series' marker dot, its name, then the bold figure. */
function tooltipRow(marker: string, name: string, value: string, share: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">` +
    `${marker}<span>${esc(name)}</span>` +
    `<strong style="margin-left:auto;padding-left:12px">${esc(value)}</strong>${share}` +
    `</div>`
  );
}

/** Params ECharts hands an axis-trigger tooltip formatter, for the bits we read. */
interface AxisTooltipParam {
  marker?: string;
  seriesName?: string;
  axisValue?: string | number;
  axisValueLabel?: string;
  value?: number | string | null;
}

/**
 * Axis-trigger tooltip in the same shape as the donut's: the hovered category
 * on top, then one marker-dot row per series with the value in bold.
 *
 * Exported because several modules build their option by hand (footfall, stock
 * aging) and a reader should not have to re-learn the layout per chart.
 *
 * The percentage denominator is deliberately opt-in: a share is only an answer
 * when the figures compose a whole. `shareTotal` covers one series across
 * categories ("this store was 18% of the month"); `shareOfRows` covers a
 * stacked category, where the whole is the stack under the cursor and so
 * differs per column. Across a revenue-vs-target pair neither applies, and the
 * percentage is left out rather than printed because it was computable.
 */
export function axisTooltipFormatter(opts?: {
  format?: (v: number) => string;
  shareTotal?: number;
  shareOfRows?: boolean;
}) {
  const format = opts?.format ?? ((v: number) => formatNumber(v));

  return (params: unknown): string => {
    const rows = (Array.isArray(params) ? params : [params]) as AxisTooltipParam[];
    if (rows.length === 0) return "";

    const total = opts?.shareOfRows
      ? rows.reduce((sum, r) => sum + Math.abs(Number(r.value ?? 0)), 0)
      : (opts?.shareTotal ?? 0);

    const label = String(rows[0].axisValueLabel ?? rows[0].axisValue ?? "");
    const head = label
      ? `<div style="margin-bottom:4px;opacity:0.7">${esc(label)}</div>`
      : "";

    const body = rows
      .map((r) => {
        const n = Number(r.value ?? 0);
        const share =
          total > 0
            ? `<span style="opacity:0.7;margin-left:6px">${((Math.abs(n) / total) * 100).toFixed(1)}%</span>`
            : "";
        return tooltipRow(r.marker ?? "", r.seriesName ?? "", format(n), share);
      })
      .join("");

    return head + body;
  };
}

/* ------------------------------------------------------------------ */
/* Core component                                                      */
/* ------------------------------------------------------------------ */

export interface EChartProps {
  /** A full or partial ECharts option. Merged onto the themed base. */
  option: EChartsOption;
  /** Pixel height of the chart area. Default 280. */
  height?: number | string;
  className?: string;
  /** Replace (not merge) the previous option on update. Default false. */
  notMerge?: boolean;
  /** Click handler on series datapoints. */
  onEvents?: Record<string, (params: unknown) => void>;
}

/**
 * Low-level themed chart. Merges `option` over the luxury-minimal base and
 * re-renders cleanly on theme change. Most callers should use a preset below.
 */
export function EChart({
  option,
  height = 280,
  className,
  notMerge,
  onEvents,
}: EChartProps) {
  const tokens = useChartTokens();
  const reducedMotion = usePrefersReducedMotion();

  const merged = React.useMemo<EChartsOption>(() => {
    const base = baseOption(tokens, reducedMotion);
    return {
      ...base,
      ...option,
      textStyle: option.textStyle ? { ...base.textStyle, ...option.textStyle } : base.textStyle,
      grid: option.grid ? { ...base.grid, ...option.grid } : base.grid,
      legend: option.legend
        ? (Array.isArray(option.legend) ? option.legend : { ...base.legend, ...option.legend })
        : base.legend,
      tooltip: option.tooltip
        ? (Array.isArray(option.tooltip) ? option.tooltip : { ...base.tooltip, ...option.tooltip })
        : base.tooltip,
    };
  }, [tokens, option, reducedMotion]);

  return (
    <ReactECharts
      // key forces a remount on theme flip so merged styling is clean.
      key={tokens.card}
      option={merged}
      notMerge={notMerge}
      lazyUpdate
      style={{ height, width: "100%" }}
      className={cn(className)}
      opts={{ renderer: "svg" }}
      onEvents={onEvents}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Preset wrappers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Placeholder shown instead of a chart when there is nothing to plot. Without it,
 * an all-zero series makes ECharts default the value axis to a max of 1, which
 * renders a misleading "₹1" tick — so an empty period looked like a ₹1 day.
 */
export function ChartEmpty({
  height = 280,
  className,
  message = "No data for this period",
}: {
  height?: number | string;
  className?: string;
  /** Say what the chart is waiting for — "no data" alone reads as a fault. */
  message?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 text-center text-sm text-muted-foreground",
        className,
      )}
      style={{ height }}
    >
      {message}
    </div>
  );
}

/**
 * Shown when the query behind a chart failed.
 *
 * Separate from ChartEmpty on purpose. "Nothing was sold in this period" and
 * "we could not reach the server" are different facts, and every page that let
 * a failed query fall through to an empty array told the reader the first when
 * the truth was the second.
 */
export function ChartError({
  height = 280,
  className,
  message = "Couldn't load this chart.",
  onRetry,
}: {
  height?: number | string;
  className?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border bg-muted/30 px-4 text-center",
        className,
      )}
      style={{ height }}
    >
      <p className="text-sm font-medium">{message}</p>
      <p className="text-xs text-muted-foreground">
        The connection may have dropped. Check your network and try again.
      </p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** True when at least one series carries a non-zero value worth plotting. */
function hasPlottableData(series: { data: (number | null)[] }[]): boolean {
  return series.some((s) =>
    s.data.some((v) => v != null && Math.abs(Number(v) || 0) > 0),
  );
}

/** A named numeric series for the cartesian presets. */
export interface ChartSeries {
  name: string;
  /** `null` leaves a GAP rather than plotting a point at zero — the difference
   *  between "no target was set" and "the target is nothing". */
  data: (number | null)[];
  /** Render this series as a dashed reference line (e.g. target). */
  dashed?: boolean;
  /** Override the palette colour for this series. */
  color?: string;
}

interface CartesianProps {
  /** X-axis category labels. */
  categories: (string | number)[];
  series: ChartSeries[];
  height?: number | string;
  className?: string;
  /** Format y-axis ticks + tooltip values (e.g. INR compact). */
  valueFormatter?: (v: number) => string;
  /** Hide the legend (single-series charts). Default shows when >1 series. */
  showLegend?: boolean;
  /** What the chart is waiting for, shown in place of an empty plot. */
  emptyMessage?: string;
}

/**
 * Area / line chart. Solid series render as soft accent-tinted area fills;
 * `dashed` series render as a thin dashed reference line.
 */
export function AreaChart({
  categories,
  series,
  height = 280,
  className,
  valueFormatter,
  showLegend,
  emptyMessage,
}: CartesianProps) {
  const t = useChartTokens();
  const legend = showLegend ?? series.length > 1;

  const option = React.useMemo<EChartsOption>(() => {
    return {
      legend: legend ? { show: true } : { show: false },
      /*
       * No share percentage here. These are time series — a month's slice of
       * the trailing year is arithmetic, not an insight, and printing it beside
       * the figure invites the reader to treat a quiet month as a shortfall.
       */
      tooltip: {
        trigger: "axis",
        formatter: axisTooltipFormatter({ format: valueFormatter }),
      },
      xAxis: { type: "category", boundaryGap: false, data: categories, ...hairlineAxis(t) },
      yAxis: {
        type: "value",
        ...hairlineAxis(t),
        splitLine: splitHairline(t),
        axisLabel: {
          color: t.muted,
          fontSize: 12,
          fontFamily: t.fontSans,
          formatter: valueFormatter ? (v: number) => valueFormatter(v) : undefined,
        },
      },
      series: series.map((s, i) => {
        const c = s.color ?? t.palette[i % t.palette.length];
        /*
         * Hover: the pointed-at line thickens slightly and its point surfaces;
         * the others fade back. The colour is restated rather than changed, so
         * the series stays the one the legend named.
         */
        const emphasis = {
          focus: "series" as const,
          lineStyle: { color: c, width: s.dashed ? 2 : 2.75 },
        };
        const blur = { lineStyle: { opacity: 0.25 }, areaStyle: { opacity: 0.08 } };
        return s.dashed
          ? {
              name: s.name,
              type: "line" as const,
              data: s.data,
              smooth: true,
              symbol: "none",
              lineStyle: { color: c, width: 1.5, type: "dashed" as const },
              itemStyle: { color: c },
              emphasis,
              blur,
            }
          : {
              name: s.name,
              type: "line" as const,
              data: s.data,
              smooth: true,
              symbol: "circle",
              symbolSize: 6,
              showSymbol: false,
              lineStyle: { color: c, width: 2 },
              itemStyle: { color: c },
              // A ring in the card colour lifts the hovered point off its own line.
              emphasis: {
                ...emphasis,
                scale: 1.5,
                itemStyle: { color: c, borderColor: t.card, borderWidth: 2 },
              },
              blur,
              areaStyle: {
                color: {
                  type: "linear" as const,
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: hexA(c, 0.28) },
                    { offset: 1, color: hexA(c, 0) },
                  ],
                },
              },
            };
      }),
    };
  }, [categories, series, t, valueFormatter, legend]);

  if (!categories.length || !hasPlottableData(series)) {
    return <ChartEmpty height={height} className={className} message={emptyMessage} />;
  }
  return <EChart option={option} height={height} className={className} notMerge />;
}

/** Grouped vertical bar chart with rounded caps. */
export function BarChart({
  categories,
  series,
  height = 280,
  className,
  valueFormatter,
  showLegend,
  emptyMessage,
}: CartesianProps) {
  const t = useChartTokens();
  const legend = showLegend ?? series.length > 1;

  const option = React.useMemo<EChartsOption>(() => {
    /*
     * One series across categories composes a whole — stores making up the
     * month, stages making up the funnel — so each bar's share of it is a real
     * answer and the tooltip carries it. Two series side by side do not: the
     * share of (revenue + target) means nothing, so none is shown.
     */
    const shareTotal =
      series.length === 1
        ? series[0].data.reduce<number>((sum, v) => sum + Math.abs(Number(v) || 0), 0)
        : 0;
    return {
      legend: legend ? { show: true } : { show: false },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        // The axis label truncates long store names; the tooltip carries the
        // whole one, which is the only place a reader can still read it.
        formatter: axisTooltipFormatter({ format: valueFormatter, shareTotal }),
      },
      xAxis: {
        type: "category",
        data: categories,
        ...hairlineAxis(t),
        /*
         * Every category gets its label. ECharts defaults to
         * `interval: "auto"`, which drops labels that would overlap — so a
         * chart with long names rendered bars with blank positions beneath
         * them and looked like missing data. Truncating is honest; hiding is
         * not. `hideOverlap` lets ECharts stagger rather than silently drop.
         */
        axisLabel: {
          ...hairlineAxis(t).axisLabel,
          interval: 0,
          hideOverlap: false,
          width: 92,
          overflow: "truncate",
          ellipsis: "…",
        },
      },
      yAxis: {
        type: "value",
        ...hairlineAxis(t),
        splitLine: splitHairline(t),
        axisLabel: {
          color: t.muted,
          fontSize: 12,
          fontFamily: t.fontSans,
          formatter: valueFormatter ? (v: number) => valueFormatter(v) : undefined,
        },
      },
      series: series.map((s, i) => {
        const c = s.color ?? t.palette[i % t.palette.length];
        return {
          name: s.name,
          type: "bar" as const,
          data: s.data,
          barMaxWidth: 28,
          barGap: "30%",
          itemStyle: {
            color: c,
            borderRadius: [6, 6, 0, 0] as [number, number, number, number],
          },
          /*
           * Hover lifts the bar off the plot with its own colour cast as a soft
           * shadow and fades the sibling series back. Restating the colour
           * matters: ECharts' default emphasis brightens the fill, and on a
           * revenue-vs-target pair the brightened target read as a third series.
           */
          emphasis: {
            focus: "series" as const,
            itemStyle: { color: c, shadowBlur: 10, shadowColor: hexA(c, 0.4), shadowOffsetY: -1 },
          },
          blur: { itemStyle: { opacity: 0.3 } },
        };
      }),
    };
  }, [categories, series, t, valueFormatter, legend]);

  if (!categories.length || !hasPlottableData(series)) {
    return <ChartEmpty height={height} className={className} message={emptyMessage} />;
  }
  return <EChart option={option} height={height} className={className} notMerge />;
}

export interface DonutDatum {
  name: string;
  value: number;
  color?: string;
}

interface DonutProps {
  data: DonutDatum[];
  height?: number | string;
  className?: string;
  valueFormatter?: (v: number) => string;
  /** Optional centred label (e.g. total). */
  centerLabel?: string;
  centerValue?: string;
  showLegend?: boolean;
  /** What the chart is waiting for, shown in place of an empty ring. */
  emptyMessage?: string;
}

/** Donut chart — thin ring, hairline gaps, optional centred figure. */
export function DonutChart({
  data,
  height = 280,
  className,
  valueFormatter,
  centerLabel,
  centerValue,
  showLegend = true,
  emptyMessage,
}: DonutProps) {
  const t = useChartTokens();

  const option = React.useMemo<EChartsOption>(() => {
    return {
      tooltip: {
        trigger: "item",
        /*
         * Name, value and share, spelled out.
         *
         * `valueFormatter` alone formats the number but leaves the rest to
         * ECharts' default pie template, so a segment could report a bare
         * figure with no indication of what share of the whole it was — the
         * one thing a reader wants from a pie. The marker dot is reused from
         * the series colour so the row is identifiable at a glance.
         */
        formatter: (p: unknown) => {
          const d = p as { marker?: string; name?: string; value?: number; percent?: number };
          const value = valueFormatter
            ? valueFormatter(Number(d.value ?? 0))
            : String(d.value ?? "");
          const share =
            typeof d.percent === "number"
              ? `<span style="opacity:0.7;margin-left:6px">${d.percent.toFixed(1)}%</span>`
              : "";
          return tooltipRow(d.marker ?? "", d.name ?? "", value, share);
        },
      },
      legend: showLegend
        ? { show: true, orient: "vertical", left: 0, top: "center", itemGap: 12 }
        : { show: false },
      series: [
        {
          type: "pie",
          radius: ["58%", "78%"],
          center: showLegend ? ["62%", "50%"] : ["50%", "50%"],
          avoidLabelOverlap: true,
          padAngle: 2,
          itemStyle: { borderColor: t.card, borderWidth: 2, borderRadius: 4 },
          /*
           * Hover grows the slice a few pixels outwards and dims its siblings.
           * `scaleSize` is kept small on purpose: the ring is thin, and a large
           * lift makes the whole donut appear to change size on every pass of
           * the mouse. The slice keeps its own colour.
           */
          emphasis: {
            focus: "self" as const,
            scale: true,
            scaleSize: 5,
            itemStyle: { shadowBlur: 12, shadowColor: hexA(t.foreground, 0.18) },
          },
          blur: { itemStyle: { opacity: 0.4 } },
          label:
            centerLabel || centerValue
              ? {
                  show: true,
                  position: "center",
                  formatter: () =>
                    `{v|${centerValue ?? ""}}\n{l|${centerLabel ?? ""}}`,
                  rich: {
                    v: {
                      fontFamily: t.fontSerif,
                      fontSize: 24,
                      fontWeight: 600,
                      color: t.foreground,
                      lineHeight: 30,
                    },
                    l: {
                      fontFamily: t.fontSans,
                      fontSize: 11,
                      color: t.muted,
                      letterSpacing: 1,
                    },
                  },
                }
              : { show: false },
          labelLine: { show: false },
          data: data.map((d, i) => ({
            name: d.name,
            value: d.value,
            itemStyle: { color: d.color ?? t.palette[i % t.palette.length] },
          })),
        },
      ],
    };
  }, [data, t, valueFormatter, centerLabel, centerValue, showLegend]);

  if (!data.some((d) => Math.abs(Number(d.value) || 0) > 0)) {
    return <ChartEmpty height={height} className={className} message={emptyMessage} />;
  }
  return <EChart option={option} height={height} className={className} notMerge />;
}

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */

/**
 * Hover lift for a mark that owns its colour — a highlighted peak hour, a step
 * on the aging ramp — where recolouring on emphasis would destroy the one thing
 * the colour was saying.
 *
 * Exported because the three hand-built bar charts each reached for
 * `shadowColor: t.border` and got no hover feedback at all: `--border` is a
 * near-white hairline (#e9e9e7 light / a dark hairline in dark mode), so the
 * shadow was the same colour as the card it was cast on. Casting the page's own
 * ink at low alpha reads in both themes.
 */
export function emphasisShadow(t: ChartTokens, alpha = 0.22) {
  return { shadowBlur: 8, shadowColor: hexA(t.foreground, alpha) };
}

/**
 * Apply an alpha to a colour string for gradient stops. Supports #rgb/#rrggbb
 * and otherwise wraps the colour in a CSS color-mix with transparent, which
 * works for oklch()/named colours resolved from CSS variables.
 */
function hexA(color: string, alpha: number): string {
  const c = color.trim();
  if (/^#([0-9a-f]{3})$/i.test(c)) {
    const r = c[1] + c[1];
    const g = c[2] + c[2];
    const b = c[3] + c[3];
    return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
  }
  if (/^#([0-9a-f]{6})$/i.test(c)) {
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // rgb()/rgba() — the form our token resolver returns. Re-emit with alpha.
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const [r, g, b] = m[1].split(",").map((p) => p.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `color-mix(in oklab, ${c} ${Math.round(alpha * 100)}%, transparent)`;
}
