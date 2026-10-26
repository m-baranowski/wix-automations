// backend/fakturyListopad.js
// Fakturowanie LISTOPAD 2026 — punkty wejścia dla administratora.
//
// Kod w backend/faktury/:
//   rozliczenia.js   — logika rozliczeń (czysta, testowana)
//   dziennik.js      — dziennik FakturyMiesieczne + blokada
//   integracjaWix.js — jedyne miejsce wywołań API Wix
//   proces.js        — tryby PREVIEW / PREPARE / APPROVE / RUN
//
// Kolejność pracy (szczegóły: docs/FAKTURY_LISTOPAD_2026.md):
//   1. podgladFaktur()                    — tylko odczyt
//   2. przygotujFaktury()                 — zapis PREPARED w dzienniku
//   3. zatwierdzFaktury({ wszystkie: true, oczekiwanaLiczba, oczekiwanaSuma })
//   4. wykonajFaktury({ maxOperacji: 1, etap: 'UTWORZ' })  — pierwsza próba
//   5. wykonajFaktury({ maxOperacji: 2 })  — kolejne partie, aż do końca
//   6. statusFaktur() / rozstrzygnijFakture(...) — kontrola i stany niepewne
//
// Żadna funkcja nie tworzy ani nie zmienia zamówień, harmonogramów,
// płatności ani istniejących faktur.

import { createGateway } from 'backend/faktury/integracjaWix';
import { createJournal } from 'backend/faktury/dziennik';
import { createProcess } from 'backend/faktury/proces';
import { KONFIGURACJA_LISTOPAD_2026 } from 'backend/faktury/konfiguracja';

const cfg = KONFIGURACJA_LISTOPAD_2026;

function proces() {
  const gateway = createGateway(cfg);
  const journal = createJournal(gateway.db, cfg);
  return createProcess({ gateway, journal, cfg });
}

/** PREVIEW: pobiera dane, łączy, liczy, wykrywa wyjątki. Nic nie zapisuje. */
export function podgladFaktur(opcje = {}) {
  return proces().podglad(opcje);
}

/** PREPARE: zapisuje plan faktur (PREPARED) i przypisania zamówień. */
export function przygotujFaktury(opcje = {}) {
  return proces().przygotuj(opcje);
}

/**
 * APPROVE: decyzja administratora.
 * @param {{wszystkie?: boolean, operationIds?: string[],
 *          oczekiwanaLiczba: number, oczekiwanaSuma: string}} opcje
 */
export function zatwierdzFaktury(opcje = {}) {
  return proces().zatwierdz(opcje);
}

/**
 * RUN: tworzy i wysyła wyłącznie zatwierdzone faktury, małymi partiami.
 * @param {{maxOperacji?: number, maxSekund?: number,
 *          etap?: 'OBA'|'UTWORZ'|'WYSLIJ', operationIds?: string[]}} opcje
 */
export function wykonajFaktury(opcje = {}) {
  return proces().wykonaj(opcje);
}

export function statusFaktur() {
  return proces().status();
}

/**
 * Rozstrzygnięcie stanu NEEDS_REVIEW (decyzja administratora).
 * @param {{operationId: string, decyzja: string, invoiceId?: string,
 *          uwagi?: string, potwierdzam?: boolean}} opcje
 */
export function rozstrzygnijFakture(opcje = {}) {
  return proces().rozstrzygnij(opcje);
}

export function zwolnijBlokadeFaktur(opcje = {}) {
  return proces().zwolnijBlokade(opcje);
}

// Akcja „Run Velo Code” w automatyzacji — wyłącznie PREVIEW.
// RUN nie jest podpięty pod automatyzacje: powtórzenie wyzwalacza
// nie może uruchomić wystawiania faktur.
export const invoke = async () => {
  const r = await podgladFaktur();
  console.log('FAKTURY_PREVIEW_AUTOMATYZACJA', JSON.stringify(r.sumy));
  return {};
};
