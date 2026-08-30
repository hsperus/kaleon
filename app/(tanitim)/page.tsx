import type { Metadata } from "next";
import { Hero } from "../marketing/hero.js";

export const metadata: Metadata = {
  title: "KAELON · Soruyorsunuz, cevap geliyor",
  description:
    "Türk imalat sanayii için AI-native operasyonel işletim sistemi. Menü yok, " +
    "modül yok, danışman yok.",
};

export default function Page() {
  return <Hero />;
}
