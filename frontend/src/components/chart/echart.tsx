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
  return {
    resolve(varName: string, fallback: string) {
      probe.style.color = "";
      probe.style.color = `var(${varName})`;
      const rgb = getComputedStyle(probe).color;
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

  React.useEffect(() => {
    // Defer a frame so CSS variables reflect the new `.dark` class.
    const id = requestAnimationFrame(() => setTokens(resolveTokens()));
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme]);

  return tokens;
}

/* ------------------------------------------------------------------ */
/* Base building blocks                                                */
/* ------------------------------------------------------------------ */

/** Shared base option carrying the luxury-minimal look (axes, tooltip, text). */
export function baseOption(t: ChartTokens): EChartsOption {
  return {
    color: t.palette,
    textStyle: { fontFamily: t.fontSans, color: t.foreground },
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    legend: {
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      top: 0,
      right: 0,
      textStyle: { color: t.muted, fontSize: 12, fontFamily: t.fontSans },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: t.popover,
      borderColor: t.border,
      borderWidth: 1,
      padding: [8, 12],
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

  const merged = React.useMemo<EChartsOption>(() => {
    const base = baseOption(tokens);
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
  }, [tokens, option]);

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
  message?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg text-sm text-muted-foreground",
        className,
      )}
      style={{ height }}
    >
      {message}
    </div>
  );
}

/** True when at least one series carries a non-zero value worth plotting. */
function hasPlottableData(series: { data: number[] }[]): boolean {
  return series.some((s) => s.data.some((v) => Math.abs(Number(v) || 0) > 0));
}

/** A named numeric series for the cartesian presets. */
export interface ChartSeries {
  name: string;
  data: number[];
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
}: CartesianProps) {
  const t = useChartTokens();
  const legend = showLegend ?? series.length > 1;

  const option = React.useMemo<EChartsOption>(() => {
    return {
      legend: legend ? { show: true } : { show: false },
      tooltip: valueFormatter
        ? { valueFormatter: (v) => valueFormatter(Number(v)) }
        : {},
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
        return s.dashed
          ? {
              name: s.name,
              type: "line" as const,
              data: s.data,
              smooth: true,
              symbol: "none",
              lineStyle: { color: c, width: 1.5, type: "dashed" as const },
              itemStyle: { color: c },
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
    return <ChartEmpty height={height} className={className} />;
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
}: CartesianProps) {
  const t = useChartTokens();
  const legend = showLegend ?? series.length > 1;

  const option = React.useMemo<EChartsOption>(() => {
    return {
      legend: legend ? { show: true } : { show: false },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        ...(valueFormatter ? { valueFormatter: (v) => valueFormatter(Number(v)) } : {}),
      },
      xAxis: { type: "category", data: categories, ...hairlineAxis(t) },
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
      series: series.map((s, i) => ({
        name: s.name,
        type: "bar" as const,
        data: s.data,
        barMaxWidth: 28,
        barGap: "30%",
        itemStyle: {
          color: s.color ?? t.palette[i % t.palette.length],
          borderRadius: [6, 6, 0, 0] as [number, number, number, number],
        },
      })),
    };
  }, [categories, series, t, valueFormatter, legend]);

  if (!categories.length || !hasPlottableData(series)) {
    return <ChartEmpty height={height} className={className} />;
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
}: DonutProps) {
  const t = useChartTokens();

  const option = React.useMemo<EChartsOption>(() => {
    return {
      tooltip: {
        trigger: "item",
        ...(valueFormatter ? { valueFormatter: (v) => valueFormatter(Number(v)) } : {}),
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
    return <ChartEmpty height={height} className={className} />;
  }
  return <EChart option={option} height={height} className={className} notMerge />;
}

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */

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
