"use client";

/**
 * Belgenin grafik sekmesi.
 *
 * GRAFİK ÇİZİLEMİYORSA SEBEBİ YAZILIR. Boş bir kutu göstermek
 * kullanıcıya "grafik yok" değil "sistem bozuk" dedirtir; oysa çoğu
 * durumda veri gerçekten grafiğe uygun değildir ve bunu bilmek
 * kullanıcının işine yarar.
 */

import type { Block } from "../src/ui/markdown.js";
import { planFrom } from "../src/ui/chart-from-table.js";
import { BarChart, DonutChart, LineChart } from "./chart.js";

export function ChartPanel({
  table,
  title,
}: {
  table: Extract<Block, { kind: "table" }>;
  title: string;
}) {
  const plan = planFrom(table, title);

  if (!plan.ok) {
    return <p className="ch-refuse">{plan.reason}</p>;
  }

  return (
    <div className="ch-stack">
      {plan.specs.map((spec, i) => (
        <section key={i} className="ch-block">
          <h2 className="ch-title">{spec.title}</h2>
          {spec.kind === "bar" && <BarChart points={spec.points} unit={spec.unit ?? undefined} />}
          {spec.kind === "line" && <LineChart points={spec.points} unit={spec.unit ?? undefined} />}
          {spec.kind === "donut" && <DonutChart points={spec.points} unit={spec.unit ?? undefined} />}
          {/* Grafiğe alınmayan satır SÖYLENİR: kullanıcı tabloda gördüğü
              "Toplam" satırını grafikte bulamayınca eksik sanmasın. */}
          {spec.excluded.length > 0 && (
            <p className="ch-note">
              Toplam satır{spec.excluded.length > 1 ? "ları" : "ı"} grafiğe alınmadı (
              {spec.excluded.join(", ")}): parçalarıyla birlikte çizilseydi iki kez sayılırdı.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
