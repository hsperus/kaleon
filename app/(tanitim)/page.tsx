import type { Metadata } from "next";
import { Hero } from "../marketing/hero.js";
import { Capabilities } from "../marketing/capabilities.js";
import { Why, Cta } from "../marketing/why.js";

export const metadata: Metadata = {
  title: "KAELON · Şirketinize sorabilirsiniz",
  description:
    "Türk imalat sanayii için AI-native operasyonel işletim sistemi. " +
    "ERP’nin aylarca süren kurulumu, yüzlerce ekranı yok: soruyu yazın, " +
    "işinizin her köşesi tek cümleyle önünüzde.",
};

/*
 * ANA SAYFA KISALDI, İÇERİK KAYBOLMADI.
 *
 * Önce beş bölüm arka arkaya diziliydi: yetenekler, geçiş, mevzuat,
 * roller. Hepsi doğru bilgiydi ama ziyaretçi ilk ekranda ne olduğunu
 * anlamadan dört bölüm daha kaydırıyordu ve asıl iddia — "sorarsınız,
 * cevap gelir" — kalabalıkta kayboluyordu.
 *
 * Artık ana sayfa üç şey söylüyor: ne olduğu, nasıl cevap verdiği,
 * neden güvenilir olduğu. Mevzuat, roller ve geçiş kendi sayfalarında
 * duruyor ve ayaktan erişiliyor — arayan bulur, aramayan boğulmaz.
 */
export default function Page() {
  return (
    <>
      <Hero />
      <Capabilities />
      <Why />
      <Cta />
    </>
  );
}
