import { redirect } from "next/navigation";

/**
 * Bölümler tek akışa döndü; eski adres kendi çapasına götürür.
 * Paylaşılmış linkler kırılmasın diye burada duruyor.
 */
export default function Page(): never {
  redirect("/#roller");
}
