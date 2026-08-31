/**
 * Ayak.
 *
 * ÖNCE TEK SATIRLIK BİR MONO YAZI VARDI ve kaldırıldı: söylediği şey
 * zaten sayfanın içinde yazılıydı. Ama yerine bir şey konmadı ve
 * sayfa hiçbir yere çıkmayan bir dipte bitiyordu.
 *
 * AYAK BİR SÜS DEĞİL, İKİNCİ BİR GEZİNMEDİR. Sayfanın sonuna gelen
 * kişi ya ikna olmuştur ve nereye tıklayacağını arar, ya da bir şey
 * kaçırdığını düşünür ve geri dönecek yer arar. İkisine de burada
 * cevap veriliyor.
 *
 * OLMAYAN SAYFAYA LİNK VERİLMİYOR. Bir ayakta "Gizlilik", "İletişim",
 * "Hakkımızda" yazıp hiçbirine sayfa koymamak, ürünün geri kalanının
 * da öyle olduğunu düşündürür. Burada yalnızca gerçekten var olan
 * yerler listeleniyor.
 */

const BOLUMLER = [
  { href: "/ne-yapar", label: "Ne yapar" },
  { href: "/gecis", label: "Geçiş" },
  { href: "/mevzuat", label: "Mevzuat" },
  { href: "/roller", label: "Roller" },
];

const BASLA = [
  { href: "/deneyin", label: "Şirketinizle deneyin" },
  { href: "/uygulama", label: "Giriş" },
];

export function Footer() {
  return (
    <footer className="ft">
      <div className="ft-in">
        <div className="ft-brand">
          <span className="ft-logo">KAELON</span>
          <p>
            Türk imalat sanayii için AI-native operasyonel işletim sistemi.
            Menü öğrenmeden, Türkçe sorarak.
          </p>
        </div>

        <nav className="ft-col">
          <h3>Ürün</h3>
          {BOLUMLER.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>

        <nav className="ft-col">
          <h3>Başlayın</h3>
          {BASLA.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>

        <div className="ft-col">
          <h3>Mevzuat kapsamı</h3>
          {/*
            Bunlar link değil, KAPSAM BEYANI. Tıklanacak bir sayfa yok
            ve olmadığı hâlde link gibi göstermek yanıltıcı olurdu.
          */}
          <span>Tek Düzen Hesap Planı</span>
          <span>VUK amortismanı · e-Defter</span>
          <span>UBL-TR 1.2 e-Fatura</span>
          <span>İş Kanunu 4857 · 2026 bordrosu</span>
        </div>
      </div>

      <div className="ft-base">
        <span>© {new Date().getFullYear()} KAELON</span>
        <span className="ft-note">
          Demo ortamları 14 gün sonra silinir; iletişim bilgileriniz ayrı
          tutulur ve talebiniz üzerine silinir.
        </span>
      </div>
    </footer>
  );
}
