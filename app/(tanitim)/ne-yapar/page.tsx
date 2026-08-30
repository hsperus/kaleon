import type { Metadata } from "next";
import { Capabilities } from "../../marketing/capabilities.js";

export const metadata: Metadata = {
  title: "Ne yapar · KAELON",
  description:
    "Bilanço, amortisman, bordro, izleme. Her soru kendi biçiminde cevaplanır: " +
    "belge, tablo, grafik ya da onay formu.",
};

export default function Page() {
  return <Capabilities />;
}
