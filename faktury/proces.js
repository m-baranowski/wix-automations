// backend/faktury/proces.js
// Orkiestracja: PREVIEW, PREPARE, APPROVE, RUN, STATUS, rozstrzygnięcia.
// Zależności (bramka Wix, dziennik) są wstrzykiwane — testy używają atrap.
//
// Zasady:
//  - PREVIEW tylko czyta. Nie zapisuje nawet dziennika.
//  - PREPARE zapisuje wyłącznie dziennik (PREPARED + przypisania).
//  - APPROVE wymaga podania oczekiwanej sumy i liczby faktur.
//  - RUN tworzy i wysyła tylko operacje APPROVED / CREATED,
//    po ponownej weryfikacji zamówień.
//  - Przed createInvoice i sendInvoice zapisujemy stan CREATING/SENDING.
//    Pozostały CREATING/SENDING = stan niepewny -> NEEDS_REVIEW,
//    nigdy automatyczne ponowienie.

import {
  K,
  S,
  STATUSY_PLANOWANE,
  analizuj,
  grosze,
  hash,
  polaFaktury,
  sprawdzFakture,
  wierszTabeli,
  wyciagnijKontakt,
  zl
} from 'backend/faktury/rozliczenia';

const msg = e => String(e?.message || e).slice(0, 1500);

const KRYTYCZNE = [
  'JournalPersistenceError',
  'LockLostError',
  'JournalConflictError'
];

function budzet(cfg, maxSekund) {
  const sekundy = Math.min(Math.max(Number(maxSekund) || cfg.maxSekund, 5), 40);
  const koniec = Date.now() + sekundy * 1000;

  return {
    // Nie zaczynamy operacji zapisu, gdy zostało mniej niż zapas.
    wystarczy: () => koniec - Date.now() > cfg.minZapasMs,
    pozostalo: () => koniec - Date.now()
  };
}

async function rownolegle(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;

  async function worker() {
    while (i < list.length) {
      const k = i++;
      out[k] = await fn(list[k], k);
    }
  }

  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

function opisOperacji(op) {
  return {
    operationId: op._id,
    status: op.status,
    klient: op.klientNazwa,
    contactId: op.klientContactId,
    orderIds: op.orderIds,
    kwota: zl(op.kwotaGrosze || 0),
    invoiceId: op.invoiceId || '',
    invoiceVersion: op.invoiceVersion ?? null,
    powodPrzegladu: op.powodPrzegladu || '',
    blad: op.blad || '',
    utworzenieRozpoczete: Boolean(op.utworzenieRozpoczete),
    wysylkaRozpoczeta: Boolean(op.wysylkaRozpoczeta)
  };
}

function opisPlanu(p) {
  return {
    operationId: p.operationId,
    statusDziennika: p.istniejacaOperacja?.status || 'NOWA',
    klient: p.klient,
    contactId: p.contactId,
    email: p.kontakt?.email || '',
    telefon: p.kontakt?.phone || '',
    orderIds: p.orderIds,
    numeryZamowien: p.numeryZamowien,
    pozycje: p.pozycje.map(x => ({
      nazwa: x.nazwa,
      opis: x.opis,
      cena: zl(x.cena),
      ilosc: x.ilosc,
      wartosc: zl(x.cena * x.ilosc)
    })),
    rabatFaktury: zl(p.rabatFaktury),
    brutto: zl(p.brutto),
    rabaty: zl(p.sumaRabatow),
    razem: zl(p.razem),
    problemyKontaktu: p.problemyKontaktu || []
  };
}

export function createProcess({ gateway, journal, cfg, now, log }) {
  now = now || (() => new Date());
  log = log || console;

  // ======================================================
  // ODCZYT STANU
  // ======================================================

  async function wczytajStan() {
    const rows = await gateway.wierszeCykli();
    const orderIds = [...new Set(rows.map(r => r.orderId).filter(Boolean))];
    const umowaIds = [...new Set(rows.map(r => r.umowaId).filter(Boolean))];
    const klucze = rows
      .filter(r => r.umowaId)
      .map(r => `TOTO:${cfg.miesiac}:${r.umowaId}`);

    const [umowy, zamowienia, indeksKluczy, fakturyWix, transakcje] =
      await Promise.all([
        gateway.umowy(umowaIds),
        gateway.zamowienia(orderIds),
        gateway.indeksKluczy(klucze),
        gateway.fakturyZamowien(orderIds),
        gateway.transakcje(orderIds)
      ]);

    const przypisania = await journal.przypisaniaDla(orderIds);
    const operacje = await journal.operacjeDla(przypisania);

    const bledyGlobalne = [];

    if (indeksKluczy === null) {
      bledyGlobalne.push(
        'Nie sprawdzono, czy umowy nie mają dodatkowych zamówień (Search Orders).'
      );
    }

    if (fakturyWix === null) {
      bledyGlobalne.push(
        'Nie odczytano faktur powiązanych z zamówieniami (Order Invoices).'
      );
    }

    if (transakcje === null) {
      bledyGlobalne.push(
        'Nie odczytano transakcji zamówień (Order Transactions).'
      );
    }

    return {
      rows,
      umowy,
      zamowienia,
      indeksKluczy,
      fakturyWix,
      transakcje,
      przypisania,
      operacje,
      bledyGlobalne
    };
  }

  async function kontaktDla(contactId) {
    try {
      const k = wyciagnijKontakt(await gateway.kontakt(contactId));
      const problemy = [];

      if (k.contactId !== contactId) {
        problemy.push('Kontakt scalony lub inne ID — popraw dane źródłowe.');
      }

      if (!k.email) problemy.push('Kontakt bez adresu e-mail.');

      return { kontakt: k, problemy };
    } catch (e) {
      return {
        kontakt: null,
        problemy: [`Nie odczytano kontaktu: ${msg(e)}`]
      };
    }
  }

  async function analiza({ zKontaktami = true } = {}) {
    const stan = await wczytajStan();
    const a = analizuj(stan, cfg);

    if (zKontaktami) {
      await rownolegle(a.plany, 5, async p => {
        const { kontakt, problemy } = await kontaktDla(p.contactId);
        p.kontakt = kontakt;
        p.problemyKontaktu = problemy;
      });

      const emaile = new Map();

      for (const p of a.plany) {
        const e = (p.kontakt?.email || '').toLowerCase();
        if (!e) continue;
        const list = emaile.get(e) || [];
        list.push(p.contactId);
        emaile.set(e, list);
      }

      for (const [e, ids] of emaile) {
        if (ids.length > 1) {
          a.ostrzezenia.push(
            `Ten sam e-mail ${e} w ${ids.length} kontaktach ` +
            `(${ids.join(', ')}) — faktury osobne, nie łączymy.`
          );
        }
      }
    }

    return { stan, a };
  }

  function raport(tryb, a, extra = {}) {
    return {
      tryb,
      miesiac: cfg.miesiac,
      sumy: { ...a.sumy.zl, liczby: a.sumy.liczby },
      kontroleSum: a.sumy.kontrole,
      kontroleOk: a.sumy.kontroleOk,
      bledyGlobalne: a.bledyGlobalne,
      ostrzezenia: a.ostrzezenia,
      ...extra
    };
  }

  // ======================================================
  // PREVIEW — wyłącznie odczyt
  // ======================================================

  async function podglad({ zKontaktami = true } = {}) {
    const { stan, a } = await analiza({ zKontaktami });

    const tabela = a.zamowienia.map(wierszTabeli);

    const wynik = raport('PREVIEW', a, {
      tabela,
      proponowaneFaktury: a.plany.map(opisPlanu),
      zaplanowaneOperacje: a.weryfikacjaPlanowanych.map(w => ({
        operationId: w.operationId,
        status: w.status,
        klient: w.klient,
        kwota: w.kwota,
        aktualne: w.ok,
        problemy: w.problemy
      })),
      operacjeDziennika: [...stan.operacje.values()]
        .filter(op => op.miesiac === cfg.miesiac)
        .map(opisOperacji),
      cykleBezZamowien: a.cykleBezZamowien,
      doRecznejDecyzji: a.zamowienia
        .filter(w => w.kategoria === K.DO_SPRAWDZENIA)
        .map(w => ({
          klient: w.klient,
          orderId: w.row.orderId,
          powod: w.powody.join(' | ')
        })),
      gotoweDoPrzygotowania:
        a.sumy.kontroleOk && !a.bledyGlobalne.length
    });

    log.log('FAKTURY_PREVIEW_SUMY', JSON.stringify(wynik.sumy));
    log.log('FAKTURY_PREVIEW_KONTROLE', JSON.stringify(wynik.kontroleSum));
    for (const w of tabela) log.log('FAKTURY_PREVIEW_ZAMOWIENIE', JSON.stringify(w));
    for (const p of wynik.proponowaneFaktury) {
      log.log('FAKTURY_PREVIEW_FAKTURA', JSON.stringify(p));
    }

    return wynik;
  }

  // ======================================================
  // Wspólne opakowanie trybów zapisujących
  // ======================================================

  async function zBlokada(opis, fn) {
    let lock;

    try {
      lock = await journal.zablokuj(opis);
    } catch (e) {
      if (['BusyError', 'LockReviewError'].includes(e?.name)) {
        return {
          tryb: opis,
          status: e.name === 'BusyError' ? 'BUSY' : 'LOCK_REVIEW',
          blad: msg(e)
        };
      }
      throw e;
    }

    try {
      return await fn(lock);
    } finally {
      await lock.zwolnij().catch(e =>
        log.error('FAKTURY_BLOKADA_ZWOLNIENIE', msg(e))
      );
    }
  }

  // ======================================================
  // PREPARE — zapis planu w dzienniku (bez Wix Invoices)
  // ======================================================

  async function przygotuj({ contactIds = [], maxSekund } = {}) {
    return zBlokada('PREPARE', async lock => {
      const b = budzet(cfg, maxSekund);
      const { a } = await analiza();

      if (a.bledyGlobalne.length || !a.sumy.kontroleOk) {
        return raport('PREPARE', a, {
          status: 'ODMOWA',
          blad: 'Kontrole globalne lub sum nie przeszły — popraw dane i uruchom PREVIEW.'
        });
      }

      const wyniki = [];

      for (const p of a.plany) {
        if (contactIds.length && !contactIds.includes(p.contactId)) continue;

        const istn = p.istniejacaOperacja;

        if (istn && istn.status !== S.CANCELLED && istn.status !== S.PREPARED) {
          wyniki.push({ operationId: p.operationId, status: istn.status, uwaga: 'Bez zmian.' });
          continue;
        }

        if (!b.wystarczy()) {
          wyniki.push({ operationId: p.operationId, status: 'POMINIETO', uwaga: 'Koniec budżetu czasu.' });
          continue;
        }

        if (p.problemyKontaktu?.length) {
          wyniki.push({
            operationId: p.operationId,
            klient: p.klient,
            status: 'ODMOWA',
            blad: p.problemyKontaktu.join(' ')
          });
          continue;
        }

        await lock.pilnuj();

        try {
          const r = await journal.przygotuj(p, p.kontakt);
          wyniki.push({
            operationId: p.operationId,
            klient: p.klient,
            status: r.op?.status,
            kwota: zl(p.razem),
            uwaga: r.pominieto || ''
          });
        } catch (e) {
          if (KRYTYCZNE.includes(e?.name)) throw e;
          wyniki.push({
            operationId: p.operationId,
            klient: p.klient,
            status: 'BLAD',
            blad: msg(e)
          });
        }
      }

      const ops = await journal.operacje();
      const przygotowane = [...ops.values()].filter(o => o.status === S.PREPARED);

      return raport('PREPARE', a, {
        status: 'OK',
        wyniki,
        doZatwierdzenia: {
          liczba: przygotowane.length,
          suma: zl(przygotowane.reduce((s, o) => s + o.kwotaGrosze, 0)),
          operationIds: przygotowane.map(o => o._id)
        }
      });
    });
  }

  // ======================================================
  // APPROVE — decyzja administratora z sumą kontrolną
  // ======================================================

  async function zatwierdz({
    operationIds = [],
    wszystkie = false,
    oczekiwanaLiczba,
    oczekiwanaSuma
  } = {}) {
    return zBlokada('APPROVE', async lock => {
      const { a, stan } = await analiza({ zKontaktami: false });

      const kandydaci = [...stan.operacje.values()].filter(op =>
        op.miesiac === cfg.miesiac &&
        op.status === S.PREPARED &&
        (wszystkie || operationIds.includes(op._id))
      );

      if (!wszystkie) {
        const brak = operationIds.filter(id => !kandydaci.some(o => o._id === id));
        if (brak.length) {
          return { tryb: 'APPROVE', status: 'ODMOWA', blad: `Nie PREPARED: ${brak.join(', ')}` };
        }
      }

      const suma = kandydaci.reduce((s, o) => s + o.kwotaGrosze, 0);

      if (
        oczekiwanaLiczba !== kandydaci.length ||
        oczekiwanaSuma === undefined ||
        grosze(oczekiwanaSuma) !== suma
      ) {
        return {
          tryb: 'APPROVE',
          status: 'ODMOWA',
          blad:
            'Liczba lub suma nie zgadza się z PREVIEW/PREPARE. ' +
            `Dziennik: ${kandydaci.length} faktur, ${zl(suma)} zł.`
        };
      }

      const nieaktualne = a.weryfikacjaPlanowanych.filter(w =>
        kandydaci.some(o => o._id === w.operationId) && !w.ok
      );

      if (nieaktualne.length) {
        return {
          tryb: 'APPROVE',
          status: 'ODMOWA',
          blad: 'Część operacji nie odpowiada już zamówieniom.',
          nieaktualne
        };
      }

      const wyniki = [];

      for (const op of kandydaci) {
        await lock.pilnuj();
        const nowy = await journal.zmien(
          op,
          S.PREPARED,
          { status: S.APPROVED, zatwierdzono: now().toISOString() },
          `APPROVE (${kandydaci.length} faktur, ${zl(suma)} zł)`
        );
        wyniki.push(opisOperacji(nowy));
      }

      return { tryb: 'APPROVE', status: 'OK', liczba: wyniki.length, suma: zl(suma), wyniki };
    });
  }

  // ======================================================
  // RUN — tworzenie i wysyłka
  // ======================================================

  async function doPrzegladu(op, z, powod, blad) {
    return journal.zmien(
      op,
      z,
      { status: S.NEEDS_REVIEW, powodPrzegladu: powod, blad: blad || '' },
      `${powod}: ${blad || ''}`.slice(0, 500)
    );
  }

  // Stany pozostawione przez przerwane wywołanie.
  async function uporzadkujNiepewne(ops, lock) {
    const wyniki = [];

    for (const op of ops.values()) {
      if (op.miesiac !== cfg.miesiac) continue;

      if (op.status === S.CREATING) {
        await lock.pilnuj();
        const n = await doPrzegladu(
          op,
          S.CREATING,
          'CREATE_UNCERTAIN',
          'Przerwano po rozpoczęciu createInvoice — nie wiadomo, czy faktura ' +
          'powstała. Sprawdź panel Faktury i logi FAKTURA_UTWORZONA.'
        );
        wyniki.push(opisOperacji(n));
      }

      if (op.status === S.SENDING) {
        await lock.pilnuj();
        let faktura = null;

        try {
          faktura = await gateway.pobierzFakture(op.invoiceId);
        } catch (e) {
          log.warn('FAKTURY_GET_INVOICE', msg(e));
        }

        const n = faktura?.wasSent === true
          ? await journal.zmien(
              op,
              S.SENDING,
              { status: S.SENT, wyslano: now().toISOString(), blad: '' },
              'Wznowienie: getInvoice.wasSent = true (bez ponownej wysyłki)'
            )
          : await doPrzegladu(
              op,
              S.SENDING,
              'SEND_UNCERTAIN',
              'Przerwano po rozpoczęciu sendInvoice; wasSent ≠ true. ' +
              'Nie wysyłamy ponownie bez decyzji.'
            );

        wyniki.push(opisOperacji(n));
      }
    }

    return wyniki;
  }

  async function wyslij(op, lock) {
    let faktura;

    try {
      faktura = await gateway.pobierzFakture(op.invoiceId);
    } catch (e) {
      // Nic nie wysłano — operacja zostaje CREATED.
      return { op, blad: `getInvoice: ${msg(e)}`, stop: true };
    }

    const problemy = sprawdzFakture(faktura, op);

    if (problemy.length) {
      op = await doPrzegladu(op, S.CREATED, 'INVOICE_MISMATCH', problemy.join(' '));
      return { op, stop: false };
    }

    if (faktura.wasSent === true) {
      op = await journal.zmien(
        op,
        S.CREATED,
        { status: S.SENT, wyslano: now().toISOString() },
        'Faktura już wysłana (wasSent) — bez ponownej wysyłki'
      );
      return { op };
    }

    if (/void|cancel|delet|paid/i.test(String(faktura.status || ''))) {
      op = await doPrzegladu(
        op,
        S.CREATED,
        'INVOICE_STATUS',
        `Nieoczekiwany status faktury przed wysyłką: ${faktura.status}.`
      );
      return { op };
    }

    // Wersja z bieżącego odczytu — createInvoice/updateInvoice ją zmieniają.
    const version = faktura.id?.version ?? op.invoiceVersion;

    op = await journal.zmien(
      op,
      S.CREATED,
      {
        status: S.SENDING,
        wysylkaRozpoczeta: true,
        invoiceVersion: version,
        rozpoczetoWysylke: now().toISOString()
      },
      'sendInvoice start'
    );

    await lock.pilnuj();

    try {
      await gateway.wyslijFakture(op.invoiceId, version, {
        subject: cfg.temat,
        body: cfg.tresc
      });
    } catch (e) {
      op = await doPrzegladu(op, S.SENDING, 'SEND_UNCERTAIN', `sendInvoice: ${msg(e)}`);
      return { op, stop: true };
    }

    log.log('FAKTURA_WYSLANA', JSON.stringify({
      operationId: op._id,
      invoiceId: op.invoiceId,
      version
    }));

    op = await journal.zmien(
      op,
      S.SENDING,
      { status: S.SENT, wyslano: now().toISOString(), blad: '' },
      'sendInvoice OK'
    );

    return { op };
  }

  async function utworz(op, weryfikacja, lock) {
    if (!weryfikacja?.ok) {
      op = await doPrzegladu(
        op,
        S.APPROVED,
        'ZMIANA_DANYCH',
        (weryfikacja?.problemy || ['Brak weryfikacji.']).join(' ')
      );
      return { op };
    }

    const { kontakt, problemy } = await kontaktDla(op.klientContactId);

    if (problemy.length) {
      op = await doPrzegladu(op, S.APPROVED, 'KONTAKT', problemy.join(' '));
      return { op };
    }

    const pola = polaFaktury(weryfikacja.plan, kontakt, cfg, now());

    const sumaPol =
      pola.lineItems.reduce((s, x) => s + grosze(x.price) * x.quantity, 0) -
      (pola.discount ? grosze(pola.discount.value) : 0);

    if (sumaPol !== op.kwotaGrosze) {
      op = await doPrzegladu(op, S.APPROVED, 'KWOTA', 'Pola faktury ≠ kwota operacji.');
      return { op };
    }

    // Trwały zapis PRZED createInvoice.
    op = await journal.zmien(
      op,
      S.APPROVED,
      {
        status: S.CREATING,
        utworzenieRozpoczete: true,
        proby: (op.proby || 0) + 1,
        rozpoczetoTworzenie: now().toISOString(),
        hashPol: hash({ ...pola, dates: null }),
        email: kontakt.email,
        blad: ''
      },
      'createInvoice start'
    );

    await lock.pilnuj();

    let wynik;

    try {
      wynik = await gateway.utworzFakture(pola);
    } catch (e) {
      // Błąd mógł nastąpić po utworzeniu faktury (np. timeout).
      op = await doPrzegladu(op, S.CREATING, 'CREATE_UNCERTAIN', `createInvoice: ${msg(e)}`);
      return { op, stop: true };
    }

    // createInvoice zwraca { id: { id, version } }.
    const invoiceId = wynik?.id?.id;
    const invoiceVersion = wynik?.id?.version ?? null;

    if (!invoiceId) {
      op = await doPrzegladu(
        op,
        S.CREATING,
        'CREATE_UNCERTAIN',
        `createInvoice bez ID: ${JSON.stringify(wynik).slice(0, 300)}`
      );
      return { op, stop: true };
    }

    // Log PRZED zapisem — jeśli zapis zawiedzie, ID zostaje w logach.
    log.log('FAKTURA_UTWORZONA', JSON.stringify({
      operationId: op._id,
      contactId: op.klientContactId,
      orderIds: op.orderIds,
      invoiceId,
      invoiceVersion
    }));

    op = await journal.zmien(
      op,
      S.CREATING,
      {
        status: S.CREATED,
        invoiceId,
        invoiceVersion,
        utworzono: now().toISOString()
      },
      'createInvoice OK'
    );

    return { op };
  }

  async function wykonaj({
    maxOperacji,
    maxSekund,
    etap = 'OBA',
    operationIds = []
  } = {}) {
    if (!['OBA', 'UTWORZ', 'WYSLIJ'].includes(etap)) {
      throw new Error('etap: OBA | UTWORZ | WYSLIJ');
    }

    const limit = Math.min(Math.max(Number(maxOperacji) || cfg.maxOperacji, 1), 5);

    return zBlokada('RUN', async lock => {
      const b = budzet(cfg, maxSekund);

      const poczatkowe = await journal.operacje();
      const uporzadkowane = await uporzadkujNiepewne(poczatkowe, lock);

      const { a, stan } = await analiza({ zKontaktami: false });

      const wybrane = op =>
        op.miesiac === cfg.miesiac &&
        (!operationIds.length || operationIds.includes(op._id));

      const ops = [...stan.operacje.values()].filter(wybrane);

      const kolejka = [
        ...(etap === 'UTWORZ' ? [] : ops.filter(o => o.status === S.CREATED)),
        ...(etap === 'WYSLIJ' ? [] : ops.filter(o => o.status === S.APPROVED))
      ].slice(0, limit);

      const wyniki = [];
      let zatrzymano = '';

      for (let op of kolejka) {
        if (!b.wystarczy()) {
          zatrzymano = 'Koniec budżetu czasu — uruchom ponownie.';
          break;
        }

        try {
          let r;

          if (op.status === S.APPROVED) {
            const wer = a.weryfikacjaPlanowanych.find(w => w.operationId === op._id);
            r = await utworz(op, wer, lock);

            if (
              !r.stop &&
              r.op.status === S.CREATED &&
              etap === 'OBA' &&
              b.wystarczy()
            ) {
              r = await wyslij(r.op, lock);
            }
          } else {
            r = await wyslij(op, lock);
          }

          op = r.op;
          wyniki.push({ ...opisOperacji(op), uwaga: r.blad || '' });

          if (r.stop) {
            zatrzymano = `Zatrzymano po operacji ${op._id}: ${op.powodPrzegladu || r.blad}`;
            break;
          }
        } catch (e) {
          if (KRYTYCZNE.includes(e?.name)) {
            log.error('FAKTURY_RUN_KRYTYCZNY', op._id, msg(e));
            throw e;
          }

          wyniki.push({ ...opisOperacji(op), status: 'BLAD', blad: msg(e) });
          zatrzymano = `Błąd: ${msg(e)}`;
          break;
        }
      }

      const po = await journal.operacje();
      const liczby = {};
      for (const o of po.values()) liczby[o.status] = (liczby[o.status] || 0) + 1;

      const wynik = {
        tryb: 'RUN',
        etap,
        miesiac: cfg.miesiac,
        uporzadkowaneNiepewne: uporzadkowane,
        wyniki,
        zatrzymano,
        statusy: liczby,
        pozostaloDoUtworzenia: [...po.values()].filter(o => o.status === S.APPROVED).length,
        pozostaloDoWyslania: [...po.values()].filter(o => o.status === S.CREATED).length,
        doRecznejDecyzji: [...po.values()]
          .filter(o => o.status === S.NEEDS_REVIEW)
          .map(opisOperacji)
      };

      log.log('FAKTURY_RUN', JSON.stringify({ ...wynik, wyniki: wyniki.length }));
      for (const w of wyniki) log.log('FAKTURY_RUN_OPERACJA', JSON.stringify(w));

      return wynik;
    });
  }

  // ======================================================
  // STATUS
  // ======================================================

  async function status() {
    const ops = [...(await journal.operacje()).values()];
    const liczby = {};
    for (const o of ops) liczby[o.status] = (liczby[o.status] || 0) + 1;

    return {
      tryb: 'STATUS',
      miesiac: cfg.miesiac,
      statusy: liczby,
      operacje: ops.map(opisOperacji)
    };
  }

  // ======================================================
  // ROZSTRZYGNIĘCIA STANÓW NIEPEWNYCH (decyzja administratora)
  // ======================================================

  async function rozstrzygnij({
    operationId,
    decyzja,
    invoiceId,
    uwagi = '',
    potwierdzam = false
  } = {}) {
    return zBlokada('RESOLVE', async lock => {
      const op = await journal.operacja(operationId);

      if (!op) return { status: 'ODMOWA', blad: 'Brak operacji.' };

      const odmowa = blad => ({ status: 'ODMOWA', blad, operacja: opisOperacji(op) });
      const info = `${decyzja}: ${uwagi}`.slice(0, 500);

      await lock.pilnuj();

      switch (decyzja) {
        // Faktura z CREATE_UNCERTAIN istnieje w panelu: przypinamy jej ID.
        case 'FAKTURA_ISTNIEJE': {
          if (!(op.status === S.NEEDS_REVIEW && op.powodPrzegladu === 'CREATE_UNCERTAIN')) {
            return odmowa('Dotyczy wyłącznie NEEDS_REVIEW / CREATE_UNCERTAIN.');
          }
          if (!invoiceId) return odmowa('Podaj invoiceId z panelu Faktury.');

          const f = await gateway.pobierzFakture(invoiceId);
          const problemy = sprawdzFakture(f, { ...op, invoiceId });
          const ref = f?.metadata?.sourceRefId;

          if (ref !== op._id && !potwierdzam) {
            problemy.push(
              'Faktura nie ma metadata.sourceRefId tej operacji — ' +
              'jeśli to na pewno ta faktura, podaj potwierdzam: true.'
            );
          }

          if (problemy.length) return odmowa(problemy.join(' '));

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: f.wasSent === true ? S.SENT : S.CREATED,
            invoiceId,
            invoiceVersion: f.id?.version ?? null,
            powodPrzegladu: '',
            blad: '',
            utworzono: op.utworzono || now().toISOString(),
            ...(f.wasSent === true ? { wyslano: now().toISOString() } : {})
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        // Faktury na pewno nie ma: wolno ponowić utworzenie.
        case 'FAKTURY_BRAK': {
          if (!(op.status === S.NEEDS_REVIEW && op.powodPrzegladu === 'CREATE_UNCERTAIN')) {
            return odmowa('Dotyczy wyłącznie NEEDS_REVIEW / CREATE_UNCERTAIN.');
          }
          if (!potwierdzam) {
            return odmowa('Potwierdź (potwierdzam: true), że w panelu Faktury nie ma tej faktury.');
          }

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: S.APPROVED,
            powodPrzegladu: '',
            blad: ''
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        // Wysyłka niepewna, a klient otrzymał fakturę / panel pokazuje wysłaną.
        case 'WYSLANA': {
          if (!op.invoiceId || ![S.NEEDS_REVIEW].includes(op.status)) {
            return odmowa('Dotyczy NEEDS_REVIEW z invoiceId.');
          }

          const f = await gateway.pobierzFakture(op.invoiceId);

          if (f?.wasSent !== true && !potwierdzam) {
            return odmowa('getInvoice nie potwierdza wysyłki — podaj potwierdzam: true, jeśli sprawdzono inaczej.');
          }

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: S.SENT,
            powodPrzegladu: '',
            blad: '',
            wyslano: now().toISOString()
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        // Faktura istnieje, na pewno nie wysłana: wraca do kolejki wysyłki.
        case 'WYSLIJ_PONOWNIE': {
          if (!(op.status === S.NEEDS_REVIEW && op.invoiceId &&
            ['SEND_UNCERTAIN', 'INVOICE_STATUS'].includes(op.powodPrzegladu))) {
            return odmowa('Dotyczy NEEDS_REVIEW / SEND_UNCERTAIN z invoiceId.');
          }
          if (!potwierdzam) {
            return odmowa('Potwierdź (potwierdzam: true), że faktura i SMS nie dotarły.');
          }

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: S.CREATED,
            powodPrzegladu: '',
            blad: ''
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        // Rezygnacja z operacji, która nigdy nie dotarła do createInvoice.
        case 'ANULUJ': {
          if (!(STATUSY_PLANOWANE.includes(op.status) || op.status === S.NEEDS_REVIEW)) {
            return odmowa(`Nie można anulować statusu ${op.status}.`);
          }
          try {
            const n = await journal.anuluj(op, info);
            return { status: 'OK', operacja: opisOperacji(n) };
          } catch (e) {
            return odmowa(msg(e));
          }
        }

        // Sprawa załatwiona poza skryptem; zamówienia pozostają przypisane.
        case 'ZAMKNIJ_RECZNIE': {
          if (op.status !== S.NEEDS_REVIEW) return odmowa('Dotyczy NEEDS_REVIEW.');
          if (!uwagi) return odmowa('Opisz w uwagach, jak sprawę rozwiązano.');

          const n = await journal.zmien(op, S.NEEDS_REVIEW, {
            status: S.CLOSED_MANUALLY,
            ...(invoiceId ? { invoiceId } : {}),
            blad: ''
          }, info);

          return { status: 'OK', operacja: opisOperacji(n) };
        }

        default:
          return odmowa(
            'decyzja: FAKTURA_ISTNIEJE | FAKTURY_BRAK | WYSLANA | ' +
            'WYSLIJ_PONOWNIE | ANULUJ | ZAMKNIJ_RECZNIE'
          );
      }
    });
  }

  async function zwolnijBlokade({ potwierdzam = false } = {}) {
    if (!potwierdzam) {
      return { status: 'ODMOWA', blad: 'Najpierw sprawdź STATUS; potem potwierdzam: true.' };
    }
    return journal.zwolnijStara();
  }

  return {
    wczytajStan,
    podglad,
    przygotuj,
    zatwierdz,
    wykonaj,
    status,
    rozstrzygnij,
    zwolnijBlokade
  };
}
