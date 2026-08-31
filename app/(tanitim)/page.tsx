import type { Metadata } from "next";
import { Hero } from "../marketing/hero.js";
import { Capabilities } from "../marketing/capabilities.js";
import { Migration } from "../marketing/migration.js";
import { Law } from "../marketing/law.js";
import { Roles } from "../marketing/roles.js";

export const metadata: Metadata = {
  title: "KAELON · Her şeyi bilin, hiçbir şey öğrenmeyin",
  description:
    "Türk imalat sanayii için AI-native operasyonel işletim sistemi. " +
    "Öğrenilecek menü yok: Türkçe sorun. Excel, Logo ya da SAP'ten geçiş " +
    "dosyayı sürüklemek kadar kolay.",
};

export default function Page() {
  return (
    <>
      <Hero />
      <Capabilities />
      <Migration />
      <Law />
      <Roles />
    </>
  );
}
