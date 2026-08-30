import type { Metadata } from "next";
import { Law } from "../../marketing/law.js";

export const metadata: Metadata = {
  title: "Mevzuat · KAELON",
  description:
    "Tek Düzen Hesap Planı, VUK amortismanı, 2026 bordrosu, e-Fatura. " +
    "Ayar değil, kodun içinde ve testli.",
};

export default function Page() {
  return <Law />;
}
