import type { Metadata } from "next";
import { Hero } from "../marketing/hero.js";
import { Capabilities } from "../marketing/capabilities.js";
import { Law } from "../marketing/law.js";
import { Roles } from "../marketing/roles.js";

export const metadata: Metadata = {
  title: "KAELON · Soruyorsunuz, cevap geliyor",
  description:
    "Türk imalat sanayii için AI-native operasyonel işletim sistemi. Menü yok, " +
    "modül yok, danışman yok.",
};

export default function Page() {
  return (
    <>
      <Hero />
      <Capabilities />
      <Law />
      <Roles />
    </>
  );
}
