// JEDYNY plik do wklejenia w akcję „Uruchom kod Velo”.
// Zachowaj typy/komentarze wygenerowane przez Wix nad invoke().
const CONFIG = {
  enabled: false, // Włącz dopiero po konfiguracji i teście na sztucznych danych.
  bookingIdPath: 'booking_id',
  // Potwierdzone w schematach formularzy centrumtoto.pl 27.10.2026.
  // Ścieżki są względne wobec { booking, payload, submission }.
  childBirthDatePath: 'submission.submissions.data_urodzenia_dziecka',
  documentNamePath: '',
  // Nazwa pliku pochodzi od klienta rezerwującego, data hasła od dziecka.
  documentFirstNamePath: 'booking.contactDetails.firstName',
  documentLastNamePath: 'booking.contactDetails.lastName',
  services: {
    '385f98a1-e497-4b61-a437-455846850cb3': {
      templateKey: 'si-opinia', formId: '00000000-0000-0000-0000-000000000000'
    },
    '94fb8eaf-697a-470a-bb44-892e656b58f9': {
      templateKey: 'ados-2', formId: '12e9f90c-00af-4283-8cd7-53311529aa3f'
    }
  },
  // Rezerwacja zazwyczaj zawiera resource.email. Mapa rozstrzyga braki lub
  // nieaktualny adres. Kluczem jest ID zasobu/pracownika, nie jego nazwisko.
  staffEmails: {},
  webAppUrlSecret: 'TOTO_DOCS_WEBAPP_URL',
  hmacSecret: 'TOTO_DOCS_HMAC_SECRET'
};

function at(object, path) {
  if (!path) return undefined;
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function dateParts(value) {
  if (typeof value !== 'string') throw new Error('BIRTH_DATE_REQUIRED');
  let year, month, day;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match) [, year, month, day] = match;
  else {
    match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
    if (!match) throw new Error('BIRTH_DATE_FORMAT');
    [, day, month, year] = match;
  }
  const date = new Date(`${year}-${month}-${day}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== +year ||
      date.getUTCMonth() + 1 !== +month || date.getUTCDate() !== +day ||
      +year < 1900 || date > new Date()) throw new Error('BIRTH_DATE_INVALID');
  return { iso: `${year}-${month}-${day}`, password: `${day}${month}${year}` };
}

function email(value) {
  const result = String(value || '').trim().toLowerCase();
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(result)) {
    throw new Error('EMAIL_INVALID');
  }
  return result;
}

function prepareRequest(booking, payload, config, submission = null) {
  const slot = booking.bookedEntity?.slot;
  if (!slot) throw new Error('SLOT_BOOKING_REQUIRED');
  const rule = config.services[slot.serviceId];
  if (!rule) return null;
  if (booking.status !== 'CONFIRMED') return null;
  const context = { booking, payload, submission };
  const first = String(at(context, config.documentFirstNamePath) || '').trim();
  const last = String(at(context, config.documentLastNamePath) || '').trim();
  const fullName = String(at(context, config.documentNamePath) || '').trim();
  if (!fullName && (!first || !last)) throw new Error('DOCUMENT_NAME_REQUIRED');
  const staffId = slot.resource?._id || slot.resource?.id;
  if (!staffId) throw new Error('ASSIGNED_STAFF_REQUIRED');
  const birthDate = at(context, config.childBirthDatePath);
  return {
    bookingId: booking._id || booking.id,
    serviceId: slot.serviceId,
    staffId,
    staffEmail: email(config.staffEmails[staffId] || slot.resource?.email),
    clientEmail: email(booking.contactDetails?.email),
    clientName: fullName || `${first} ${last}`,
    childBirthDate: birthDate == null || birthDate === '' ? null : dateParts(birthDate).iso,
    templateKey: rule.templateKey
  };
}

import { extendedBookings } from '@wix/bookings';
import { secrets } from '@wix/secrets';
import { submissions } from '@wix/forms';
import { auth } from '@wix/essentials';
import { fetch } from 'wix-fetch';
import { createHmac } from 'crypto';

const queryBookings = auth.elevate(extendedBookings.queryExtendedBookings);
const readSecret = auth.elevate(secrets.getSecretValue);
const getSubmission = auth.elevate(submissions.getSubmission);

async function utworzDokumentacje(payload) {
  if (!CONFIG.enabled) throw new Error('DOCUMENTATION_DISABLED');
  if (!Object.keys(CONFIG.services).length) {
    throw new Error('DOCUMENTATION_CONFIGURATION_REQUIRED');
  }
  const bookingId = String(at(payload, CONFIG.bookingIdPath) || '');
  if (!/^[a-zA-Z0-9-]{10,100}$/.test(bookingId)) throw new Error('BOOKING_ID_INVALID');
  const result = await queryBookings({
    filter: { id: { $eq: bookingId } },
    cursorPaging: { limit: 2 }
  });
  const rows = result.extendedBookings || [];
  const booking = rows.length === 1 && rows[0].booking;
  if (!booking || (booking._id || booking.id) !== bookingId) {
    throw new Error('BOOKING_NOT_UNIQUE');
  }
  const rule = CONFIG.services[booking.bookedEntity?.slot?.serviceId];
  if (!rule || booking.status !== 'CONFIRMED') return { skipped: true };
  const submission = booking.formSubmissionId ? await getSubmission(booking.formSubmissionId) : null;
  if (submission && (submission.formId !== rule.formId ||
      submission.namespace !== 'wix.bookings.v2.bookings')) {
    throw new Error('BOOKING_FORM_MISMATCH');
  }
  const request = prepareRequest(booking, payload, CONFIG, submission);
  if (!request) return { skipped: true };
  const [endpoint, secret] = await Promise.all([
    readSecret(CONFIG.webAppUrlSecret), readSecret(CONFIG.hmacSecret)
  ]);
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(endpoint.value)) {
    throw new Error('WEBAPP_URL_INVALID');
  }
  const body = JSON.stringify(request);
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret.value)
    .update(`${timestamp}.${body}`).digest('hex');
  const response = await fetch(endpoint.value, {
    method: 'post',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', timestamp, body, signature })
  });
  if (!response.ok) throw new Error('GOOGLE_GATEWAY_HTTP_ERROR');
  let answer;
  try { answer = await response.json(); }
  catch (_) { throw new Error('GOOGLE_GATEWAY_NOT_JSON_CHECK_DEPLOYMENT'); }
  if (!answer.ok) throw new Error(`GOOGLE_GATEWAY_${answer.code || 'FAILED'}`);
  // Nie loguj payloadu, daty urodzenia ani adresów.
  return { created: true, documentId: answer.documentId };
}

export const invoke = async ({ payload }) => {
  await utworzDokumentacje(payload);
  return {};
};
