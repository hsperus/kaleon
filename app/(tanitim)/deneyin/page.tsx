import type { Metadata } from "next";
import { DemoForm } from "../../marketing/demo-form.js";

export const metadata: Metadata = {
  title: "Ürünü deneyin · KAELON",
  description:
    "Şirketinize göre kurulmuş gerçek bir ortamda deneyin. Sahte ekran değil: " +
    "kendi veritabanı şemanız, kendi verileriniz, 141 işin tamamı.",
};

export default function Page() {
  return (
    <section className="mk-sec">
      <p className="mk-eyebrow k-rise-sm">Deneyin</p>
      <h1 className="mk-h2 k-rise">
        Kendi şirketiniz için
        <br />
        <span className="dim">gerçek bir ortam.</span>
      </h1>
      <p className="mk-sub k-rise-sm">
        Bu bir tanıtım videosu ya da hazır ekran görüntüsü değil. Üç soruya
        cevap verin, size ait bir veritabanı şeması kurulsun; içinde kendi
        sektörünüzün ürünleri, kendi bilançonuz ve 141 işin tamamı olsun.
      </p>
      <DemoForm />
    </section>
  );
}
