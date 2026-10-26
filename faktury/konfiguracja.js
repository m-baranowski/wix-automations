// backend/faktury/konfiguracja.js
// Konfiguracja fakturowania miesięcznego CTD Toto.
// Wartości dla listopada 2026. Kolejny miesiąc = nowy obiekt,
// bez zmian w logice.

export const KONFIGURACJA_LISTOPAD_2026 = Object.freeze({
  miesiac: '2026-11',
  tytulFaktury: 'Listopad 2026',
  temat:
    'Rachunek za listopad — Centrum Terapii Dziecięcej Toto',
  tresc:
    'Przesyłamy rachunek za listopad 2026. Dziękujemy!',
  waluta: 'PLN',
  strefaCzasowa: 'Europe/Warsaw',
  dniNaPlatnosc: 5,

  // NEGATIVE_LINE — każdy rabat jako osobna ujemna pozycja
  //   (preferowane w Toto).
  // INVOICE_DISCOUNT — suma rabatów jako rabat kwotowy faktury
  //   (zapasowo, gdyby Wix Invoices odrzucał ujemne ceny).
  trybRabatu: 'NEGATIVE_LINE',

  // false: czyste zamówienia klienta są fakturowane, nawet jeśli
  //   inne zamówienie tego klienta czeka na ręczne sprawdzenie.
  // true: cały klient czeka, aż wszystkie jego zamówienia będą jasne.
  wstrzymajKlientaPrzyPrzegladzie: false,

  // Zamówienia z kwotą 0 zł nie trafiają na faktury.
  pomijajZerowe: true,

  // Stałe z generatorUmow.js — muszą być identyczne.
  appIdRezerwacji: '13d21c63-b5ec-5912-8397-c3a5ddb27a97',

  kolekcje: Object.freeze({
    umowy: 'Umowy',
    umowyMiesiace: 'UmowyMiesiace',
    dziennik: 'FakturyMiesieczne',
    blokady: 'GeneratorBlokady'
  }),

  // Limity jednego wywołania (platforma: ok. 59 s).
  maxSekund: 30,
  minZapasMs: 12000,
  maxOperacji: 2,
  blokadaWaznoscMs: 5 * 60 * 1000
});
