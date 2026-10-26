// Testy scenariuszowe fakturowania listopada 2026 (atrapy API Wix).
// Numeracja = lista wymaganych przypadków.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  srodowisko,
  przygotujIZatwierdz,
  wykonajWszystko,
  swiat,
  zamowienie
} from './atrapy.js';
import { K, S } from '../faktury/rozliczenia.js';

const ANNA = 'c-anna';
const BEATA = 'c-beata';

const kat = (podglad, orderId) =>
  podglad.tabela.find(w => w.orderId === orderId)?.kategoria;

const faktury = env => [...env.inv.faktury.values()];

const sumaFaktur = env =>
  faktury(env).reduce((s, f) => s + Math.round(f.totals.total * 100), 0);

// ------------------------------------------------------

test('1. jedno zamówienie bez rabatu', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.proponowaneFaktury.length, 1);
  assert.equal(p.proponowaneFaktury[0].razem, '640.00');
  assert.equal(p.kontroleOk, true);

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);

  const [f] = faktury(env);
  assert.equal(f.title, 'Listopad 2026');
  assert.equal(f.currency, 'PLN');
  assert.equal(f.totals.total, 640);
  assert.equal(f.lineItems.length, 1);
  assert.equal(f.lineItems[0].quantity, 4);
  assert.equal(f.lineItems[0].price, 160);
  assert.equal(f.wasSent, true);
  assert.equal(env.inv.wysylki, 1);

  const due = new Date(f.dates.dueDate) - new Date(f.dates.issueDate);
  assert.equal(due, 5 * 24 * 3600 * 1000);
});

test('2. dwa zamówienia jednego klienta bez rabatów — jedna faktura, dwie pozycje', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', telefon: '48600100200',
      umowy: [
        { umowaId: 'u1', usluga: 'Terapia logopedyczna', cena: 160, wizyty: 4 },
        { umowaId: 'u2', usluga: 'Terapia neurologopedyczna', cena: 180, wizyty: 4 }
      ]
    }
  ]);

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);

  const all = faktury(env);
  assert.equal(all.length, 1);
  assert.equal(all[0].lineItems.length, 2);
  assert.equal(all[0].totals.total, 1360);
  assert.equal(all[0].customer.phone, '48600100200');
  assert.equal(all[0].customer.fullName, 'Anna Nowak');

  const op = (await env.proces.status()).operacje[0];
  assert.deepEqual(op.orderIds, ['ord-u1', 'ord-u2']);
  assert.equal(op.status, S.SENT);
  assert.equal(op.invoiceId, all[0].id.id);
  assert.ok(op.invoiceVersion >= 1);
});

test('3. dwa zamówienia z osobnymi rabatami — każdy rabat dokładnie raz', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ id: 'r1', kwota: 160 }] },
        { umowaId: 'u2', usluga: 'Terapia neurologopedyczna', cena: 180, wizyty: 4, rabaty: [{ id: 'r2', kwota: 180 }] }
      ]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.sumy.brutto, '1360.00');
  assert.equal(p.sumy.rabaty, '340.00');
  assert.equal(p.sumy.netto, '1020.00');

  const plan = p.proponowaneFaktury[0];
  const ujemne = plan.pozycje.filter(x => Number(x.cena) < 0);
  assert.equal(ujemne.length, 2);
  assert.deepEqual(ujemne.map(x => x.cena).sort(), ['-160.00', '-180.00']);
  assert.equal(plan.razem, '1020.00');

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  assert.equal(faktury(env)[0].totals.total, 1020);
});

test('4. rabat równy cenie jednej wizyty', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ kwota: 160 }] }] }
  ]);

  const plan = (await env.proces.podglad()).proponowaneFaktury[0];
  // Liczba wizyt pozostaje 4 — rabat jest osobną pozycją, nie zmniejsza ilości.
  assert.equal(plan.pozycje[0].ilosc, 4);
  assert.equal(plan.pozycje[1].cena, '-160.00');
  assert.equal(plan.razem, '480.00');
});

test('5. rabat niepodzielny przez cenę wizyty', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ kwota: 53.33 }] }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.proponowaneFaktury[0].razem, '586.67');
  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  assert.equal(faktury(env)[0].totals.total, 586.67);
});

test('6. jedno zamówienie wcześniej opłacone (z fakturą), drugie nie', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, paymentStatus: 'PAID', zaplacono: 640, fakturyWix: [{ id: 'old-inv', appId: 'x' }], platnosci: [{ _id: 'p1' }] },
        { umowaId: 'u2', cena: 180, wizyty: 4 }
      ]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ROZLICZONE);
  assert.equal(kat(p, 'ord-u2'), K.DO_FAKTURY);
  assert.equal(p.sumy.juzRozliczone, '640.00');
  assert.equal(p.sumy.doNowychFaktur, '720.00');
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
});

test('7. zamówienie PAID bez potwierdzonej faktury — ręczna decyzja', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, paymentStatus: 'PAID', zaplacono: 640, platnosci: [{ _id: 'p1' }] },
        { umowaId: 'u2', cena: 160, wizyty: 4 }
      ]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.sumy.doSprawdzenia, '640.00');
  assert.equal(p.proponowaneFaktury.length, 1);
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);

  // Opcja: wstrzymanie całego klienta.
  const env2 = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, paymentStatus: 'PAID', zaplacono: 640 },
        { umowaId: 'u2', cena: 160, wizyty: 4 }
      ]
    }
  ], { wstrzymajKlientaPrzyPrzegladzie: true });
  const p2 = await env2.proces.podglad();
  assert.equal(p2.proponowaneFaktury.length, 0);
  assert.equal(p2.sumy.doSprawdzenia, '1280.00');
});

test('8. zamówienie zafakturowane, ale nadal NOT_PAID — bez drugiej faktury', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, fakturyWix: [{ id: 'inv-old', appId: 'x' }] }]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ROZLICZONE);
  assert.equal(p.proponowaneFaktury.length, 0);

  // Ten sam przypadek, gdy faktura jest tylko w naszym dzienniku.
  const env2 = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] }
  ]);
  await przygotujIZatwierdz(env2);
  await wykonajWszystko(env2);
  const p2 = await env2.proces.podglad();
  assert.equal(kat(p2, 'ord-u1'), K.ROZLICZONE);
  assert.equal(p2.proponowaneFaktury.length, 0);
  await przygotujIZatwierdz(env2).catch(() => {});
  await wykonajWszystko(env2);
  assert.equal(env2.inv.utworzenia, 1);
});

test('9. zamówienie częściowo opłacone — ręczna decyzja', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, paymentStatus: 'PARTIALLY_PAID', zaplacono: 320, platnosci: [{ _id: 'p' }] }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /częściowo/);
  assert.equal(p.proponowaneFaktury.length, 0);
});

test('10. zamówienie anulowane — wykluczone, należność widoczna w sumach', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4, status: 'CANCELED' }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ANULOWANE);
  assert.equal(p.sumy.anulowane, '640.00');
  assert.equal(p.kontroleSum.rozbicieZgodne, true);
  assert.equal(p.proponowaneFaktury.length, 0);
});

test('11. dwa różne kontakty o tym samym nazwisku — osobne faktury', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'nowak@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] },
    { contactId: 'c-anna-2', nazwa: 'Anna Nowak', email: 'nowak@x.pl', umowy: [{ umowaId: 'u2', cena: 160, wizyty: 4 }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.proponowaneFaktury.length, 2);
  assert.ok(p.ostrzezenia.some(o => /różnych kontaktów/.test(o)));
  assert.ok(p.ostrzezenia.some(o => /Ten sam e-mail/.test(o)));

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  const ids = faktury(env).map(f => f.customer.contactId).sort();
  assert.deepEqual(ids, [ANNA, 'c-anna-2']);
});

test('12. ponowny RUN po utworzeniu części faktur', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] },
    { contactId: 'c-cezary', nazwa: 'Cezary Lis', email: 'c@x.pl', umowy: [{ umowaId: 'u3' }] }
  ]);

  await przygotujIZatwierdz(env);
  const r1 = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r1.wyniki.length, 1);
  assert.equal(env.inv.utworzenia, 1);

  // Tylko tworzenie, bez wysyłki.
  const r2 = await env.proces.wykonaj({ maxOperacji: 1, etap: 'UTWORZ' });
  assert.equal(r2.wyniki[0].status, S.CREATED);

  await wykonajWszystko(env);
  await wykonajWszystko(env);

  assert.equal(env.inv.utworzenia, 3);
  assert.equal(env.inv.wysylki, 3);
  const st = await env.proces.status();
  assert.deepEqual(st.statusy, { SENT: 3 });
});

test('13. awaria bezpośrednio po createInvoice() — bez ponownego tworzenia', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);

  // Faktura powstaje, ale zapis CREATED do dziennika nie dochodzi.
  env.db.awaria = (op, c, item) => op === 'update' && item.status === S.CREATED;
  await assert.rejects(env.proces.wykonaj({ maxOperacji: 1 }), /Niepotwierdzony zapis/);
  env.db.awaria = null;
  assert.equal(env.inv.utworzenia, 1);

  // Blokada wygasa dopiero po 5 min — symulujemy jej zwolnienie przez administratora.
  await env.db.remove(env.cfg.kolekcje.blokady, (await env.db.find(env.cfg.kolekcje.blokady))[0]?._id);

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.uporzadkowaneNiepewne[0].powodPrzegladu, 'CREATE_UNCERTAIN');
  assert.equal(env.inv.utworzenia, 1, 'nie wolno utworzyć drugiej faktury');

  // Kolejne RUN-y nadal nic nie tworzą.
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);

  // PREVIEW pokazuje należność jako wymagającą sprawdzenia.
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.proponowaneFaktury.length, 0);

  // Administrator znajduje fakturę w panelu i przypina ją do operacji.
  const op = r.uporzadkowaneNiepewne[0].operationId;
  const zly = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURY_BRAK' });
  assert.equal(zly.status, 'ODMOWA');

  const ok = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURA_ISTNIEJE', invoiceId: 'inv-1' });
  assert.equal(ok.status, 'OK');
  assert.equal(ok.operacja.status, S.CREATED);

  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal(env.inv.wysylki, 1);
});

test('13b. createInvoice zwraca błąd (timeout po utworzeniu) — NEEDS_REVIEW, RUN zatrzymany', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] }
  ]);
  await przygotujIZatwierdz(env);
  env.inv.awariaTworzenia = 'po';

  const r = await env.proces.wykonaj({ maxOperacji: 2 });
  assert.match(r.zatrzymano, /CREATE_UNCERTAIN/);
  assert.equal(r.wyniki.length, 1);
  assert.equal(env.inv.utworzenia, 1);

  // Administrator stwierdza brak faktury? Tu faktura istnieje — przypina ją.
  const op = r.doRecznejDecyzji[0].operationId;
  const res = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURA_ISTNIEJE', invoiceId: 'inv-1' });
  assert.equal(res.status, 'OK');
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 2);
  assert.equal(env.inv.wysylki, 2);
});

test('13c. createInvoice odrzucony przed utworzeniem — FAKTURY_BRAK pozwala ponowić', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);
  env.inv.awariaTworzenia = 'przed';
  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  const op = r.doRecznejDecyzji[0].operationId;
  env.inv.awariaTworzenia = null;

  const res = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'FAKTURY_BRAK', potwierdzam: true });
  assert.equal(res.operacja.status, S.APPROVED);
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 1);
  assert.equal(env.inv.wysylki, 1);
});

test('14. awaria bezpośrednio po sendInvoice() — bez ponownej wysyłki', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);

  // Wysyłka się udała, ale zapis SENT nie dochodzi do dziennika.
  env.db.awaria = (op, c, item) => op === 'update' && item.status === S.SENT;
  await assert.rejects(env.proces.wykonaj({ maxOperacji: 1 }), /Niepotwierdzony zapis/);
  env.db.awaria = null;
  await env.db.remove(env.cfg.kolekcje.blokady, (await env.db.find(env.cfg.kolekcje.blokady))[0]?._id);

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.uporzadkowaneNiepewne[0].status, S.SENT);
  assert.equal(env.inv.wysylki, 1, 'faktura wysłana dokładnie raz (jeden SMS)');
});

test('14b. sendInvoice zwraca błąd, a wasSent = false — NEEDS_REVIEW, bez ponowienia', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);
  env.inv.awariaWysylki = 'przed';

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.wyniki[0].powodPrzegladu, 'SEND_UNCERTAIN');
  env.inv.awariaWysylki = null;

  await wykonajWszystko(env);
  assert.equal(env.inv.wysylki, 0);

  const op = r.wyniki[0].operationId;
  const odm = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'WYSLIJ_PONOWNIE' });
  assert.equal(odm.status, 'ODMOWA');
  await env.proces.rozstrzygnij({ operationId: op, decyzja: 'WYSLIJ_PONOWNIE', potwierdzam: true });
  await wykonajWszystko(env);
  assert.equal(env.inv.wysylki, 1);
});

test('14c. sendInvoice timeout po wysłaniu — rozstrzygnięcie WYSLANA', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await przygotujIZatwierdz(env);
  env.inv.awariaWysylki = 'po';
  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  const op = r.wyniki[0].operationId;
  assert.equal(r.wyniki[0].status, S.NEEDS_REVIEW);

  const res = await env.proces.rozstrzygnij({ operationId: op, decyzja: 'WYSLANA' });
  assert.equal(res.operacja.status, S.SENT);
  assert.equal(env.inv.wysylki, 1);
});

test('15. dwa równoległe uruchomienia — jedno BUSY, faktury bez duplikatów', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2' }] }
  ]);
  await przygotujIZatwierdz(env);

  const [a, b] = await Promise.all([
    env.proces.wykonaj({ maxOperacji: 5 }),
    env.proces.wykonaj({ maxOperacji: 5 })
  ]);

  assert.equal([a, b].filter(r => r.status === 'BUSY').length, 1);
  assert.equal(env.inv.utworzenia, 2);
  assert.equal(env.inv.wysylki, 2);

  // Równoległe PREPARE też się wykluczają, a przypisania są unikalne.
  const env2 = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  const [x, y] = await Promise.all([env2.proces.przygotuj(), env2.proces.przygotuj()]);
  assert.equal([x, y].filter(r => r.status === 'BUSY').length, 1);
});

test('15b. generator cykli pracuje — fakturowanie czeka', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  const { GENERATOR_LOCK_ID } = await import('../faktury/dziennik.js');
  await env.db.insert(env.cfg.kolekcje.blokady, { _id: GENERATOR_LOCK_ID, token: 't' });
  const r = await env.proces.przygotuj();
  assert.equal(r.status, 'BUSY');
});

test('16. rabat obniżający wartość zamówienia do zera', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 1, rabaty: [{ kwota: 160 }] },
        { umowaId: 'u2', cena: 180, wizyty: 4 }
      ]
    }
  ]);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ZEROWE);
  assert.equal(p.sumy.rabaty, '160.00');
  assert.equal(p.sumy.zerowe, '0.00');
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
  assert.equal(p.kontroleOk, true);
});

test('17. dwa zamówienia z różnymi usługami i identyczną ceną — osobne pozycje', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', usluga: 'Terapia logopedyczna', cena: 160, wizyty: 4 },
        { umowaId: 'u2', usluga: 'Terapia integracji sensorycznej', cena: 160, wizyty: 3 }
      ]
    }
  ]);

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  const [f] = faktury(env);
  assert.equal(f.lineItems.length, 2);
  assert.deepEqual(
    f.lineItems.map(l => [l.name, l.quantity, l.price]),
    [['Terapia logopedyczna', 4, 160], ['Terapia integracji sensorycznej', 3, 160]]
  );
  assert.equal(f.totals.total, 1120);
});

test('18. suma nowych faktur = rozliczenie zamówień źródłowych', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ kwota: 160 }] },
        { umowaId: 'u2', cena: 180, wizyty: 5, rabaty: [{ kwota: 90.5 }] }
      ]
    },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u3', cena: 150, wizyty: 3 }] },
    { contactId: 'c-c', nazwa: 'Cezary Lis', email: 'c@x.pl', umowy: [{ umowaId: 'u4', paymentStatus: 'PAID', zaplacono: 640 }] },
    { contactId: 'c-d', nazwa: 'Dorota Lis', email: 'd@x.pl', umowy: [{ umowaId: 'u5', status: 'CANCELED' }] },
    { contactId: 'c-e', nazwa: 'Ewa Lis', email: 'e@x.pl', umowy: [{ umowaId: 'u6', fakturyWix: [{ id: 'i' }] }] }
  ]);

  const p = await env.proces.podglad();
  assert.equal(p.kontroleOk, true);
  // 640 + 900 + 450 + 640 + 640 + 640 = 3910 brutto; rabaty 250.50
  assert.equal(p.sumy.brutto, '3910.00');
  assert.equal(p.sumy.rabaty, '250.50');
  assert.equal(p.sumy.netto, '3659.50');
  assert.equal(p.sumy.doNowychFaktur, '1739.50');
  assert.equal(p.sumy.doSprawdzenia, '640.00');
  assert.equal(p.sumy.anulowane, '640.00');
  assert.equal(p.sumy.juzRozliczone, '640.00');

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);

  assert.equal(sumaFaktur(env), 173950);
  assert.equal(env.inv.utworzenia, 2);

  // Po RUN: nowe należności przeszły do „już rozliczone”, nic nie zniknęło.
  const po = await env.proces.podglad();
  assert.equal(po.sumy.juzRozliczone, '2379.50');
  assert.equal(po.sumy.doNowychFaktur, '0.00');
  assert.equal(po.sumy.netto, p.sumy.netto);
  assert.equal(po.kontroleOk, true);
});

// ------------------------------------------------------
// Dodatkowe zabezpieczenia
// ------------------------------------------------------

test('PREVIEW nie zapisuje niczego i nie wywołuje Wix Invoices', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }, { umowaId: 'u2' }] }
  ]);
  const przed = env.db.zapisy;
  await env.proces.podglad();
  await env.proces.podglad();
  assert.equal(env.db.zapisy, przed);
  assert.equal(env.zdarzenia.filter(z => z[0] !== 'kontakt').length, 0);
});

test('drugie zamówienie klienta po wystawieniu pierwszej faktury — druga faktura tylko na resztę', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] }
  ]);
  const env = srodowisko(w);
  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);

  // Później pojawia się drugi, rozliczony cykl tego samego klienta.
  const { wierszCyklu } = await import('./atrapy.js');
  const o2 = zamowienie({ id: 'ord-u2', numer: 2000, contactId: ANNA, umowaId: 'u2', cena: 180, wizyty: 4, rabaty: [{ kwota: 180 }] });
  w.orders.set('ord-u2', o2);
  w.umowy.set('u2', { _id: 'u2', klientContactId: ANNA, klientNazwa: 'Anna Nowak' });
  const row = wierszCyklu(o2, { umowaId: 'u2', stawka: 180 });
  env.db.kolekcje.get(env.cfg.kolekcje.umowyMiesiace).set(row._id, row);

  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.ROZLICZONE);
  assert.deepEqual(p.proponowaneFaktury[0].orderIds, ['ord-u2']);
  assert.equal(p.proponowaneFaktury[0].razem, '540.00');

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  assert.equal(env.inv.utworzenia, 2);
  assert.deepEqual(faktury(env).map(f => f.totals.total), [640, 540]);
});

test('zmiana zamówienia po zatwierdzeniu — NEEDS_REVIEW zamiast faktury', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', cena: 160, wizyty: 4 }] }
  ]);
  await przygotujIZatwierdz(env);

  // Klient zapłacił między zatwierdzeniem a RUN.
  const o = env.w.orders.get('ord-u1');
  o.paymentStatus = 'PAID';
  o.balanceSummary.paid = { amount: '640.00' };

  const r = await env.proces.wykonaj({ maxOperacji: 1 });
  assert.equal(r.wyniki[0].status, S.NEEDS_REVIEW);
  assert.equal(r.wyniki[0].powodPrzegladu, 'ZMIANA_DANYCH');
  assert.equal(env.inv.utworzenia, 0);

  // Operację, która nie doszła do createInvoice, można anulować.
  const a = await env.proces.rozstrzygnij({ operationId: r.wyniki[0].operationId, decyzja: 'ANULUJ', uwagi: 'opłacone gotówką' });
  assert.equal(a.operacja.status, S.CANCELLED);
});

test('APPROVE wymaga zgodnej liczby i sumy', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  await env.proces.przygotuj();
  const zle = await env.proces.zatwierdz({ wszystkie: true, oczekiwanaLiczba: 1, oczekiwanaSuma: '600.00' });
  assert.equal(zle.status, 'ODMOWA');
  const r = await env.proces.wykonaj();
  assert.equal(r.wyniki.length, 0, 'bez zatwierdzenia RUN nic nie robi');
  const ok = await env.proces.zatwierdz({ wszystkie: true, oczekiwanaLiczba: 1, oczekiwanaSuma: '640.00' });
  assert.equal(ok.status, 'OK');
});

test('niepotwierdzone API faktur zamówień blokuje PREPARE', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  env.gateway.awariaApi.faktury = true;
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.gotoweDoPrzygotowania, false);
  const r = await env.proces.przygotuj();
  assert.equal(r.status, 'ODMOWA');
});

test('dodatkowe zamówienie z tym samym kluczem umowy — do sprawdzenia', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  w.dodatkoweKlucze.set('dup', zamowienie({ id: 'ord-dup', numer: 9, contactId: ANNA, umowaId: 'u1' }));
  const env = srodowisko(w);
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.match(p.doRecznejDecyzji[0].powod, /ord-dup/);
});

test('zamówienie innego kontaktu niż umowa — nie trafia na fakturę', async () => {
  const w = swiat([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  w.orders.get('ord-u1').buyerInfo.contactId = BEATA;
  const env = srodowisko(w);
  const p = await env.proces.podglad();
  assert.equal(kat(p, 'ord-u1'), K.DO_SPRAWDZENIA);
  assert.equal(p.proponowaneFaktury.length, 0);
});

test('tryb INVOICE_DISCOUNT — rabat faktury zamiast ujemnych pozycji', async () => {
  const env = srodowisko([
    {
      contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl',
      umowy: [
        { umowaId: 'u1', cena: 160, wizyty: 4, rabaty: [{ kwota: 160 }] },
        { umowaId: 'u2', cena: 180, wizyty: 4, rabaty: [{ kwota: 180 }] }
      ]
    }
  ], { trybRabatu: 'INVOICE_DISCOUNT' });
  env.inv.odrzucUjemne = true;

  await przygotujIZatwierdz(env);
  await wykonajWszystko(env);
  const [f] = faktury(env);
  assert.equal(f.lineItems.length, 2);
  assert.deepEqual(f.discount, { value: 340, type: 'Fixed' });
  assert.equal(f.totals.total, 1020);
});

test('Wix odrzuca ujemne pozycje — NEEDS_REVIEW i zatrzymanie partii', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1', rabaty: [{ kwota: 160 }] }] },
    { contactId: BEATA, nazwa: 'Beata Kowal', email: 'b@x.pl', umowy: [{ umowaId: 'u2', rabaty: [{ kwota: 160 }] }] }
  ]);
  env.inv.odrzucUjemne = true;
  await przygotujIZatwierdz(env);
  const r = await env.proces.wykonaj({ maxOperacji: 2 });
  assert.equal(r.wyniki.length, 1);
  assert.ok(r.zatrzymano);
  assert.equal(env.inv.utworzenia, 0);
});

test('stara blokada wymaga decyzji administratora', async () => {
  const env = srodowisko([
    { contactId: ANNA, nazwa: 'Anna Nowak', email: 'a@x.pl', umowy: [{ umowaId: 'u1' }] }
  ]);
  const { LOCK_ID } = await import('../faktury/dziennik.js');
  await env.db.insert(env.cfg.kolekcje.blokady, { _id: LOCK_ID, token: 'x' });
  env.db.kolekcje.get(env.cfg.kolekcje.blokady).get(LOCK_ID)._createdDate = '2026-01-01T00:00:00Z';

  const r = await env.proces.wykonaj();
  assert.equal(r.status, 'LOCK_REVIEW');
  assert.equal((await env.proces.zwolnijBlokade()).status, 'ODMOWA');
  assert.equal((await env.proces.zwolnijBlokade({ potwierdzam: true })).status, 'ZWOLNIONA');
  assert.notEqual((await env.proces.wykonaj()).status, 'LOCK_REVIEW');
});
