// CTD Toto — generator miesięczny z requiredDates.
// RUN respektuje stany do kontroli i nextAttemptAt,
// także dla jawnych agreementIds.
// ORDER_IN_FLIGHT jest widoczny w postep.doKontroli.
// Brak automatycznego przejmowania starych blokad.
// Zachowane klucze v1 i struktura istniejących dzienników.

import wixData from 'wix-data';
import { contacts } from 'wix-crm-backend';
import {
  bookings,
  services,
  availabilityTimeSlots,
  extendedBookings
} from '@wix/bookings';
import { orders } from '@wix/ecom';
import { auth } from '@wix/essentials';
import { createHash, randomBytes } from 'crypto';

const TZ = 'Europe/Warsaw';
const AGREEMENTS = 'Umowy';
const LEDGER = 'UmowyMiesiace';
const LOCKS = 'GeneratorBlokady';

const APP = '13d21c63-b5ec-5912-8397-c3a5ddb27a97';
const STAFF = '1cd44cf8-756f-41c3-bd90-3e2ffcaf1155';

const DAYS = [
  'niedziela',
  'poniedziałek',
  'wtorek',
  'środa',
  'czwartek',
  'piątek',
  'sobota'
];

const READ = {
  suppressAuth: true,
  suppressHooks: true,
  consistentRead: true
};

const WRITE = {
  suppressAuth: true,
  suppressHooks: true
};

const DONE = ['DONE', 'EMPTY'];

const HOLD = [
  'BLOCKED',
  'CHECK_ORDER',
  'REVIEW_BOOKING',
  'REVIEW_ORDER'
];

const getService = auth.elevate(services.getService);
const listSlots = auth.elevate(
  availabilityTimeSlots.listAvailabilityTimeSlots
);
const queryBookings = auth.elevate(
  extendedBookings.queryExtendedBookings
);
const createBooking = auth.elevate(bookings.createBooking);
const createOrder = auth.elevate(orders.createOrder);
const getOrder = auth.elevate(orders.getOrder);

const idOf = x => x?._id || x?.id;
const ref = x => typeof x === 'string' ? x : idOf(x);
const copy = x => JSON.parse(JSON.stringify(x));
const msg = e => String(e?.message || e).slice(0, 1500);
const cents = x => Math.round(Number(x) * 100);
const money = x => ({ amount: (x / 100).toFixed(2) });

function fail(text, name = 'ReviewError') {
  const e = new Error(text);
  e.name = name;
  throw e;
}

function check(ok, text) {
  if (!ok) fail(text);
}

function stableId(text) {
  const h = createHash('sha256')
    .update(text)
    .digest('hex');

  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-` +
    `5${h.slice(13, 16)}-a${h.slice(17, 20)}-` +
    `${h.slice(20, 32)}`
  );
}

const ledgerId = (month, id) =>
  stableId(`toto/month/v1/${month}/${id}`);

const bookingKey = (month, id, date) =>
  stableId(`toto/booking/v1/${month}/${id}/${date}`);

const orderKey = row =>
  `TOTO:${row.miesiac}:${row.umowaId}`;

const LOCK_ID = stableId('toto/generator/global/v1');
const CLEANUP_ID = stableId('toto/generator/cleanup/v1');
const LOCK_AGE = 5 * 60 * 1000;

function configuration(
  month,
  excludedDates = [],
  requiredDates = []
) {
  check(
    typeof month === 'string' &&
    /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month),
    'Podaj month: YYYY-MM.'
  );

  const [year, number] = month.split('-').map(Number);

  check(year < 9999, 'Nieprawidłowy rok.');

  const count = new Date(
    Date.UTC(year, number, 0)
  ).getUTCDate();

  check(
    Array.isArray(excludedDates),
    'excludedDates musi być tablicą.'
  );

  for (const d of excludedDates) {
    check(
      typeof d === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      d.startsWith(month + '-') &&
      +d.slice(8) >= 1 &&
      +d.slice(8) <= count,
      'Nieprawidłowe excludedDates.'
    );
  }

  // INTAKE: format i przynależność do miesiąca.
  // Dzień tygodnia i zakres umowy sprawdza requiredForNewPlan().
  check(
    Array.isArray(requiredDates),
    'requiredDates musi być tablicą.'
  );

  for (const d of requiredDates) {
    check(
      typeof d === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      d.startsWith(month + '-') &&
      +d.slice(8) >= 1 &&
      +d.slice(8) <= count,
      'Nieprawidłowe requiredDates.'
    );
  }

  return {
    month,
    year,
    number,
    count,
    excludedDates,
    requiredDates: [...new Set(requiredDates)]
  };
}

function local(value) {
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)
  ) {
    return value;
  }

  const p = Object.fromEntries(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(value?.$date || value))
      .map(x => [x.type, x.value])
  );

  return (
    `${p.year}-${p.month}-${p.day}` +
    `T${p.hour}:${p.minute}:${p.second}`
  );
}

const dateOnly = x =>
  !x
    ? null
    : typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)
      ? x
      : local(x).slice(0, 10);

function snapshot(a) {
  check(
    a._id &&
    a.klientContactId &&
    ref(a.usluga) &&
    ref(a.pracownik),
    'Brak ID w umowie.'
  );

  check(
    DAYS.includes(a.dzienTygodnia),
    'Nieprawidłowy dzień tygodnia.'
  );

  check(
    /^([01]\d|2[0-3]):[0-5]\d$/.test(a.godzina),
    'Godzina musi mieć format HH:mm.'
  );

  check(
    typeof a.stawka === 'number' &&
    Number.isFinite(a.stawka) &&
    a.stawka >= 0,
    'Stawka musi być liczbą >= 0.'
  );

  check(
    Math.abs(a.stawka * 100 - cents(a.stawka)) < 0.000001,
    'Stawka: maksymalnie 2 miejsca po przecinku.'
  );

  // Nie zmieniać kolejności:
  // zgodność istniejących fingerprint.
  return {
    agreementId: a._id,
    contactId: a.klientContactId,
    serviceId: ref(a.usluga),
    staffId: ref(a.pracownik),
    day: a.dzienTygodnia,
    time: a.godzina,
    rate: a.stawka,
    start: dateOnly(a.dataZawarcia),
    end: dateOnly(a.dataZakonczenia),
    status: a.status,
    taxRate: 0
  };
}

function datesFor(s, c) {
  const out = [];

  for (let n = 1; n <= c.count; n++) {
    const d = `${c.month}-${String(n).padStart(2, '0')}`;

    if (
      DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()] === s.day &&
      (!s.start || d >= s.start) &&
      (!s.end || d <= s.end)
    ) {
      out.push(d);
    }
  }

  return out;
}

// INTAKE: kontrola przed przygotowaniem nowego planu.
function requiredForNewPlan(s, c) {
  const dates = datesFor(s, c);
  const now = local(new Date());

  for (const d of c.requiredDates) {
    check(
      dates.includes(d),
      `Wymagany termin ${d} nie pasuje do dnia tygodnia ` +
      'lub zakresu umowy — kontrola.'
    );

    check(
      !c.excludedDates.includes(d),
      `Wymagany termin ${d} jest wykluczony — kontrola.`
    );

    check(
      `${d}T${s.time}:00` > now,
      `Wymagany termin ${d} ${s.time} już minął — kontrola.`
    );
  }
}

// INTAKE: kontrola istniejącego planu przy wznowieniu,
// także gdy dziennik ma już DONE albo EMPTY.
function requiredInPlan(row, c) {
  const plan = row.stan?.plan || [];

  for (const date of c.requiredDates) {
    const matches = plan.filter(p => p.date === date);

    if (matches.length !== 1) {
      return `Wymagany termin ${date}: brak albo duplikat pozycji planu.`;
    }

    const p = matches[0];

    if (row.status === 'EMPTY') {
      return `EMPTY nie może zawierać wymaganej wizyty ${date}.`;
    }

    if (!['PENDING', 'BOOKING_IN_FLIGHT', 'BOOKED'].includes(p.status)) {
      return `Wymagany termin ${date}: niedozwolony status ${p.status}.`;
    }

    if (p.status === 'BOOKED' && !p.bookingId) {
      return `Wymagany termin ${date}: BOOKED bez bookingId.`;
    }

    if (row.status === 'DONE' && p.status !== 'BOOKED') {
      return `Wymagany termin ${date}: DONE wymaga BOOKED i bookingId.`;
    }
  }

  return null;
}

function deferred(row, mode) {
  if (!row || mode !== 'RUN') return null;

  if (['CANCELED', 'CANCELLED'].includes(row.status)) {
    return 'Dziennik anulowany. RUN nie wznawia anulowanych miesięcy.';
  }

  if (HOLD.includes(row.status) || row.status === 'ORDER_IN_FLIGHT') {
    return 'Stan wymaga kontroli lub odzyskania; automatyczne ponowienie wstrzymane.';
  }

  if (row.stan?.nextAttemptAt) {
    const next = new Date(row.stan.nextAttemptAt).getTime();

    if (!Number.isFinite(next)) {
      return 'Nieprawidłowe nextAttemptAt — kontrola.';
    }

    if (next > Date.now()) {
      return 'Nie nadszedł termin ponowienia.';
    }
  }

  return null;
}

function budget(seconds, writes) {
  const deadline = Date.now() + seconds * 1000;

  return {
    used: 0,

    expired: () => Date.now() >= deadline,

    stop() {
      return this.expired() || this.used >= writes;
    },

    check() {
      if (this.expired()) {
        fail(
          'Zapisano dotychczasowy postęp; koniec budżetu czasu.',
          'BudgetError'
        );
      }
    }
  };
}

async function all(collection, b, field, value) {
  const result = [];

  for (let offset = 0; ; offset += 100) {
    b?.check();

    let q = wixData.query(collection);

    if (field) q = q.eq(field, value);

    const page = await q
      .ascending('_id')
      .skip(offset)
      .limit(100)
      .find(READ);

    b?.check();
    result.push(...page.items);

    if (page.items.length < 100) return result;
  }
}

async function one(collection, id) {
  const result = await wixData
    .query(collection)
    .eq('_id', id)
    .limit(1)
    .find(READ);

  return result.items[0];
}

async function journal(month, agreementId) {
  const q = await wixData
    .query(LEDGER)
    .eq('miesiac', month)
    .eq('umowaId', agreementId)
    .limit(2)
    .find(READ);

  check(
    q.items.length <= 1,
    'Dwa dzienniki tej samej umowy i miesiąca. Wymagana kontrola.'
  );

  return q.items[0];
}

function old(lock) {
  const time = new Date(lock?._createdDate).getTime();

  return (
    Number.isFinite(time) &&
    Date.now() - time > LOCK_AGE
  );
}

async function release(id, token) {
  const row = await one(LOCKS, id);

  if (row?.token === token) {
    await wixData.remove(LOCKS, id, WRITE);
  }
}

// Nie przejmujemy blokady przez osobne read/delete.
// Stara blokada wymaga kontroli po przerwanym wywołaniu.
async function acquire(month) {
  const token = randomBytes(16).toString('hex');

  if (await one(LOCKS, CLEANUP_ID)) {
    fail(
      'Pozostała blokada odzyskiwania. Sprawdź GeneratorBlokady.',
      'LockReviewError'
    );
  }

  try {
    await wixData.insert(
      LOCKS,
      {
        _id: LOCK_ID,
        title: `Generator ${month}`,
        token
      },
      WRITE
    );
  } catch (error) {
    const existing = await one(LOCKS, LOCK_ID);

    if (!existing || existing.token === token) throw error;

    if (old(existing)) {
      fail(
        'Blokada generatora przekroczyła 5 minut. Wymagana kontrola przed odblokowaniem.',
        'LockReviewError'
      );
    }

    fail(
      'Inne wykonanie ma blokadę. Poczekaj na zakończenie.',
      'BusyError'
    );
  }

  return {
    token,

    async guard() {
      const current = await one(LOCKS, LOCK_ID);

      if (current?.token !== token || old(current)) {
        fail(
          'Utracono blokadę generatora.',
          'LockLostError'
        );
      }
    }
  };
}

function canon(x) {
  if (Array.isArray(x)) return x.map(canon);

  if (x && typeof x === 'object') {
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map(k => [k, canon(x[k])])
    );
  }

  return x;
}

function view(row) {
  return JSON.stringify(canon(copy({
    miesiac: row.miesiac,
    umowaId: row.umowaId,
    klientContactId: row.klientContactId || '',
    status: row.status,
    orderId: row.orderId || '',
    stawka: row.stawka,
    kwota: row.kwota,
    blad: row.blad || '',
    stan: row.stan
  })));
}

async function save(row, lock) {
  await lock.guard();

  const expected = copy(row);

  expected.kwota =
    cents(expected.stawka || 0) *
    (expected.stan.plan || [])
      .filter(p => p.status === 'BOOKED').length /
    100;

  expected.stan.writeToken =
    randomBytes(12).toString('hex');

  try {
    await wixData.update(LEDGER, expected, WRITE);

    // Potwierdzamy zapis także po przekroczeniu
    // miękkiego budżetu czasu.
    const actual = await one(LEDGER, row._id);

    if (!actual || view(actual) !== view(expected)) {
      fail(
        'Zapis i odczyt dziennika różnią się.',
        'JournalPersistenceError'
      );
    }

    // Zachowaj referencje do pozycji używane przez step().
    row.kwota = actual.kwota;
    row.stan.writeToken = actual.stan.writeToken;
    row._updatedDate = actual._updatedDate;

    return row;
  } catch (e) {
    fail(
      `Niepotwierdzony zapis dziennika ${row._id}: ${msg(e)}`,
      'JournalPersistenceError'
    );
  }
}

async function extended(filter, b) {
  const out = [];
  let cursor;

  do {
    b?.check();

    const query = cursor
      ? { cursorPaging: { limit: 100, cursor } }
      : { filter, cursorPaging: { limit: 100 } };

    const page = await queryBookings(
      query,
      { withEcomOrder: true }
    );

    b?.check();

    check(
      Array.isArray(page.extendedBookings),
      'Nieznana odpowiedź Bookings.'
    );

    out.push(...page.extendedBookings);

    const next = page.pagingMetadata?.cursors?.next;

    check(
      !next || next !== cursor,
      'Powtórzony kursor Bookings.'
    );

    cursor = next;
  } while (cursor);

  return out;
}

async function availability(s, date, b) {
  const out = [];
  let cursor;

  do {
    b.check();

    const page = await listSlots(
      cursor
        ? { cursorPaging: { limit: 1000, cursor } }
        : {
            serviceId: s.serviceId,
            fromLocalDate: `${date}T${s.time}:00`,
            toLocalDate: `${date}T23:59:59`,
            timeZone: TZ,
            includeResourceTypeIds: [STAFF],
            cursorPaging: { limit: 1000 }
          }
    );

    b.check();

    check(
      Array.isArray(page.timeSlots),
      'Nieznana odpowiedź dostępności.'
    );

    out.push(...page.timeSlots);

    const meta =
      page.cursorPagingMetadata ||
      page.pagingMetadata;

    const next = meta?.cursors?.next;

    check(
      !meta?.hasNext || (next && next !== cursor),
      'Nieprawidłowy kursor dostępności.'
    );

    cursor = meta?.hasNext ? next : undefined;
  } while (cursor);

  const found = out.filter(x =>
    x.localStartDate === `${date}T${s.time}:00` &&
    x.availableResources?.some(g =>
      g.resourceTypeId === STAFF &&
      g.resources?.some(r => idOf(r) === s.staffId)
    )
  );

  check(
    found.length <= 1,
    'Niejednoznaczna lokalizacja terminu.'
  );

  return found[0];
}

function validateSlot(slot) {
  const p = slot.bookingPolicyViolations || {};

  check(
    Number(slot.remainingCapacity) >= 1,
    'Brak miejsca w terminie.'
  );

  check(
    !p.bookOnlineDisabled,
    'Ograniczenie inne niż okno rezerwacji klienta.'
  );

  // tooLateToBook i tooEarlyToBook dotyczą okna klienta.
  // Przeszłe terminy odcina osobna kontrola w step().
  check(
    slot.bookable === true ||
    p.tooEarlyToBook === true ||
    p.tooLateToBook === true,
    'Niewyjaśniona niedostępność.'
  );

  return (
    p.tooEarlyToBook === true ||
    p.tooLateToBook === true
  );
}

function bookingSlot(slot, s) {
  check(
    slot.scheduleId &&
    slot.localEndDate &&
    idOf(slot.location),
    'Niepełny slot.'
  );

  check(
    slot.location.locationType === 'BUSINESS',
    'Nieobsługiwana lokalizacja.'
  );

  return {
    serviceId: s.serviceId,
    scheduleId: slot.scheduleId,
    startDate: slot.localStartDate,
    endDate: slot.localEndDate,
    timezone: TZ,
    resource: { _id: s.staffId },
    location: {
      _id: idOf(slot.location),
      locationType: 'OWNER_BUSINESS'
    }
  };
}

function conflicts(a, s, active, c) {
  const minutes = t => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const dates = datesFor(s, c).filter(
    d => !c.excludedDates.includes(d)
  );

  for (const other of active) {
    if (
      other._id === a._id ||
      ref(other.pracownik) !== s.staffId ||
      other.dzienTygodnia !== s.day
    ) {
      continue;
    }

    check(
      /^([01]\d|2[0-3]):[0-5]\d$/.test(other.godzina),
      `Błędna godzina w umowie ${other._id}.`
    );

    if (
      Math.abs(
        minutes(other.godzina) - minutes(s.time)
      ) >= 60
    ) {
      continue;
    }

    const start = dateOnly(other.dataZawarcia);
    const end = dateOnly(other.dataZakonczenia);

    check(
      !dates.some(d =>
        (!start || d >= start) &&
        (!end || d <= end)
      ),
      `Kolizja CMS: ${other.klientNazwa}, umowa ${other._id}.`
    );
  }
}

async function buyer(s, b) {
  b.check();

  const c = await contacts.getContact(
    s.contactId,
    { suppressAuth: true }
  );

  b.check();

  check(
    idOf(c) === s.contactId,
    'Kontakt scalony: popraw klientContactId.'
  );

  const email =
    c.primaryInfo?.email ||
    c.info?.emails?.find(x => x.primary)?.email ||
    c.info?.emails?.[0]?.email;

  check(email, 'Brak emaila kontaktu.');

  return {
    contactId: s.contactId,
    email,
    firstName: c.info?.name?.first || '',
    lastName: c.info?.name?.last || ''
  };
}

function report(row) {
  const plan = row.stan?.plan || [];

  return {
    umowaId: row.umowaId,
    status: row.status,
    orderId: row.orderId || null,
    kwota: row.kwota || 0,
    zaplanowane: plan.filter(
      p => p.status !== 'SKIPPED'
    ).length,
    zarezerwowane: plan.filter(
      p => p.status === 'BOOKED'
    ).length,
    pominiete: plan
      .filter(p => p.status === 'SKIPPED')
      .map(p => ({
        data: p.date,
        powod: p.reason
      })),
    blad: row.blad || null
  };
}

function payload(row) {
  const s = row.stan.snapshot;
  const rate = cents(s.rate);
  const visits = row.stan.plan.filter(
    p => p.status === 'BOOKED'
  );

  check(visits.length > 0, 'Puste zamówienie.');

  return {
    buyerInfo: {
      contactId: s.contactId,
      email: row.stan.buyer.email
    },

    billingInfo: {
      contactDetails: {
        firstName: row.stan.buyer.firstName,
        lastName: row.stan.buyer.lastName
      }
    },

    currency: 'PLN',
    buyerLanguage: 'pl',
    status: 'APPROVED',
    paymentStatus: 'NOT_PAID',
    taxIncludedInPrices: true,

    channelInfo: {
      type: 'BACKOFFICE_MERCHANT',
      externalOrderId: orderKey(row)
    },

    buyerNote: `${row.miesiac} | umowa ${row.umowaId}`,

    lineItems: visits.map(p => ({
      _id: p.bookingId,

      productName: {
        original: row.stan.serviceName
      },

      quantity: 1,

      catalogReference: {
        appId: APP,
        catalogItemId: p.bookingId
      },

      itemType: {
        preset: 'SERVICE'
      },

      paymentOption: 'FULL_PAYMENT_OFFLINE',
      price: money(rate),
      totalDiscount: money(0),
      totalPriceBeforeTax: money(rate),
      totalPriceAfterTax: money(rate),

      taxDetails: {
        taxRate: '0',
        totalTax: money(0)
      },

      descriptionLines: [{
        name: {
          original: 'Termin pierwotny / miesiąc rozliczenia'
        },
        plainText: {
          original: `${p.date} ${s.time} / ${row.miesiac}`
        }
      }]
    })),

    priceSummary: {
      subtotal: money(rate * visits.length),
      tax: money(0),
      total: money(rate * visits.length),
      shipping: money(0),
      discount: money(0)
    }
  };
}

function validateOrder(order, row) {
  const visits = row.stan.plan.filter(
    p => p.status === 'BOOKED'
  );

  check(
    idOf(order) &&
    order.buyerInfo?.contactId === row.klientContactId,
    'Inny kontakt zamówienia.'
  );

  check(
    order.channelInfo?.externalOrderId === orderKey(row),
    'Inny miesiąc/umowa zamówienia.'
  );

  check(
    order.currency === 'PLN' &&
    order.status === 'APPROVED',
    'Nieprawidłowy status/waluta zamówienia.'
  );

  check(
    cents(order.priceSummary?.total?.amount) ===
    cents(row.stawka) * visits.length,
    'Nieprawidłowa suma zamówienia.'
  );

  check(
    order.lineItems?.length === visits.length,
    'Nieprawidłowa liczba pozycji zamówienia.'
  );

  for (const p of visits) {
    const found = order.lineItems.filter(x =>
      x.catalogReference?.appId === APP &&
      x.catalogReference?.catalogItemId === p.bookingId
    );

    check(
      found.length === 1 &&
      found[0].quantity === 1 &&
      cents(found[0].totalPriceAfterTax?.amount) ===
      cents(row.stawka),
      'Nieprawidłowa pozycja zamówienia.'
    );

    p.orderLineItemId = idOf(found[0]);
  }
}

function recovered(row, p, x) {
  const b = x.booking;
  const s = row.stan.snapshot;

  check(
    idOf(b) &&
    b.externalUserId === p.key &&
    b.contactDetails?.contactId === s.contactId,
    'Niezgodna tożsamość odzyskiwanej wizyty.'
  );

  check(
    b.bookedEntity?.slot?.serviceId === s.serviceId &&
    b.status === 'CONFIRMED',
    'Niezgodna usługa/status wizyty.'
  );

  check(
    !p.bookingId || p.bookingId === idOf(b),
    'Pozycja ma inne bookingId.'
  );

  check(
    !idOf(x.order) || idOf(x.order) === row.orderId,
    'Wizyta ma inne zamówienie; uzgodnij dziennik.'
  );

  check(
    !row.stan.plan.some(q =>
      q.key !== p.key &&
      q.bookingId === idOf(b)
    ),
    'Ta wizyta występuje dwukrotnie w planie.'
  );
}

async function verify(row, b, lock) {
  b.check();

  const order = await getOrder(row.orderId);

  b.check();
  validateOrder(order, row);

  const expected = row.stan.plan.filter(
    p => p.status === 'BOOKED'
  );

  const actual = await extended({
    id: {
      $in: expected.map(p => p.bookingId)
    }
  }, b);

  const missing = expected.filter(p =>
    !actual.some(x =>
      idOf(x.booking) === p.bookingId &&
      x.booking.status === 'CONFIRMED' &&
      idOf(x.order) === row.orderId
    )
  );

  row.status = missing.length
    ? 'WAITING_LINKS'
    : 'DONE';

  row.blad = missing.length
    ? 'Oczekiwanie na powiązania: ' +
      missing.map(p => p.bookingId).join(', ')
    : '';

  row.stan.nextAttemptAt = missing.length
    ? new Date(Date.now() + 60000).toISOString()
    : null;

  return save(row, lock);
}

function bookingErrorCode(e) {
  if (e?.details?.applicationError?.code) {
    return e.details.applicationError.code;
  }

  try {
    return JSON.parse(
      e?.message || String(e)
    )?.details?.applicationError?.code;
  } catch (_) {
    return null;
  }
}

async function step(row, b, lock) {
  const s = row.stan.snapshot;

  if (row.orderId) {
    return verify(row, b, lock);
  }

  if (
    ['ORDER_IN_FLIGHT', 'REVIEW_ORDER'].includes(row.status)
  ) {
    fail(
      'Niepewny wynik zamówienia: użyj recoverOrder.',
      'OrderReviewError'
    );
  }

  const keys = row.stan.plan
    .filter(p => p.status !== 'SKIPPED')
    .map(p => p.key);

  check(
    keys.every(Boolean) &&
    new Set(keys).size === keys.length,
    'Brak/duplikat klucza planu.'
  );

  for (const p of row.stan.plan) {
    if (['BOOKED', 'SKIPPED'].includes(p.status)) {
      continue;
    }

    if (b.stop()) return row;

    check(
      ['PENDING', 'BOOKING_IN_FLIGHT'].includes(p.status),
      'Nieznany stan pozycji.'
    );

    const found = await extended({
      externalUserId: p.key,
      'contactDetails.contactId': s.contactId
    }, b);

    if (found.length) {
      check(
        found.length === 1,
        'Wiele wizyt dla jednego klucza.'
      );

      recovered(row, p, found[0]);

      Object.assign(p, {
        bookingId: idOf(found[0].booking),
        status: 'BOOKED',
        lastError: null
      });

      row.blad = '';
      await save(row, lock);
      continue;
    }

    if (p.status === 'BOOKING_IN_FLIGHT') {
      if (p.lastError !== 'SLOT_NOT_AVAILABLE') {
        fail(
          `Niepewny zapis wizyty ${p.date}. Użyj recoverBooking.`,
          'BookingReviewError'
        );
      }

      p.status = 'PENDING';
      p.lastError = null;
      await save(row, lock);
    }

    check(
      `${p.date}T${s.time}:00` > local(new Date()),
      'Termin już minął.'
    );

    const fresh = await availability(s, p.date, b);

    check(
      fresh,
      `Dostępność zmieniła się: ${p.date}.`
    );

    const bypass = validateSlot(fresh);

    if (b.stop()) return row;

    p.slot = bookingSlot(fresh, s);
    p.status = 'BOOKING_IN_FLIGHT';
    p.lastError = null;

    row.status = 'RUNNING';
    row.blad = '';

    await save(row, lock);

    if (b.stop()) {
      p.status = 'PENDING';
      await save(row, lock);
      return row;
    }

    await lock.guard();
    b.check();
    b.used++;

    let response;

    try {
      response = await createBooking({
        bookedEntity: {
          slot: copy(p.slot)
        },
        contactDetails: copy(row.stan.buyer),
        totalParticipants: 1,
        status: 'CONFIRMED',
        selectedPaymentOption: 'OFFLINE',
        externalUserId: p.key
      }, {
        participantNotification: {
          notifyParticipants: false
        },
        sendSmsReminder: false,
        flowControlSettings: {
          skipAvailabilityValidation: bypass,
          skipSelectedPaymentOptionValidation: true
        }
      });
    } catch (e) {
      if (bookingErrorCode(e) === 'SLOT_NOT_AVAILABLE') {
        p.lastError = 'SLOT_NOT_AVAILABLE';
        await save(row, lock);
      }

      throw e;
    }

    check(
      idOf(response.booking) &&
      response.booking.status === 'CONFIRMED',
      'Brak potwierdzonego bookingId.'
    );

    Object.assign(p, {
      bookingId: idOf(response.booking),
      status: 'BOOKED',
      lastError: null
    });

    await save(row, lock);
  }

  if (
    row.stan.plan.some(p =>
      !['BOOKED', 'SKIPPED'].includes(p.status)
    )
  ) {
    return row;
  }

  if (
    !row.stan.plan.some(p => p.status === 'BOOKED')
  ) {
    row.status = 'EMPTY';
    return save(row, lock);
  }

  if (b.stop()) return row;

  row.status = 'ORDER_IN_FLIGHT';
  await save(row, lock);

  if (b.stop()) {
    row.status = 'RUNNING';
    await save(row, lock);
    return row;
  }

  await lock.guard();
  b.check();
  b.used++;

  const order = await createOrder(
    payload(row),
    {
      settings: {
        notifications: {
          sendNotificationToBuyer: false,
          sendNotificationsToBusiness: false
        }
      }
    }
  );

  check(idOf(order), 'Brak orderId w odpowiedzi.');

  row.orderId = idOf(order);
  row.status = 'ORDER_CREATED';

  await save(row, lock);

  validateOrder(order, row);
  await save(row, lock);

  return b.stop()
    ? row
    : verify(row, b, lock);
}

async function prepare(
  a,
  row,
  active,
  c,
  b,
  cache,
  lock
) {
  const s = snapshot(a);
  const initialized = Boolean(row.stan?.fingerprint);

  if (initialized) {
    check(
      row.stan.fingerprint === JSON.stringify(s),
      'Umowa zmieniła się od przygotowania planu. Wymagana kontrola.'
    );

    const problem = requiredInPlan(row, c);
    check(!problem, problem);
  } else {
    requiredForNewPlan(s, c);
  }

  if (DONE.includes(row.status)) return row;

  conflicts(a, s, active, c);

  if (!cache.services.has(s.serviceId)) {
    b.check();

    cache.services.set(
      s.serviceId,
      await getService(s.serviceId)
    );

    b.check();
  }

  const service = cache.services.get(s.serviceId);

  check(
    service.type === 'APPOINTMENT',
    'Umowa musi wskazywać APPOINTMENT.'
  );

  check(
    service.staffMemberIds?.includes(s.staffId),
    'Terapeuta nieprzypisany do usługi.'
  );

  check(
    service.payment?.rateType === 'FIXED',
    'Usługa nie ma stałej ceny.'
  );

  if (initialized) return row;

  if (!cache.bookings.has(s.contactId)) {
    cache.bookings.set(
      s.contactId,
      await extended({
        'contactDetails.contactId': s.contactId
      }, b)
    );
  }

  const existing = cache.bookings.get(s.contactId);
  const plan = [];

  for (const date of datesFor(s, c)) {
    b.check();

    if (c.excludedDates.includes(date)) {
      plan.push({
        date,
        status: 'SKIPPED',
        reason: 'HOLIDAY'
      });
      continue;
    }

    const duplicate = existing.find(x =>
      !['CANCELED', 'DECLINED'].includes(x.booking.status) &&
      x.booking.bookedEntity?.slot?.serviceId === s.serviceId &&
      ref(x.booking.bookedEntity?.slot?.resource) === s.staffId &&
      local(
        x.booking.startDate ||
        x.booking.bookedEntity?.slot?.startDate
      ) === `${date}T${s.time}:00`
    );

    check(
      !duplicate,
      `Istnieje wizyta poza dziennikiem: ${
        idOf(duplicate?.booking)
      }. Uzgodnij powiązania.`
    );

    const slot = await availability(s, date, b);

    if (!slot) {
      // Wymagany termin zatrzymuje proces przed zapisem planu.
      check(
        !c.requiredDates.includes(date),
        `Brak wolnego wymaganego terminu ${date} ${s.time} — kontrola.`
      );

      plan.push({
        date,
        status: 'SKIPPED',
        reason: 'NO_AVAILABLE_SLOT'
      });
      continue;
    }

    validateSlot(slot);

    plan.push({
      date,
      key: bookingKey(c.month, a._id, date),
      status: 'PENDING',
      lastError: null,
      slot: bookingSlot(slot, s)
    });
  }

  const contact = await buyer(s, b);

  row.stawka = s.rate;
  row.klientContactId = s.contactId;
  row.status = 'RUNNING';
  row.blad = '';

  row.stan = {
    ...row.stan,
    version: 1,
    fingerprint: JSON.stringify(s),
    snapshot: s,
    serviceName: service.name,
    buyer: contact,
    plan
  };

  if (lock) await save(row, lock);

  return row;
}

function retryable(e) {
  return (
    /\b(429|500|502|503|504)\b|deadline exceeded|timed? ?out|timeout|temporarily unavailable|ECONNRESET/i
  ).test(msg(e));
}

function group(rows) {
  const map = new Map();

  for (const row of rows) {
    const list = map.get(row.umowaId) || [];
    list.push(row);
    map.set(row.umowaId, list);
  }

  return map;
}

function progress(active, rows) {
  const map = group(rows);

  let finished = 0;
  let blocked = 0;
  let waiting = 0;

  const issues = [];

  for (const a of active) {
    const list = map.get(a._id) || [];
    const r = list[0];

    if (list.length > 1) {
      blocked++;
      issues.push({
        umowaId: a._id,
        status: 'DUPLICATE_JOURNAL'
      });
    } else if (r && DONE.includes(r.status)) {
      finished++;
    } else if (
      r &&
      (
        HOLD.includes(r.status) ||
        r.status === 'ORDER_IN_FLIGHT'
      )
    ) {
      // POPRAWKA: niepewne zamówienie jest widoczne
      // w doKontroli mimo wstrzymania przez deferred().
      blocked++;

      const issue = report(r);

      if (r.status === 'ORDER_IN_FLIGHT') {
        issue.blad =
          issue.blad ||
          'Niepewny wynik tworzenia zamówienia. Sprawdź zamówienie i użyj recoverOrder; nie twórz kolejnego.';
      }

      issues.push(issue);
    } else if (
      r &&
      new Date(r.stan?.nextAttemptAt || 0).getTime() >
      Date.now()
    ) {
      waiting++;
    }
  }

  return {
    aktywne: active.length,
    zakonczone: finished,
    odlozone: blocked,
    oczekujace: waiting,
    pozostale: active.length - finished,
    doKontroli: issues
  };
}

/**
 * @param {Object} [options]
 * @param {string} [options.month]
 * @param {string} [options.mode]
 * @param {string[]} [options.agreementIds] Puste: automatyczny wybór partii.
 * @param {number} [options.batchSize]
 * @param {number} [options.maxWrites]
 * @param {number} [options.maxSeconds]
 * @param {string[]} [options.excludedDates]
 * @param {string[]} [options.requiredDates] Wymagane terminy,
 *   tylko z dokładnie jedną jawną umową.
 */
export async function runGenerator({
  month = '',
  mode = 'PREVIEW',
  agreementIds = [],
  batchSize = 3,
  maxWrites = 8,
  maxSeconds = 30,
  excludedDates = [],
  requiredDates = []
} = {}) {
  const c = configuration(
    month,
    excludedDates,
    requiredDates
  );

  check(
    ['STATUS', 'PREVIEW', 'RUN', 'VERIFY'].includes(mode),
    'Nieprawidłowy mode.'
  );

  check(
    Array.isArray(agreementIds) &&
    agreementIds.every(x =>
      typeof x === 'string' && x
    ),
    'Nieprawidłowe agreementIds.'
  );

  check(
    Number.isInteger(batchSize) &&
    batchSize >= 1 &&
    batchSize <= 3,
    'batchSize: 1–3.'
  );

  check(
    Number.isInteger(maxWrites) &&
    maxWrites >= 1 &&
    maxWrites <= 20,
    'maxWrites: 1–20.'
  );

  check(
    Number.isFinite(maxSeconds) &&
    maxSeconds >= 5 &&
    maxSeconds <= 35,
    'maxSeconds: 5–35.'
  );

  agreementIds = [...new Set(agreementIds)];

  check(
    mode === 'STATUS' || agreementIds.length <= 3,
    'Maksymalnie 3 jawne ID.'
  );

  check(
    !c.requiredDates.length ||
    (
      ['PREVIEW', 'RUN'].includes(mode) &&
      agreementIds.length === 1
    ),
    'requiredDates wymaga trybu PREVIEW/RUN i dokładnie jednej umowy.'
  );

  const b = budget(maxSeconds, maxWrites);
  const result = [];

  let lock;
  let active = [];
  let rows = [];

  try {
    if (['RUN', 'VERIFY'].includes(mode)) {
      lock = await acquire(month);
    }

    rows = await all(
      LEDGER,
      b,
      'miesiac',
      month
    );

    if (mode === 'STATUS') {
      return rows
        .filter(r =>
          !agreementIds.length ||
          agreementIds.includes(r.umowaId)
        )
        .map(report);
    }

    active = (await all(AGREEMENTS, b))
      .filter(a => a.status === 'aktywna');

    const map = group(rows);

    for (const id of agreementIds) {
      check(
        active.some(a => a._id === id),
        `Brak aktywnej umowy ${id}.`
      );
    }

    let selected;

    if (agreementIds.length) {
      selected = agreementIds.map(
        id => active.find(a => a._id === id)
      );
    } else {
      selected = active
        .filter(a => {
          const list = map.get(a._id) || [];
          const r = list[0];

          return (
            list.length <= 1 &&
            (
              !r ||
              (
                !DONE.includes(r.status) &&
                !deferred(r, 'RUN') &&
                !HOLD.includes(r.status) &&
                new Date(
                  r.stan?.nextAttemptAt || 0
                ).getTime() <= Date.now()
              )
            )
          );
        })
        .sort((a, z) => {
          const x = map.get(a._id)?.[0];
          const y = map.get(z._id)?.[0];

          const tx = x
            ? new Date(
                x.stan?.lastAttemptAt ||
                x._updatedDate ||
                0
              ).getTime()
            : 0;

          const ty = y
            ? new Date(
                y.stan?.lastAttemptAt ||
                y._updatedDate ||
                0
              ).getTime()
            : 0;

          return tx - ty || a._id.localeCompare(z._id);
        })
        .slice(0, batchSize);
    }

    const cache = {
      services: new Map(),
      bookings: new Map()
    };

    for (const a of selected) {
      if (b.stop()) break;

      const list = map.get(a._id) || [];

      if (list.length > 1) {
        result.push({
          umowaId: a._id,
          status: 'DUPLICATE_JOURNAL'
        });
        continue;
      }

      let row = list[0];

      const postponed = deferred(row, mode);

      if (postponed) {
        result.push({
          ...report(row),
          klient: a.klientNazwa,
          uwaga: postponed,
          nastepnaProba: row.stan?.nextAttemptAt || null
        });
        continue;
      }

      if (
        row &&
        DONE.includes(row.status) &&
        mode !== 'VERIFY'
      ) {
        // Zakończony miesiąc bez wymaganego terminu
        // nie może być raportowany jako sukces.
        const problem = requiredInPlan(row, c);

        result.push(
          problem
            ? {
                ...report(row),
                status: 'BLOCKED',
                blad: problem,
                klient: a.klientNazwa
              }
            : report(row)
        );
        continue;
      }

      try {
        if (mode === 'VERIFY') {
          check(
            row?.orderId,
            'Brak orderId do VERIFY.'
          );

          await verify(row, b, lock);
        } else {
          if (!row) {
            row = {
              _id: ledgerId(month, a._id),
              title: `${month} | ${a.klientNazwa} | ${a._id}`,
              miesiac: month,
              umowaId: a._id,
              klientContactId: a.klientContactId || '',
              status: 'QUEUED',
              orderId: '',
              stawka:
                typeof a.stawka === 'number' &&
                Number.isFinite(a.stawka)
                  ? a.stawka
                  : 0,
              kwota: 0,
              blad: '',
              stan: {
                version: 1,
                plan: [],
                lastAttemptAt: new Date().toISOString()
              }
            };

            if (mode === 'RUN') {
              await lock.guard();
              b.check();

              row = await wixData.insert(
                LEDGER,
                copy(row),
                WRITE
              );

              rows.push(row);
              map.set(a._id, [row]);
            }
          } else if (mode === 'PREVIEW') {
            row = copy(row);
          }

          if (mode === 'RUN') {
            row.stan = {
              ...row.stan,
              lastAttemptAt: new Date().toISOString(),
              nextAttemptAt: null
            };

            await save(row, lock);
            b.check();
          }

          row = await prepare(
            a,
            row,
            active,
            c,
            b,
            cache,
            mode === 'RUN' ? lock : null
          );

          if (mode === 'RUN') {
            row.blad = '';
            await step(row, b, lock);
          } else {
            row.status = 'PREVIEW';
          }
        }

        result.push({
          ...report(row),
          klient: a.klientNazwa
        });
      } catch (e) {
        if (
          [
            'JournalPersistenceError',
            'LockLostError'
          ].includes(e?.name)
        ) {
          throw e;
        }

        if (e?.name === 'BudgetError') {
          result.push({
            umowaId: a._id,
            status: row?.status || 'QUEUED',
            uwaga: msg(e)
          });
          break;
        }

        if (row && mode !== 'PREVIEW') {
          if (
            !row.orderId &&
            [
              'ORDER_IN_FLIGHT',
              'REVIEW_ORDER'
            ].includes(row.status)
          ) {
            row.status = 'REVIEW_ORDER';
          } else if (
            row.stan?.plan?.some(p =>
              p.status === 'BOOKING_IN_FLIGHT' &&
              p.lastError !== 'SLOT_NOT_AVAILABLE'
            )
          ) {
            row.status = 'REVIEW_BOOKING';
          } else if (retryable(e)) {
            row.status = 'RETRY';
          } else {
            row.status = row.orderId
              ? 'CHECK_ORDER'
              : 'BLOCKED';
          }

          row.blad = msg(e);

          row.stan.nextAttemptAt =
            row.status === 'RETRY'
              ? new Date(Date.now() + 60000).toISOString()
              : null;

          await save(row, lock);
        }

        result.push({
          umowaId: a._id,
          klient: a.klientNazwa,
          status:
            mode === 'PREVIEW'
              ? 'BLOCKED'
              : row?.status || 'BLOCKED',
          blad: msg(e)
        });
      }
    }

    return {
      mode,
      miesiac: month,
      noweZapisy: b.used,
      limitOsiagniety: b.stop(),
      result,
      postep: progress(active, rows)
    };
  } catch (e) {
    if (['BusyError', 'LockReviewError'].includes(e?.name)) {
      return {
        mode,
        miesiac: month,
        status: e.name === 'BusyError' ? 'BUSY' : 'LOCK_REVIEW',
        noweZapisy: 0,
        blad: msg(e)
      };
    }

    if (e?.name === 'BudgetError') {
      return {
        mode,
        miesiac: month,
        noweZapisy: b.used,
        limitOsiagniety: true,
        result,
        uwaga: msg(e)
      };
    }

    throw e;
  } finally {
    if (lock) {
      await release(LOCK_ID, lock.token);
    }
  }
}

export async function recoverOrder({
  month,
  agreementId,
  knownOrderId
} = {}) {
  configuration(month);

  const b = budget(30, 1);
  const lock = await acquire(month);

  try {
    const row = await journal(month, agreementId);

    check(
      row &&
      !row.orderId &&
      [
        'ORDER_IN_FLIGHT',
        'REVIEW_ORDER'
      ].includes(row.status),
      'Nie ma zamówienia do odzyskania.'
    );

    b.check();

    const order = await getOrder(knownOrderId);

    b.check();
    validateOrder(order, row);

    row.orderId = idOf(order);
    row.status = 'ORDER_CREATED';
    row.blad = '';

    await save(row, lock);

    return report(await verify(row, b, lock));
  } finally {
    await release(LOCK_ID, lock.token);
  }
}

export async function recoverBooking({
  month,
  agreementId,
  originalDate,
  knownBookingId
} = {}) {
  configuration(month);

  const b = budget(30, 1);
  const lock = await acquire(month);

  try {
    const row = await journal(month, agreementId);

    check(row, 'Brak dziennika.');

    const matches = row.stan.plan.filter(p =>
      p.key === bookingKey(
        month,
        agreementId,
        originalDate
      )
    );

    check(
      matches.length === 1,
      'Brak jednoznacznej pozycji planu.'
    );

    const p = matches[0];

    check(
      [
        'PENDING',
        'BOOKING_IN_FLIGHT',
        'BOOKED'
      ].includes(p.status),
      'Pozycja nie kwalifikuje się do odzyskania.'
    );

    const found = await extended({
      id: {
        $in: [knownBookingId]
      }
    }, b);

    check(
      found.length === 1 &&
      idOf(found[0].booking) === knownBookingId,
      'Brak jednoznacznej wizyty.'
    );

    recovered(row, p, found[0]);

    Object.assign(p, {
      bookingId: knownBookingId,
      status: 'BOOKED',
      lastError: null
    });

    row.status = 'RUNNING';
    row.blad = '';
    row.stan.nextAttemptAt = null;

    await save(row, lock);

    return report(row);
  } finally {
    await release(LOCK_ID, lock.token);
  }
}

export async function diagnoseJournal({ month } = {}) {
  configuration(month);

  const lock = await acquire(month);
  let row;

  try {
    const id = 'diag-' + randomBytes(12).toString('hex');

    row = await wixData.insert(
      LEDGER,
      {
        _id: id,
        title: 'Diagnostyka',
        miesiac: 'DIAGNOSTIC',
        umowaId: id,
        klientContactId: '',
        status: 'DIAGNOSTIC',
        orderId: '',
        stawka: 0,
        kwota: 0,
        blad: '',
        stan: {
          version: 1,
          plan: [{
            date: `${month}-01`,
            key: id,
            status: 'PENDING',
            lastError: null
          }]
        }
      },
      WRITE
    );

    await save(row, lock);

    row.stan.plan[0] = {
      ...row.stan.plan[0],
      status: 'BOOKING_IN_FLIGHT',
      slot: {
        startDate: `${month}-01T08:00:00`,
        resource: { _id: 'diag' }
      },
      lastError: null
    };

    await save(row, lock);

    row.stan.plan[0].status = 'BOOKED';
    row.stan.plan[0].bookingId = id;

    await save(row, lock);

    return {
      status: 'PASS',
      updatesVerified: 3,
      zeroRate: true,
      nullVerified: true
    };
  } finally {
    try {
      if (row) {
        await wixData.remove(LEDGER, row._id, WRITE);
      }
    } finally {
      await release(LOCK_ID, lock.token);
    }
  }
}
