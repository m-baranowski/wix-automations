/**
 * Fakturowanie PAŹDZIERNIK 2026 — z dziennikiem w kolekcji FakturyMiesieczne.
 *
 * Jeden wiersz = jeden klient w jednym miesiącu (jedna faktura na klienta,
 * także gdy ma kilka terapii). UmowyMiesiace pozostaje nietknięte.
 *
 * Jak działa zabezpieczenie przed duplikatami:
 * - Wiersz ma deterministyczne _id (hasz miesiąca i contactId).
 * - Zapisujemy go PRZED utworzeniem faktury (status TWORZENIE).
 *   Drugi zapis tego samego klienta w tym miesiącu jest niemożliwy —
 *   Wix odrzuci insert z istniejącym _id.
 * - Po utworzeniu faktury: UTWORZONA + invoiceId. Po wysyłce: WYSLANA.
 *   Każdy zapis jest potwierdzany odczytem.
 * - Ponowne uruchomienie sprawdza własny dziennik, nie kolekcję faktur Wix.
 *
 * Nie ma OD_INDEKSU w trybie RUN: każde uruchomienie bierze kolejnych
 * klientów bez statusu WYSLANA. Powtórzenie wywołania jest bezpieczne.
 *
 * STAN NIEPEWNY (TWORZENIE bez invoiceId) — powstaje tylko, gdy proces
 * zostanie przerwany między utworzeniem faktury a zapisem jej ID.
 * Skrypt go NIE ponawia. Ręcznie, w panelu Faktury:
 *   - faktury nie ma  → usuń wiersz w CMS; kolejne uruchomienie ją utworzy,
 *   - faktura jest    → wyślij ją z panelu i ustaw w CMS status WYSLANA.
 * W logu FAKTURA_UTWORZONA jest ID każdej utworzonej faktury.
 */

import wixData from 'wix-data';
import { invoices } from 'wix-billing-backend';
import { contacts } from 'wix-crm-backend';
import { elevate } from 'wix-auth';
import { createHash, randomBytes } from 'crypto';

// ======================================================
// KONFIGURACJA
// ======================================================

const MIESIAC = '2026-10';
const TYTUL_FAKTURY = 'Październik 2026';
const TEMAT_EMAILA =
  'Rachunek za październik — Centrum Terapii Dziecięcej Toto';
const TRESC_EMAILA =
  'Przesyłamy rachunek za bieżący miesiąc. Dziękujemy!';
const DNI_NA_PLATNOSC = 5;

// Najpierw true. PREVIEW nie tworzy, nie wysyła i nie zapisuje niczego,
// ale sprawdza umowy, kontakty i stan dziennika.
const PREVIEW = true;

// W PREVIEW przesuwasz PODGLAD_OD, żeby obejrzeć całą listę.
// W RUN jest ignorowane — o kolejności decyduje dziennik.
const PODGLAD_OD = 0;

const LIMIT_KLIENTOW = 4;
const BUDZET_MS = 40000;      // limit platformy to ok. 59 s
const MIN_ZAPAS_MS = 12000;   // nie zaczynamy klienta, gdy zostało mniej

const LEDGER = 'FakturyMiesieczne';
const LOCKS = 'GeneratorBlokady';
const LOCK_WAZNOSC_MS = 5 * 60 * 1000;

const ST_TWORZENIE = 'TWORZENIE';
const ST_UTWORZONA = 'UTWORZONA';
const ST_WYSLANA = 'WYSLANA';

const READ = { suppressAuth: true, suppressHooks: true, consistentRead: true };
const WRITE = { suppressAuth: true, suppressHooks: true };

const createInvoice = elevate(invoices.createInvoice);
const sendInvoice = elevate(invoices.sendInvoice);
const getContact = elevate(contacts.getContact);

// ======================================================
// ZATWIERDZONE DANE (bez zmian względem uzgodnionej listy)
// ======================================================

const DANE = [
  ['Agata Babula-Rolińska', 'Terapia logopedyczna', 3],
  ['Agata Sułko', 'Terapia logopedyczna', 5],
  ['Agnieszka Kugla', 'Terapia integracji sensorycznej', 3],
  ['Agnieszka Kugla', 'Terapia logopedyczna', 3],
  ['Agnieszka Olszewska', 'Terapia logopedyczna', 3],
  ['Agnieszka Walczak - Pikul', 'Terapia logopedyczna', 3],
  ['Agnieszka Zaręba', 'Terapia logopedyczna', 3],
  ['Aleksandra Musioł', 'Terapia logopedyczna', 5],
  ['Alicja Rajpold-Marcińczak', 'Terapia neurologopedyczna', 4],
  ['Anna Aibinder', 'Terapia logopedyczna', 4],
  ['Anna Eychenne', 'Terapia logopedyczna', 4],
  ['Anna Jedynak', 'Terapia logopedyczna', 4],
  ['Anna Łabędź-Kuska', 'Terapia neurologopedyczna', 3],
  // Anna Waga-Jasica — SI = 0 po korekcie, brak pozycji.
  ['Antoni Sikorski', 'Terapia logopedyczna', 3],
  ['Barbara Rosa', 'Terapia neurologopedyczna', 3],
  ['Beata Hałaj', 'Terapia logopedyczna', 4],
  ['Bożena Dudek-Pilśniak', 'Terapia logopedyczna', 5],
  ['Bożena Widlarz', 'Terapia integracji sensorycznej', 3],
  ['Dagmara Węc', 'Terapia logopedyczna', 4],
  ['Daniel Marcisz', 'Terapia logopedyczna', 4],
  // Jedna należna wizyta została fizycznie przełożona na wrzesień.
  ['Dominika Lasoń', 'Terapia neurologopedyczna', 1],
  ['Dorota Kaszuba', 'Terapia logopedyczna', 3],
  ['Edyta Jania Karcz', 'Terapia logopedyczna', 4],
  ['Elżbieta Strzałka', 'Terapia integracji sensorycznej', 2],
  ['Ewa Cholewinska', 'Terapia logopedyczna', 3],
  ['Ewelina Jarek', 'Terapia neurologopedyczna', 3],
  ['Ewelina Kaczmarek', 'Terapia logopedyczna', 5],
  ['Iwona Dułak', 'Terapia neurologopedyczna', 3],
  ['Izabela Pałka', 'Terapia integracji sensorycznej', 2],
  ['Izabela Pałka', 'Terapia logopedyczna', 3],
  ['Joanna Kumiega', 'Terapia logopedyczna', 4],
  ['Joanna Stanilewicz', 'Terapia logopedyczna', 6],
  ['Joanna Średniawa', 'Terapia neurologopedyczna', 3],
  ['Joanna Święszek-Przeliorz', 'Terapia logopedyczna', 3],
  ['Justyna Szwarnog', 'Terapia logopedyczna', 4],
  ['Kamila Krzystanek', 'Terapia logopedyczna', 3],
  ['Karina Bakonyi', 'Terapia logopedyczna', 3],
  ['Karolina Kowalska', 'Terapia logopedyczna', 3],
  ['Karolina Krajewska', 'Terapia neurologopedyczna', 3],
  ['Karolina Krasicka', 'Terapia logopedyczna', 4],
  ['Katarzyna Dziedziech', 'Terapia neurologopedyczna', 3],
  ['Katarzyna Jażdżewska', 'Terapia neurologopedyczna', 4],
  ['Katarzyna Karolczuk', 'Terapia logopedyczna', 3],
  ['Katarzyna Nabiałek', 'Terapia neurologopedyczna', 3],
  ['Katarzyna Wolszewska', 'Terapia integracji sensorycznej', 3],
  ['Kinga Fira', 'Terapia logopedyczna', 4],
  ['Kinga Szczęśniak', 'Terapia logopedyczna', 4],
  ['Kinga Żmuda-Dziedzic', 'Terapia integracji sensorycznej', 2],
  ['Klara Osada', 'Terapia logopedyczna', 4],
  // Dwie prawidłowe umowy u dwóch terapeutów.
  ['Klaudia Fidali', 'Terapia logopedyczna', 7],
  ['Klaudia Kalarus', 'Terapia integracji sensorycznej', 2],
  ['Klaudia Kalarus', 'Terapia logopedyczna', 3],
  ['Klaudia Niedbała', 'Terapia logopedyczna', 5],
  // Dwie umowy neurologopedyczne; 7 bazowo minus 1 korekta = 6.
  ['Krzysztof Tomasiak', 'Terapia neurologopedyczna', 6],
  ['Magdalena Popławska', 'Terapia integracji sensorycznej', 4],
  ['Magdalena Popławska', 'Terapia logopedyczna', 5],
  // Magdalena Pajdzik — świadomy wyjątek, brak faktury.
  ['Małgorzata Kornicka', 'Terapia logopedyczna', 3],
  ['Małgorzata Książek -cabaj', 'Terapia neurologopedyczna', 3],
  ['Marcin Wilk', 'Terapia logopedyczna', 4],
  ['Maria Dobosz', 'Terapia logopedyczna', 4],
  ['Mariola Kuć', 'Terapia neurologopedyczna', 4],
  ['Marlena Błachucka', 'Terapia integracji sensorycznej', 2],
  ['Marlena Mączyńska', 'Terapia neurologopedyczna', 3],
  ['Marta Łomża (Zabiegaj)', 'Terapia logopedyczna', 3],
  ['Marta Malicka', 'Terapia logopedyczna', 3],
  ['Marta Pogan', 'Terapia integracji sensorycznej', 3],
  ['Marta Szott-Nędza', 'Terapia logopedyczna', 4],
  ['Michal Olek', 'Terapia neurologopedyczna', 3],
  ['Monika Adamczyk', 'Terapia integracji sensorycznej', 2],
  ['Monika Gurbiel', 'Terapia neurologopedyczna', 3],
  // SI wyzerowane ręczną korektą.
  ['Monika Kanas', 'Terapia logopedyczna', 4],
  ['Monika Kubaty', 'Terapia logopedyczna', 3],
  ['Monika Lisik', 'Terapia logopedyczna', 4],
  ['Natalia Jaruga', 'Terapia logopedyczna', 2],
  ['Patrycja Dziedzic', 'Terapia integracji sensorycznej', 2],
  ['Paulina Ilba', 'Terapia logopedyczna', 4],
  ['Paulina Kniaź', 'Terapia logopedyczna', 4],
  ['Roksana Marmura', 'Terapia logopedyczna', 4],
  ['Sonia Zajdel', 'Terapia logopedyczna', 4],
  ['Tomasz Wójcik', 'Terapia neurologopedyczna', 4],
  ['Yaroslav Biriukov', 'Terapia logopedyczna', 5],
];

// ======================================================
// POMOCNICZE
// ======================================================

const norm = v => String(v || '').trim().toLowerCase();

function stableId(text) {
  const h = createHash('sha256').update(text).digest('hex');
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-` +
    `a${h.slice(17, 20)}-${h.slice(20, 32)}`
  );
}

const idDziennika = contactId =>
  stableId(`toto/invoice/v1/${MIESIAC}/${contactId}`);

function grupujPoKliencie() {
  const mapa = new Map();
  for (const [klientNazwa, usluga, liczba] of DANE) {
    const key = norm(klientNazwa);
    if (!mapa.has(key)) mapa.set(key, { klientNazwa, pozycje: [] });
    mapa.get(key).pozycje.push({ usluga, liczba });
  }
  return [...mapa.values()];
}

async function czytajPoId(kolekcja, id) {
  const r = await wixData.query(kolekcja).eq('_id', id).limit(1).find(READ);
  return r.items[0] || null;
}

async function wierszeFaktur() {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const r = await wixData
      .query(LEDGER)
      .eq('miesiac', MIESIAC)
      .ascending('_id')
      .skip(offset)
      .limit(100)
      .find(READ);
    out.push(...r.items);
    if (r.items.length < 100) break;
  }
  return out;
}

async function mapaUslug() {
  const r = await wixData.query('Bookings/Services').limit(1000).find(READ);
  const m = new Map();
  for (const s of r.items) if (s.serviceName) m.set(s.serviceName, s._id);
  return m;
}

// Klient może mieć kilka umów na tę samą usługę (Fidali, Tomasiak).
// Dopuszczamy to, jeśli wszystkie wskazują ten sam kontakt i stawkę.
async function daneUmowy(klientNazwa, serviceId) {
  const r = await wixData
    .query('Umowy')
    .eq('klientNazwa', klientNazwa)
    .eq('usluga', serviceId)
    .limit(20)
    .find(READ);

  if (!r.items.length) {
    throw new Error(`Brak umowy: ${klientNazwa} / ${serviceId}`);
  }

  const contactIds = [...new Set(r.items.map(x => x.klientContactId).filter(Boolean))];
  if (contactIds.length !== 1) {
    throw new Error(`Niejednoznaczny kontakt w umowach: ${contactIds.join(', ')}`);
  }

  const stawki = [...new Set(
    r.items.map(x => Number(x.stawka)).filter(x => Number.isFinite(x) && x > 0)
  )];
  if (stawki.length !== 1) {
    throw new Error(`Niejednoznaczna stawka w umowach: ${stawki.join(', ')}`);
  }

  return {
    contactId: contactIds[0],
    stawka: stawki[0],
    umowaIds: r.items.map(x => x._id),
  };
}

function wyciagnijKontakt(raw) {
  const c = raw?.contact || raw;
  return {
    firstName: c?.info?.name?.first || c?.name?.first || '',
    lastName: c?.info?.name?.last || c?.name?.last || '',
    email:
      c?.primaryInfo?.email ||
      c?.info?.emails?.find?.(e => e.primary)?.email ||
      c?.info?.emails?.[0]?.email ||
      c?.info?.emails?.items?.[0]?.email ||
      '',
    phone:
      c?.primaryInfo?.phone ||
      c?.info?.phones?.[0]?.phone ||
      c?.info?.phones?.items?.[0]?.phone ||
      '',
  };
}

// Wszystkie walidacje PRZED zapisem do dziennika — żeby między
// zapisem a utworzeniem faktury nie działo się nic, co może zawieść.
async function przygotuj(grupa, uslugi) {
  const pozycje = [];
  const contactIds = new Set();
  const umowaIds = [];

  for (const p of grupa.pozycje) {
    if (!Number.isInteger(p.liczba) || p.liczba <= 0) {
      throw new Error(`Nieprawidłowa liczba wizyt: ${p.liczba}`);
    }
    const serviceId = uslugi.get(p.usluga);
    if (!serviceId) throw new Error(`Nie znaleziono usługi Wix: ${p.usluga}`);

    const u = await daneUmowy(grupa.klientNazwa, serviceId);
    contactIds.add(u.contactId);
    umowaIds.push(...u.umowaIds);
    pozycje.push({ usluga: p.usluga, liczba: p.liczba, stawka: u.stawka });
  }

  if (contactIds.size !== 1) {
    throw new Error('Usługi tego klienta wskazują różne kontakty.');
  }
  const contactId = [...contactIds][0];

  const kontakt = wyciagnijKontakt(await getContact(contactId));
  if (!kontakt.email) throw new Error(`Kontakt ${contactId} nie ma adresu e-mail.`);

  const suma = pozycje.reduce((s, x) => s + x.liczba * x.stawka, 0);
  return { contactId, pozycje, suma, umowaIds, kontakt };
}

// Zapis z potwierdzeniem odczytem. Przekazujemy KOPIĘ i zwracamy
// świeży rekord z bazy — nie trzymamy referencji przez zapis
// (lekcja z generatora listopadowego).
async function zapiszWiersz(wiersz) {
  await wixData.update(LEDGER, JSON.parse(JSON.stringify(wiersz)), WRITE);
  const odczyt = await czytajPoId(LEDGER, wiersz._id);

  if (
    !odczyt ||
    odczyt.status !== wiersz.status ||
    (odczyt.invoiceId || '') !== (wiersz.invoiceId || '')
  ) {
    throw new Error(`Zapis dziennika niepotwierdzony: ${wiersz.title}`);
  }
  return odczyt;
}

function polaFaktury(p) {
  const teraz = new Date();
  const termin = new Date(teraz);
  termin.setDate(termin.getDate() + DNI_NA_PLATNOSC);

  return {
    title: TYTUL_FAKTURY,
    customer: {
      contactId: p.contactId,
      email: p.kontakt.email,
      ...(p.kontakt.firstName ? { firstName: p.kontakt.firstName } : {}),
      ...(p.kontakt.lastName ? { lastName: p.kontakt.lastName } : {}),
      ...(p.kontakt.phone ? { phone: p.kontakt.phone } : {}),
    },
    currency: 'PLN',
    lineItems: p.pozycje.map((x, i) => ({
      id: `poz-${i + 1}`,
      name: x.usluga,
      description: `${TYTUL_FAKTURY} — ${x.liczba} wizyt`,
      price: x.stawka,
      quantity: x.liczba,
    })),
    dates: { issueDate: teraz, dueDate: termin },
  };
}

// ======================================================
// BLOKADA
// ======================================================
//
// Automatyzacje Wix potrafią uruchomić się dwukrotnie.
// Blokada starsza niż 5 minut jest na pewno martwa — żadne wywołanie
// backendu nie żyje dłużej niż ok. 60 s — więc wolno ją przejąć.

async function zBlokada(fn) {
  const lockId = stableId('toto/faktury/global/v1');
  const token = randomBytes(16).toString('hex');
  const wstaw = () =>
    wixData.insert(LOCKS, { _id: lockId, title: `Faktury ${MIESIAC}`, token }, WRITE);

  try {
    await wstaw();
  } catch (e) {
    const istniejaca = await czytajPoId(LOCKS, lockId);
    const wiek = istniejaca
      ? Date.now() - new Date(istniejaca._createdDate).getTime()
      : 0;

    if (!istniejaca || wiek < LOCK_WAZNOSC_MS) {
      throw new Error('Trwa inne uruchomienie fakturowania. Spróbuj za chwilę.');
    }

    await wixData.remove(LOCKS, lockId, WRITE);
    await wstaw(); // równoległe przejęcie zakończy się błędem — bezpiecznie
  }

  try {
    return await fn();
  } finally {
    const l = await czytajPoId(LOCKS, lockId);
    if (l?.token === token) await wixData.remove(LOCKS, lockId, WRITE);
  }
}

// ======================================================
// JEDEN KLIENT
// ======================================================

async function obsluzKlienta(grupa, istniejacy, uslugi) {
  const p = await przygotuj(grupa, uslugi);
  const id = idDziennika(p.contactId);

  if (istniejacy && istniejacy._id !== id) {
    throw new Error('Wiersz klienta ma inny kontakt niż umowy — sprawdź ręcznie.');
  }

  if (PREVIEW) {
    return {
      klient: grupa.klientNazwa,
      status: istniejacy ? 'PODGLAD: dokończy wysyłkę' : 'PODGLAD: utworzy i wyśle',
      suma: p.suma,
      pozycje: p.pozycje.map(x => `${x.usluga} ${x.liczba}×${x.stawka}`).join(' | '),
    };
  }

  let wiersz = istniejacy;

  if (!wiersz) {
    // Dwie różne nazwy w DANE mogą wskazywać ten sam kontakt.
    const poId = await czytajPoId(LEDGER, id);
    if (poId) {
      throw new Error(`Kontakt ma już wiersz faktury (${poId.title}).`);
    }

    // Zapis PRZED utworzeniem faktury. Unikalne _id wyklucza
    // drugą fakturę tego klienta w tym miesiącu.
    await wixData.insert(LEDGER, {
      _id: id,
      title: `${MIESIAC} | ${grupa.klientNazwa}`,
      miesiac: MIESIAC,
      klientContactId: p.contactId,
      klientNazwa: grupa.klientNazwa,
      status: ST_TWORZENIE,
      invoiceId: '',
      kwota: p.suma,
      pozycje: p.pozycje,
      orderIds: [],   // październik: brak zamówień; od listopada ID zamówień
      blad: '',
    }, WRITE);

    wiersz = await czytajPoId(LEDGER, id);
    if (!wiersz) throw new Error('Wiersz dziennika nie został zapisany.');

    const utworzona = await createInvoice(polaFaktury(p));

    // createInvoice zwraca { id: { id, version } }.
    const invoiceId = utworzona?.id?.id;
    const invoiceVersion = utworzona?.id?.version;

    if (!invoiceId) {
      throw new Error('createInvoice nie zwrócił ID — stan niepewny, sprawdź panel Faktury.');
    }

    // Log PRZED zapisem — jeśli zapis zawiedzie, ID zostaje w logu.
    console.log('FAKTURA_UTWORZONA', JSON.stringify({
      klient: grupa.klientNazwa, invoiceId, invoiceVersion,
    }));

    wiersz = await zapiszWiersz({
      ...wiersz,
      status: ST_UTWORZONA,
      invoiceId,
      invoiceVersion,
    });
  }

  if (wiersz.status !== ST_UTWORZONA) {
    throw new Error(`Nieoczekiwany stan wiersza: ${wiersz.status}`);
  }

  // sendInvoice oczekuje płaskiego { id, version }.
  try {
    await sendInvoice(
      { id: wiersz.invoiceId, version: wiersz.invoiceVersion },
      { subject: TEMAT_EMAILA, body: TRESC_EMAILA }
    );
  } catch (e) {
    await zapiszWiersz({ ...wiersz, blad: `Wysyłka: ${e?.message || e}` }).catch(() => {});
    throw new Error(
      `Faktura istnieje, wysyłka nieudana — kolejne uruchomienie ponowi samą wysyłkę. ${e?.message || e}`
    );
  }

  await zapiszWiersz({ ...wiersz, status: ST_WYSLANA, blad: '' });

  return { klient: grupa.klientNazwa, status: 'WYSLANA', suma: p.suma };
}

// ======================================================
// PRZEBIEG
// ======================================================

async function wykonaj(czasMinal) {
  const grupy = grupujPoKliencie();
  const wiersze = await wierszeFaktur();
  const wgKlucza = new Map(wiersze.map(w => [norm(w.klientNazwa), w]));

  let wyslane = 0;
  const niepewne = [];
  const kolejka = [];

  for (const g of grupy) {
    const w = wgKlucza.get(norm(g.klientNazwa));
    if (w?.status === ST_WYSLANA) wyslane++;
    else if (w?.status === ST_TWORZENIE) niepewne.push(g.klientNazwa);
    else kolejka.push({ g, w });
  }

  const doPrzetworzenia = PREVIEW
    ? kolejka.slice(PODGLAD_OD, PODGLAD_OD + LIMIT_KLIENTOW)
    : kolejka.slice(0, LIMIT_KLIENTOW);

  const uslugi = await mapaUslug();
  const wyniki = [];

  for (const { g, w } of doPrzetworzenia) {
    if (czasMinal()) break;
    try {
      const r = await obsluzKlienta(g, w, uslugi);
      wyniki.push(r);
      console.log('FAKTURY_KLIENT', JSON.stringify(r));
    } catch (e) {
      const r = { klient: g.klientNazwa, status: 'BLAD', blad: e?.message || String(e) };
      wyniki.push(r);
      console.error('FAKTURY_KLIENT', JSON.stringify(r));
    }
  }

  const wyslaneTeraz = wyniki.filter(r => r.status === 'WYSLANA').length;

  return {
    podsumowanie: {
      tryb: PREVIEW ? 'PREVIEW' : 'RUN',
      klientowRazem: grupy.length,
      wyslane: wyslane + wyslaneTeraz,
      pozostalo: kolejka.length - wyslaneTeraz,
      niepewne: niepewne.length,
      bledyWTymPrzebiegu: wyniki.filter(r => r.status === 'BLAD').length,
    },
    niepewne,
  };
}

export const invoke = async ({ payload }) => {
  const start = Date.now();
  const czasMinal = () => Date.now() - start > BUDZET_MS - MIN_ZAPAS_MS;

  try {
    const wynik = PREVIEW
      ? await wykonaj(czasMinal)
      : await zBlokada(() => wykonaj(czasMinal));

    console.log('FAKTURY_PODSUMOWANIE', JSON.stringify(wynik.podsumowanie));

    if (wynik.niepewne.length) {
      console.warn(
        'FAKTURY_NIEPEWNE (sprawdź ręcznie w panelu Faktury):',
        JSON.stringify(wynik.niepewne)
      );
    }
  } catch (e) {
    console.error('FAKTURY_BLAD', e?.message || String(e));
    throw e;
  }

  return {};
};
