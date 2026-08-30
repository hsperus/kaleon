import type { Metadata } from "next";
import { Roles } from "../../marketing/roles.js";

export const metadata: Metadata = {
  title: "Roller · KAELON",
  description:
    "Yetki bir ekran gizleme ayarı değil: rolün göremediği araç modele hiç " +
    "gönderilmez.",
};

export default function Page() {
  return <Roles />;
}
