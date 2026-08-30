import type { ReactNode } from "react";
import { Shell } from "../marketing/shell.js";

/** Tanıtım sayfalarının ortak kabuğu — gezinme ve ayak burada. */
export default function TanitimLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
