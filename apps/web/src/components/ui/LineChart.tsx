import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "./cn";

export interface LineSeries {
  key: string;
  name: string;
  /** One value per label; null = no data for that position (the line breaks). */
  values: (number | null)[];
}

interface LineChartProps {
  /** Accessible name of the chart (also the table caption). */
  title: string;
  labels: string[];
  series: LineSeries[];
  /** Upper bound of the y scale (percent charts use 100). */
  yMax?: number;
  yTicks?: number[];
  format?: (v: number) => string;
  height?: number;
  className?: string;
}

/**
 * Small dependency-free SVG line chart (validated 2-slot palette for light/dark surfaces; the second series is also
 * dashed so identity never relies on colour). Hover or arrow keys move a crosshair that lists every series; the same
 * values are always available in the 「数値を表で見る」 table.
 */
const SERIES_STYLE = [
  { stroke: "stroke-[#0076d1] dark:stroke-[#3d9be8]", fill: "fill-[#0076d1] dark:fill-[#3d9be8]", dash: undefined, key: "bg-[#0076d1] dark:bg-[#3d9be8]" },
  { stroke: "stroke-[#0e9a83] dark:stroke-[#1aa88a]", fill: "fill-[#0e9a83] dark:fill-[#1aa88a]", dash: "6 4", key: "bg-[#0e9a83] dark:bg-[#1aa88a]" },
] as const;

const M = { top: 16, right: 52, bottom: 30, left: 44 };

export function LineChart({ title, labels, series, yMax = 100, yTicks = [0, 25, 50, 75, 100], format = (v) => `${Math.round(v)}%`, height = 240, className }: LineChartProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.max(280, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = series.slice(0, SERIES_STYLE.length);
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const n = labels.length;
  const x = (i: number) => M.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number) => M.top + innerH - (Math.max(0, Math.min(yMax, v)) / yMax) * innerH;

  /** Line segments split at null values. */
  const segments = (values: (number | null)[]) => {
    const out: { i: number; v: number }[][] = [];
    let cur: { i: number; v: number }[] = [];
    values.forEach((v, i) => {
      if (v === null || v === undefined) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push({ i, v });
    });
    if (cur.length) out.push(cur);
    return out;
  };

  const lastPoint = (values: (number | null)[]) => {
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v !== null && v !== undefined) return { i, v };
    }
    return null;
  };
  const ends = shown.map((s) => lastPoint(s.values));
  // End labels only when they do not collide; otherwise the legend + crosshair + table carry the values.
  const endLabelsFit = ends.every((a, i) => !a || ends.every((b, j) => j === i || !b || Math.abs(y(a.v) - y(b.v)) >= 14));

  const summary = shown
    .map((s, i) => {
      const end = ends[i];
      return end ? `${s.name}は${labels[end.i]}時点で${format(end.v)}` : `${s.name}はデータなし`;
    })
    .join("、");

  const onPointer = (e: PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setActive(best);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive((cur) => {
        if (e.key === "Home") return 0;
        if (e.key === "End") return n - 1;
        const base = cur ?? (e.key === "ArrowRight" ? -1 : n);
        return Math.max(0, Math.min(n - 1, base + (e.key === "ArrowRight" ? 1 : -1)));
      });
    } else if (e.key === "Escape") setActive(null);
  };

  const activeText =
    active === null
      ? ""
      : `${labels[active]}: ${shown.map((s) => `${s.name} ${s.values[active] === null || s.values[active] === undefined ? "データなし" : format(s.values[active] as number)}`).join("、")}`;

  return (
    <figure className={cn("m-0", className)} aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="sr-only">
        {title}
      </figcaption>
      {shown.length > 1 ? (
        <ul className="mb-2 flex flex-wrap justify-end gap-4 text-xs text-muted" aria-label="凡例">
          {shown.map((s, i) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <svg width="18" height="6" aria-hidden className="shrink-0">
                <line x1="1" y1="3" x2="17" y2="3" strokeWidth="2" strokeLinecap="round" strokeDasharray={SERIES_STYLE[i]?.dash} className={SERIES_STYLE[i]?.stroke} />
              </svg>
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}
      <div
        ref={box}
        className="relative rounded-md"
        tabIndex={0}
        role="group"
        aria-roledescription="折れ線グラフ"
        aria-label={`${title}。${summary}。左右の矢印キーで各月の値を確認できます。`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-full" aria-hidden>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} className="stroke-line" strokeWidth={1} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
                {format(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) => (
            <text key={l} x={x(i)} y={height - 8} textAnchor="middle" className="fill-muted text-[11px]">
              {l}
            </text>
          ))}
          {shown.map((s, si) => {
            const style = SERIES_STYLE[si];
            return segments(s.values).map((seg, k) => {
              const d = seg.map((p, j) => `${j ? "L" : "M"}${x(p.i)},${y(p.v)}`).join(" ");
              const first = seg[0] as { i: number; v: number };
              const last = seg[seg.length - 1] as { i: number; v: number };
              const area = `${d} L${x(last.i)},${y(0)} L${x(first.i)},${y(0)} Z`;
              return (
                <g key={`${s.key}-${k}`}>
                  {si === 0 && seg.length > 1 ? <path d={area} className={cn(style?.fill, "opacity-10")} /> : null}
                  <path d={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={style?.dash} className={style?.stroke} />
                  {seg.map((p) => (
                    <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={4} className={cn(style?.fill, "stroke-surface")} strokeWidth={2} />
                  ))}
                </g>
              );
            });
          })}
          {endLabelsFit
            ? ends.map((e, i) =>
                e ? (
                  <text key={shown[i]?.key} x={x(e.i) + 8} y={y(e.v)} dy="0.32em" className="fill-fg text-[11px] font-bold tabular-nums">
                    {format(e.v)}
                  </text>
                ) : null,
              )
            : null}
          {active !== null ? <line x1={x(active)} x2={x(active)} y1={M.top} y2={M.top + innerH} className="stroke-muted" strokeWidth={1} /> : null}
          <rect
            x={M.left - 12}
            y={M.top}
            width={innerW + 24}
            height={innerH}
            fill="transparent"
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {active !== null ? (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[140px] rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-lg"
            style={x(active) > width / 2 ? { right: width - x(active) + 10 } : { left: x(active) + 10 }}
          >
            <p className="mb-1 text-muted">{labels[active]}</p>
            {shown.map((s, i) => (
              <p key={s.key} className="flex items-center gap-2">
                <svg width="14" height="6" aria-hidden className="shrink-0">
                  <line x1="1" y1="3" x2="13" y2="3" strokeWidth="2" strokeDasharray={SERIES_STYLE[i]?.dash} className={SERIES_STYLE[i]?.stroke} />
                </svg>
                <b className="tabular-nums">{s.values[active] === null || s.values[active] === undefined ? "—" : format(s.values[active] as number)}</b>
                <span className="text-muted">{s.name}</span>
              </p>
            ))}
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {activeText}
        </p>
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-primary">数値を表で見る</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">{title}（表）</caption>
            <thead>
              <tr className="bg-surface-2">
                <th scope="col" className="px-2 py-1.5 text-left font-medium text-muted">
                  月
                </th>
                {shown.map((s) => (
                  <th key={s.key} scope="col" className="px-2 py-1.5 text-right font-medium text-muted">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={l} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-2 py-1.5 text-left font-normal">
                    {l}
                  </th>
                  {shown.map((s) => (
                    <td key={s.key} className="px-2 py-1.5 text-right tabular-nums">
                      {s.values[i] === null || s.values[i] === undefined ? "データなし" : format(s.values[i] as number)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
