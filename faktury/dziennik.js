// backend/faktury/dziennik.js
// Trwałe wykonanie: dziennik FakturyMiesieczne i blokada globalna.
//
// Dwa rodzaje wierszy w FakturyMiesieczne (pole `rodzaj`):
//
//  FAKTURA    — jedna operacja = jedna (planowana) faktura.
//               _id = operationId = hash(miesiąc, contactId,
//               posortowane orderIds). Powtórzenie tej samej grupy
//               trafia w ten sam wiersz.
//
//  ZAMOWIENIE — przypisanie zamówienia do operacji.
//               _id = hash(orderId), niezależnie od miesiąca.
//               Wix odrzuca insert z istniejącym _id, więc jedno
//               zamówienie może należeć tylko do jednej operacji.
//
// Wiersze październikowe (bez `rodzaj`, klucz v1) pozostają nietknięte.
//
// Każdy zapis: kopia -> update -> odczyt potwierdzający.
// Zmiana statusu wymaga zgodności statusu i writeToken
// (wykrywa równoległą lub ręczną zmianę wiersza).

import { randomBytes } from 'crypto';
import {
  S,
  STATUSY_PLANOWANE,
  claimId,
  copy,
  stableId,
  zl
} from 'backend/faktury/rozliczenia';

export const RODZAJ_FAKTURA = 'FAKTURA';
export const RODZAJ_ZAMOWIENIE = 'ZAMOWIENIE';

export const LOCK_ID = stableId('toto/faktury/v2/global');
export const GENERATOR_LOCK_ID = stableId('toto/generator/global/v1');

export function blad(text, name) {
  const e = new Error(text);
  e.name = name;
  return e;
}

const token = () => randomBytes(12).toString('hex');

/**
 * @param {Object} db adapter: get, insert, update, remove, find
 * @param {Object} cfg konfiguracja miesiąca
 * @param {Object} [opts]
 */
export function createJournal(db, cfg, opts = {}) {
  const now = opts.now || (() => new Date());
  const LEDGER = cfg.kolekcje.dziennik;
  const LOCKS = cfg.kolekcje.blokady;

  async function operacje() {
    const rows = await db.find(LEDGER, {
      miesiac: cfg.miesiac,
      rodzaj: RODZAJ_FAKTURA
    });
    return new Map(rows.map(r => [r._id, r]));
  }

  async function przypisania() {
    const rows = await db.find(LEDGER, {
      miesiac: cfg.miesiac,
      rodzaj: RODZAJ_ZAMOWIENIE
    });
    return new Map(rows.map(r => [r.orderId, r]));
  }

  // Przypisania mogą pochodzić z innego miesiąca (to samo orderId),
  // dlatego dla zamówień bez przypisania w tym miesiącu sprawdzamy
  // też deterministyczne _id.
  async function przypisaniaDla(orderIds) {
    const map = await przypisania();
    const brak = orderIds.filter(id => !map.has(id));

    const odczyty = await Promise.all(
      brak.map(id => db.get(LEDGER, claimId(id)))
    );

    odczyty.forEach(r => {
      if (r) map.set(r.orderId, r);
    });

    return map;
  }

  async function operacjeDla(przyp) {
    const map = await operacje();
    const brak = [...new Set(
      [...przyp.values()].map(c => c.operationId)
    )].filter(id => !map.has(id));

    const odczyty = await Promise.all(brak.map(id => db.get(LEDGER, id)));

    odczyty.forEach(r => {
      if (r) map.set(r._id, r);
    });

    return map;
  }

  /**
   * Zmiana stanu operacji z kontrolą statusu i writeToken.
   * Rzuca JournalConflictError albo JournalPersistenceError.
   */
  async function zmien(op, oczekiwany, patch, info) {
    const obecny = await db.get(LEDGER, op._id);

    if (!obecny) {
      throw blad(`Brak wiersza operacji ${op._id}.`, 'JournalConflictError');
    }

    const dozwolone = Array.isArray(oczekiwany) ? oczekiwany : [oczekiwany];

    if (
      !dozwolone.includes(obecny.status) ||
      (op.writeToken && obecny.writeToken !== op.writeToken)
    ) {
      throw blad(
        `Operacja ${op._id} zmieniła się (${obecny.status}); ` +
        'przerwano bez zapisu.',
        'JournalConflictError'
      );
    }

    const nastepny = copy({
      ...obecny,
      ...patch,
      writeToken: token(),
      zmieniono: now().toISOString(),
      historia: [
        ...(obecny.historia || []),
        {
          ts: now().toISOString(),
          z: obecny.status,
          na: patch.status || obecny.status,
          info: info || ''
        }
      ].slice(-50)
    });

    try {
      await db.update(LEDGER, nastepny);
    } catch (e) {
      throw blad(
        `Niepotwierdzony zapis dziennika ${op._id}: ${e?.message || e}`,
        'JournalPersistenceError'
      );
    }

    let odczyt;

    try {
      odczyt = await db.get(LEDGER, op._id);
    } catch (e) {
      throw blad(
        `Brak odczytu potwierdzającego ${op._id}: ${e?.message || e}`,
        'JournalPersistenceError'
      );
    }

    if (
      !odczyt ||
      odczyt.writeToken !== nastepny.writeToken ||
      odczyt.status !== nastepny.status ||
      (odczyt.invoiceId || '') !== (nastepny.invoiceId || '') ||
      (odczyt.invoiceVersion ?? null) !== (nastepny.invoiceVersion ?? null)
    ) {
      throw blad(
        `Zapis i odczyt dziennika różnią się (${op._id}).`,
        'JournalPersistenceError'
      );
    }

    return odczyt;
  }

  function wierszOperacji(plan, kontakt) {
    const t = now().toISOString();

    return {
      _id: plan.operationId,
      title:
        `${cfg.miesiac} | ${kontakt.fullName || plan.klient} | ` +
        `${plan.orderIds.length} zam.`,
      rodzaj: RODZAJ_FAKTURA,
      wersjaModelu: 2,
      miesiac: cfg.miesiac,
      operationKey: plan.operationId,
      klientContactId: plan.contactId,
      klientNazwa: plan.klient || kontakt.fullName,
      email: kontakt.email,
      orderIds: plan.orderIds,
      numeryZamowien: plan.numeryZamowien,
      umowaIds: plan.umowaIds || [],
      status: S.PREPARED,
      invoiceId: '',
      invoiceVersion: null,
      invoiceNumber: '',
      kwota: Number(zl(plan.razem)),
      kwotaGrosze: plan.razem,
      bruttoGrosze: plan.brutto,
      rabatyGrosze: plan.sumaRabatow,
      pozycje: plan.pozycje,
      rabaty: plan.rabaty,
      rabatFaktury: plan.rabatFaktury,
      trybRabatu: plan.trybRabatu,
      fingerprint: plan.fingerprint,
      utworzenieRozpoczete: false,
      wysylkaRozpoczeta: false,
      proby: 0,
      powodPrzegladu: '',
      blad: '',
      przygotowano: t,
      zatwierdzono: null,
      utworzono: null,
      wyslano: null,
      writeToken: token(),
      historia: [{ ts: t, z: '', na: S.PREPARED, info: 'PREPARE' }]
    };
  }

  /**
   * Zapis PREPARED + przypisania zamówień. Idempotentne:
   * ponowne wywołanie uzupełnia brakujące przypisania.
   */
  async function przygotuj(plan, kontakt) {
    for (const orderId of plan.orderIds) {
      const c = await db.get(LEDGER, claimId(orderId));

      if (c && c.operationId !== plan.operationId) {
        throw blad(
          `Zamówienie ${orderId} jest już przypisane do operacji ` +
          `${c.operationId}.`,
          'ClaimConflictError'
        );
      }
    }

    let op = await db.get(LEDGER, plan.operationId);

    if (!op) {
      await db.insert(LEDGER, wierszOperacji(plan, kontakt));
      op = await db.get(LEDGER, plan.operationId);

      if (!op) {
        throw blad('Wiersz operacji nie został zapisany.', 'JournalPersistenceError');
      }
    } else if (op.status === S.CANCELLED && !op.utworzenieRozpoczete) {
      const nowy = wierszOperacji(plan, kontakt);
      op = await zmien(op, S.CANCELLED, {
        ...nowy,
        historia: undefined,
        writeToken: undefined
      }, 'Ponowne przygotowanie po anulowaniu');
    } else if (op.status !== S.PREPARED) {
      return { op, pominieto: `Operacja ma status ${op.status}.` };
    } else if (op.fingerprint !== plan.fingerprint) {
      throw blad(
        'Istniejąca operacja PREPARED ma inny fingerprint — anuluj ją i przygotuj ponownie.',
        'ClaimConflictError'
      );
    }

    for (const orderId of plan.orderIds) {
      const id = claimId(orderId);

      if (await db.get(LEDGER, id)) continue;

      try {
        await db.insert(LEDGER, {
          _id: id,
          title: `${cfg.miesiac} | zamówienie ${orderId}`,
          rodzaj: RODZAJ_ZAMOWIENIE,
          wersjaModelu: 2,
          miesiac: cfg.miesiac,
          orderId,
          klientContactId: plan.contactId,
          operationId: plan.operationId,
          status: 'PRZYPISANE',
          przypisano: now().toISOString()
        });
      } catch (e) {
        const c = await db.get(LEDGER, id);

        if (!c || c.operationId !== plan.operationId) {
          throw blad(
            `Nie przypisano zamówienia ${orderId}: ${e?.message || e}`,
            'ClaimConflictError'
          );
        }
      }
    }

    return { op: await db.get(LEDGER, plan.operationId) };
  }

  // Anulowanie dozwolone wyłącznie, gdy nigdy nie rozpoczęto
  // tworzenia faktury. Zwalnia przypisania zamówień.
  async function anuluj(op, info) {
    if (op.utworzenieRozpoczete || op.invoiceId) {
      throw blad(
        'Nie można anulować: tworzenie faktury było rozpoczęte.',
        'ReviewError'
      );
    }

    const nowy = await zmien(
      op,
      [...STATUSY_PLANOWANE, S.NEEDS_REVIEW],
      { status: S.CANCELLED },
      info || 'Anulowano'
    );

    for (const orderId of op.orderIds) {
      const c = await db.get(LEDGER, claimId(orderId));
      if (c?.operationId === op._id) await db.remove(LEDGER, c._id);
    }

    return nowy;
  }

  // ======================================================
  // BLOKADA (wzorzec z generatorUmow.js — bez automatycznego
  // przejmowania starych blokad)
  // ======================================================

  const stara = l => {
    const t = new Date(l?._createdDate || l?.utworzono).getTime();
    return Number.isFinite(t) && now().getTime() - t > cfg.blokadaWaznoscMs;
  };

  async function zablokuj(opis) {
    if (await db.get(LOCKS, GENERATOR_LOCK_ID)) {
      throw blad(
        'Trwa praca generatora cykli. Spróbuj po jej zakończeniu.',
        'BusyError'
      );
    }

    const t = token();

    try {
      await db.insert(LOCKS, {
        _id: LOCK_ID,
        title: `Faktury ${cfg.miesiac} ${opis || ''}`.trim(),
        token: t,
        utworzono: now().toISOString()
      });
    } catch (e) {
      const istniejaca = await db.get(LOCKS, LOCK_ID);

      if (!istniejaca) throw e;

      if (stara(istniejaca)) {
        throw blad(
          'Blokada fakturowania starsza niż 5 minut — poprzednie wywołanie ' +
          'mogło zostać przerwane. Sprawdź dziennik i użyj zwolnijBlokade().',
          'LockReviewError'
        );
      }

      throw blad(
        'Trwa inne uruchomienie fakturowania. Poczekaj na jego zakończenie.',
        'BusyError'
      );
    }

    const potwierdzenie = await db.get(LOCKS, LOCK_ID);

    if (potwierdzenie?.token !== t) {
      throw blad('Nie potwierdzono blokady.', 'BusyError');
    }

    return {
      token: t,

      async pilnuj() {
        const l = await db.get(LOCKS, LOCK_ID);

        if (l?.token !== t || stara(l)) {
          throw blad('Utracono blokadę fakturowania.', 'LockLostError');
        }
      },

      async zwolnij() {
        const l = await db.get(LOCKS, LOCK_ID);
        if (l?.token === t) await db.remove(LOCKS, LOCK_ID);
      }
    };
  }

  async function zwolnijStara() {
    const l = await db.get(LOCKS, LOCK_ID);

    if (!l) return { status: 'BRAK_BLOKADY' };

    if (!stara(l)) {
      return {
        status: 'AKTYWNA',
        uwaga: 'Blokada młodsza niż 5 minut — może trwać uruchomienie.'
      };
    }

    await db.remove(LOCKS, LOCK_ID);
    return { status: 'ZWOLNIONA', token: l.token, utworzono: l.utworzono };
  }

  return {
    operacje,
    przypisania,
    przypisaniaDla,
    operacjeDla,
    operacja: id => db.get(LEDGER, id),
    zmien,
    przygotuj,
    anuluj,
    zablokuj,
    zwolnijStara
  };
}
