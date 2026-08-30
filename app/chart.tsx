"use client";

/**
 * Grafikler — SVG, kütüphanesiz.
 *
 * HAZIR GRAFİK KÜTÜPHANESİ ALINMADI. Üçü de aynı sebeple elendi:
 * paket boyutu (en küçüğü bile bu uygulamanın tamamı kadar),
 * tema uyumu (renkleri kendi paletlerinden alırlar) ve en önemlisi
 * BİLİNMEYEN DEĞER DAVRANIŞI — çoğu `null`'ı sıfır çizer ve o sıfır,
 * "o ay satış yok" diye okunur. Buradaki geometri `src/ui/chart.ts`
 * içinde ve test edilmiş durumda.
 *
 * GRAFİK VERİYİ SÜSLEMEZ, OKUNUR KILAR. Her grafiğin altında sayılar
 * da durur: grafik bir bakışta karşılaştırmak, sayı ise kesin değeri
 * okumak içindir ve ikisi birbirinin yerine geçmez.
 */

import { useId, useState } from "react";
import {
  barLayout,
  donutSlices,
  lineSegments,
  ratio,
  scaleFor,
  type Point,
} from "../src/ui/chart.js";

const nf = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });

/** Eksen etiketleri için kısa biçim: 25.200.000 → 25,2 mn */
export function short(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${nf.format(Math.round(n / 1e8) / 10)} mr`;
  if (a >= 1e6) return `${nf.format(Math.round(n / 1e5) / 10)} mn`;
  if (a >= 1e4) return `${nf.format(Math.round(n / 1e2) / 10)} b`;
  return nf.format(n);
}

/**
 * Dilim renkleri.
 *
 * Tek vurgu renginin tonları — rastgele altı renk, hangi dilimin daha
 * önemli olduğu konusunda yanlış bir işaret verirdi. Kritik/uyarı
 * renkleri buraya girmez; onlar ANLAM taşır.
 */
const SLICE_VARS = [
  "var(--accent)",
  "color-mix(in oklab, var(--accent) 74%, var(--surface))",
  "color-mix(in oklab, var(--accent) 54%, var(--surface))",
  "color-mix(in oklab, var(--accent) 38%, var(--surface))",
  "color-mix(in oklab, var(--accent) 26%, var(--surface))",
  "color-mix(in oklab, var(--accent) 16%, var(--surface))",
];

interface Common {
  readonly points: readonly Point[];
  /** Eksen ve ipucu için birim: "TL", "adet", "%" … */
  readonly unit?: string | undefined;
  readonly height?: number | undefined;
}

function fmt(v: number, unit?: string | undefined): string {
  return unit ? `${nf.format(v)} ${unit}` : nf.format(v);
}

/** Grafiğin altındaki kesin değer şeridi. */
function Readout({
  label,
  value,
  unit,
}: {
  label: string | null;
  value: number | null;
  unit?: string | undefined;
}) {
  return (
    <div className="ch-readout" aria-live="polite">
      {label === null || value === null ? (
        <span className="ch-hint">Değer için üzerine gelin</span>
      ) : (
        <>
          <b>{label}</b>
          <span>{fmt(value, unit)}</span>
        </>
      )}
    </div>
  );
}

export function BarChart({ points, unit, height = 168 }: Common) {
  // Çubuk grafikte taban HER ZAMAN sıfır — oran yanılgısını engeller.
  const scale = scaleFor(points.map((p) => p.value), { includeZero: true });
  const bars = barLayout(points, scale);
  const zeroY = (1 - ratio(0, scale)) * 100;
  const [hot, setHot] = useState<number | null>(null);
  const id = useId();

  const missing = points.filter((p) => p.value === null).length;

  return (
    <figure className="ch">
      <div className="ch-plot" style={{ height }}>
        <div className="ch-axis" aria-hidden="true">
          {scale.ticks.map((t) => (
            <div key={t} className="ch-tick" style={{ bottom: `${ratio(t, scale) * 100}%` }}>
              <span>{short(t)}</span>
              <i className={t === 0 ? "zero" : ""} />
            </div>
          ))}
        </div>
        <svg
          className="ch-svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={`${id}-t`}
        >
          <title id={`${id}-t`}>
            {points.length} değerli çubuk grafik
            {missing > 0 ? `, ${missing} değer bilinmiyor` : ""}
          </title>
          {bars.map((b, i) => (
            <rect
              key={b.label + i}
              x={b.x}
              y={b.y}
              width={b.width}
              height={Math.max(b.height, 0.4)}
              className={`ch-bar${b.negative ? " neg" : ""}${hot === i ? " hot" : ""}`}
              onMouseEnter={() => setHot(i)}
              onMouseLeave={() => setHot(null)}
              style={{ animationDelay: `${i * 0.035}s` }}
            />
          ))}
          <line x1="0" x2="100" y1={zeroY} y2={zeroY} className="ch-zero" />
        </svg>
      </div>
      <div className="ch-labels">
        {points.map((p, i) => (
          <span
            key={p.label + i}
            className={p.value === null ? "gone" : ""}
            title={p.value === null ? "Bu değer bilinmiyor" : undefined}
          >
            {p.label}
          </span>
        ))}
      </div>
      <Readout
        label={hot === null ? null : bars[hot]?.label ?? null}
        value={hot === null ? null : bars[hot]?.value ?? null}
        unit={unit}
      />
      {/* BİLİNMEYEN GİZLENMEZ. Eksik veri grafiğin sessiz boşluğu olarak
          kalsaydı, grafiğe bakan kişi eksiği hiç fark etmezdi. */}
      {missing > 0 && (
        <figcaption className="ch-missing">{missing} değer bilinmiyor; çizilmedi.</figcaption>
      )}
    </figure>
  );
}

export function LineChart({ points, unit, height = 168 }: Common) {
  // Çizgide taban serbest: dalgalanmayı görmek asıl amaçtır.
  const scale = scaleFor(points.map((p) => p.value), { includeZero: false });
  const segs = lineSegments(points, scale);
  const [hot, setHot] = useState<{ label: string; value: number } | null>(null);
  const id = useId();
  const missing = points.filter((p) => p.value === null).length;

  return (
    <figure className="ch">
      <div className="ch-plot" style={{ height }}>
        <div className="ch-axis" aria-hidden="true">
          {scale.ticks.map((t) => (
            <div key={t} className="ch-tick" style={{ bottom: `${ratio(t, scale) * 100}%` }}>
              <span>{short(t)}</span>
              <i />
            </div>
          ))}
        </div>
        <svg className="ch-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-labelledby={`${id}-t`}>
          <title id={`${id}-t`}>{points.length} noktalı çizgi grafik</title>
          {segs.map((s, i) => (
            <polyline
              key={i}
              className="ch-line"
              points={s.points.map((q) => `${q.x},${q.y}`).join(" ")}
            />
          ))}
        </svg>
        {/* Noktalar SVG dışında: `preserveAspectRatio="none"` daireleri
            ezerdi ve ipucu hedefleri elips olurdu. */}
        <div className="ch-dots">
          {segs.flatMap((s) =>
            s.points.map((q) => (
              <button
                type="button"
                key={`${q.label}-${q.x}`}
                className="ch-dot"
                style={{ left: `${q.x}%`, top: `${q.y}%` }}
                onMouseEnter={() => setHot({ label: q.label, value: q.value })}
                onMouseLeave={() => setHot(null)}
                onFocus={() => setHot({ label: q.label, value: q.value })}
                onBlur={() => setHot(null)}
                aria-label={`${q.label}: ${fmt(q.value, unit)}`}
              />
            )),
          )}
        </div>
      </div>
      <div className="ch-labels">
        {points.map((p, i) => (
          <span key={p.label + i} className={p.value === null ? "gone" : ""}>
            {p.label}
          </span>
        ))}
      </div>
      <Readout label={hot?.label ?? null} value={hot?.value ?? null} unit={unit} />
      {missing > 0 && (
        <figcaption className="ch-missing">
          {missing} noktada veri yok; çizgi orada kopuyor.
        </figcaption>
      )}
    </figure>
  );
}

export function DonutChart({ points, unit }: Common) {
  const slices = donutSlices(points);
  const [hot, setHot] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0);

  // Negatif değer içeren veri paylara bölünemez; grafik yerine sebebi yazılır.
  if (slices.length === 0) {
    return (
      <p className="ch-refuse">
        Bu veri pay grafiğine dönüşmüyor: negatif ya da sıfır toplamlı değerler bütünün
        parçası olarak gösterilemez.
      </p>
    );
  }

  const shown = hot === null ? null : slices[hot]!;

  return (
    <figure className="ch ch-donut">
      <div className="ch-ring">
        <svg viewBox="0 0 100 100" role="img" aria-label="Pay grafiği">
          {slices.map((s, i) => (
            <path
              key={s.label}
              d={s.path}
              fill={SLICE_VARS[i % SLICE_VARS.length]}
              className={`ch-slice${hot === i ? " hot" : ""}`}
              onMouseEnter={() => setHot(i)}
              onMouseLeave={() => setHot(null)}
              style={{ animationDelay: `${i * 0.05}s` }}
            />
          ))}
        </svg>
        <div className="ch-center">
          <b>{shown ? `%${nf.format(Math.round(shown.share * 1000) / 10)}` : short(total)}</b>
          <span>{shown ? shown.label : (unit ?? "toplam")}</span>
        </div>
      </div>
      <ul className="ch-legend">
        {slices.map((s, i) => (
          <li
            key={s.label}
            onMouseEnter={() => setHot(i)}
            onMouseLeave={() => setHot(null)}
            className={hot === i ? "hot" : ""}
          >
            <i style={{ background: SLICE_VARS[i % SLICE_VARS.length] }} />
            <span>{s.label}</span>
            <b>{fmt(s.value, unit)}</b>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Küçük eğri — satır içi eğilim göstergesi. */
export function Sparkline({ values, width = 72, height = 20 }: { values: readonly (number | null)[]; width?: number; height?: number }) {
  const scale = scaleFor(values, { includeZero: false });
  const segs = lineSegments(values.map((v, i) => ({ label: String(i), value: v })), scale);
  if (segs.length === 0) return null;
  return (
    <svg className="ch-spark" width={width} height={height} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {segs.map((s, i) => (
        <polyline key={i} points={s.points.map((q) => `${q.x},${q.y}`).join(" ")} />
      ))}
    </svg>
  );
}
