import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

const main = readFileSync(new URL('../google/owner/Code.gs', import.meta.url), 'utf8');

function environment() {
  const events = [], store = new Map(), permissions = new Map(), props = new Map([['HMAC_SECRET', 'x'.repeat(40)]]);
  const iterator = values => { let i = 0; return { hasNext: () => i < values.length, next: () => values[i++] }; };
  let settings, counter = 0;
  const blob = { getBytes: () => [1, 2, 3] };
  const file = (id, name = id, parents = [], content = '') => {
    const value = { id, name, parents, content, trashed: false,
      getId: () => id, getName: () => value.name, getMimeType: () => 'docs',
      getOwner: () => ({ getEmail: () => 'kontakt@centrumtoto.pl' }),
      getBlob: () => ({ getDataAsString: () => value.content }),
      setContent: text => { value.content = text; },
      getParents: () => iterator(value.parents.map(parent => ({ getId: () => parent }))),
      getAs: () => blob,
      getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
      setSharing: (...args) => events.push(['share', id, ...args]),
      moveTo: folder => { events.push(['archive', id]); value.parents = [folder.id]; },
      setTrashed: flag => { events.push(['trash', id]); value.trashed = flag; }
    };
    store.set(id, value);
    return value;
  };
  const context = vm.createContext({
    console,
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    HtmlService: { createHtmlOutput: text => ({ text, setTitle() { return this; } }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'kontakt@centrumtoto.pl' }), getEffectiveUser: () => ({ getEmail: () => 'kontakt@centrumtoto.pl' }) },
    Utilities: {
      base64Decode: value => [...Buffer.from(value, "base64")],
      newBlob: bytes => ({ bytes }),
      getUuid: () => 'a'.repeat(32), Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, value) => [...createHash('sha256').update(value).digest()],
      computeHmacSha256Signature: (value, secret) => [...createHmac('sha256', secret).update(value).digest()]
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, hasLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    MimeType: { PDF: 'pdf', PLAIN_TEXT: 'text', GOOGLE_DOCS: 'docs' },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'anyone', PRIVATE: 'private' }, Permission: { VIEW: 'view', NONE: 'none' },
      getFileById: id => { if (!store.has(id)) throw Error('missing'); return store.get(id); },
      getFolderById: id => ({ id,
        getFilesByName: name => iterator([...store.values()].filter(item => item.parents.includes(id) && item.name === name)),
        getFiles: () => iterator([...store.values()].filter(item => item.parents.includes(id) && !item.trashed)),
        createFile: (name, content) => file('record-' + ++counter, name, [id], content)
      })
    },
    Drive: {
      Files: {
        list: ({ q }) => ({ files: [...store.values()].filter(item => !item.trashed && item.tag &&
          q.includes("key='" + item.tag.name + "'") && q.includes("value='" + item.tag.value + "'"))
          .map(item => ({ id: item.id })) }),
        copy: meta => {
          const result = file('copy-' + ++counter, meta.name, meta.parents);
          const entry = Object.entries(meta.appProperties).find(([, value]) => value !== null);
          result.tag = { name: entry[0], value: entry[1] };
          events.push(['copy', result.id]);
          return { id: result.id };
        },
        create: meta => {
          const result = file('pdf-' + ++counter, meta.name, meta.parents);
          result.tag = { name: Object.keys(meta.appProperties)[0], value: Object.values(meta.appProperties)[0] };
          events.push(['pdf', result.id]);
          return { id: result.id };
        }
      },
      Permissions: {
        list: id => ({ permissions: permissions.get(id) || [] }),
        create: (permission, id, options) => {
          events.push(['permission', id, permission.emailAddress, options.sendNotificationEmail]);
          permissions.set(id, [...(permissions.get(id) || []), permission]);
        }
      }
    },
    MailApp: { sendEmail: (...args) => events.push(['mail', ...args]) }
  });
  vm.runInContext(main, context);
  settings = vm.runInContext('SETTINGS', context);
  settings.enabled = true;
  settings.folders.ledger = 'ledger';
  settings.templates['ados-2'] = 'template';
  file('template', 'Szablon ADOS-2');
  settings.templates['si-opinia'] = 'template';
  file(settings.templates['diagnoza-informacja-terapia'], 'Diagnoza / Informacja z przebiegu terapii');
  context.encrypt_ = () => blob;
  const request = {
    bookingId: 'booking-id-test', serviceId: '94fb8eaf-697a-470a-bb44-892e656b58f9',
    staffId: 'staff-id-test', templateKey: 'ados-2', clientName: 'Klient Testowy',
    staffEmail: 'therapist@example.com', clientEmail: 'parent@example.com', childBirthDate: '2020-01-23'
  };
  return { context, store, events, settings, request, file };
}

test('ponowiona rezerwacja tworzy jeden dokument i dwa powiadomienia o edycji', async () => {
  const e = environment();
  const first = e.context.createRecord_(e.request);
  const second = e.context.createRecord_(e.request);
  assert.equal(first.documentId, second.documentId);
  assert.equal(e.events.filter(event => event[0] === 'copy').length, 1);
  assert.equal(e.events.filter(event => event[0] === 'permission').length, 2);
  assert.ok(e.events.filter(event => event[0] === 'permission').every(event => event[3] === true));
  assert.equal(e.events.filter(event => event[0] === 'mail').length, 0);
});

function approved(e) {
  const created = e.context.createRecord_(e.request);
  const recordFile = [...e.store.values()].find(item => item.name.endsWith('.json'));
  const record = e.context.loadRecord_(recordFile.id);
  e.context.approve_(record);
  return { record, created };
}

test('zatwierdzenie i wielokrotne wykonanie kolejki wysyła raz, potem archiwizuje', async () => {
  const e = environment();
  const { record } = approved(e);
  await e.context.deliver_(record);
  await e.context.deliver_(record);
  assert.equal(record.status, 'DONE');
  assert.equal(e.events.filter(event => event[0] === 'mail').length, 1);
  const mail = e.events.findIndex(event => event[0] === 'mail');
  const archive = e.events.findIndex(event => event[0] === 'archive');
  assert.ok(archive > mail);
  assert.equal(e.events[mail][1], 'parent@example.com');
  assert.match(e.events[mail][3], /DDMMRRRR/);
});

test('niejednoznaczny wynik wysyłki blokuje automatyczne ponowienie', async () => {
  const e = environment();
  const { record } = approved(e);
  let sends = 0;
  e.context.MailApp.sendEmail = () => { sends++; throw Error('timeout after possible delivery'); };
  await assert.rejects(() => e.context.deliver_(record));
  assert.equal(record.status, 'SENDING');
  await e.context.processQueue();
  assert.equal(e.context.loadRecord_(record.recordId).status, 'SEND_REVIEW');
  assert.equal(sends, 1);
  assert.equal(e.events.filter(event => event[0] === 'archive').length, 0);
});

test('po terminie do kosza trafia PDF, dokument źródłowy pozostaje', async () => {
  const e = environment();
  const { record } = approved(e);
  await e.context.deliver_(record);
  record.expiresAt = Date.now() - 1000;
  e.context.saveRecord_(record);
  e.context.expireLinks();
  assert.equal(e.store.get(record.pdfId).trashed, true);
  assert.equal(e.store.get(record.documentId).trashed, false);
  assert.equal(e.context.loadRecord_(record.recordId).status, 'EXPIRED');
});

test('zmiana odbiorcy pod tym samym ID rezerwacji wymaga kontroli', async () => {
  const e = environment();
  e.context.createRecord_(e.request);
  assert.throws(() => e.context.createRecord_({ ...e.request, clientEmail: 'wrong@example.com' }), /BOOKING_CHANGED_REVIEW/);
});

test('brak daty nie pozwala zatwierdzić, data ręczna jest walidowana', async () => {
  const e = environment();
  e.request.childBirthDate = null;
  e.context.createRecord_(e.request);
  const file = [...e.store.values()].find(item => item.name.endsWith('.json'));
  const record = e.context.loadRecord_(file.id);
  assert.throws(() => e.context.approve_(record), /BIRTH_DATE/);
  assert.throws(() => e.context.approve_(record, '2020-02-31'), /BIRTH_DATE/);
  assert.equal(e.context.approve_(record, '2020-01-23').status, 'QUEUED');
});

test('awaria szyfrowania nie upublicznia pliku ani nie wysyła maila', async () => {
  const e = environment();
  const { record } = approved(e);
  e.context.encrypt_ = () => { throw Error('encryption unavailable'); };
  await assert.rejects(() => e.context.deliver_(record));
  assert.equal(e.events.filter(event => ['share', 'mail', 'pdf'].includes(event[0])).length, 0);
});

test('brama odrzuca fałszywy podpis przed utworzeniem dokumentu', async () => {
  const e = environment();
  const body = JSON.stringify(e.request);
  const timestamp = String(Date.now());
  const response = e.context.doPost({ postData: { contents: JSON.stringify({
    action: 'create', timestamp, body, signature: 'bad'
  }) } });
  assert.equal(JSON.parse(response.text).code, 'UNAUTHORIZED');
  assert.equal(e.events.length, 0);
});

test('podpisany webhook działa, manipulacja treścią i stary podpis są odrzucane', async () => {
  const e = environment();
  const body = JSON.stringify(e.request), timestamp = String(Date.now());
  const signature = createHmac('sha256', 'x'.repeat(40)).update(timestamp + '.' + body).digest('hex');
  const call = data => JSON.parse(e.context.doPost({ postData: { contents: JSON.stringify(data) } }).text);
  const envelope = { action: 'create', timestamp, body, signature };
  assert.equal(call(envelope).ok, true);
  assert.equal(call({ ...envelope, body: body.replace('parent@', 'wrong@') }).code, 'UNAUTHORIZED');
  assert.equal(call({ ...envelope, timestamp: String(Date.now() - 600000) }).code, 'UNAUTHORIZED');
});


test('ręczne zlecenie z szablonu jest idempotentne i używa tej samej kolejki', () => {
  const e = environment();
  const input = { requestId: '11111111-1111-4111-a111-111111111111', templateKey: 'ados-2',
    clientName: 'Klient Testowy', clientEmail: 'parent@example.com',
    staffEmail: 'sabina.baranowska@centrumtoto.pl', birthDate: '2020-01-23' };
  const first = e.context.adminCreateOrder(input);
  const second = e.context.adminCreateOrder(input);
  assert.equal(first.recordId, second.recordId);
  assert.equal(first.documentId, second.documentId);
  assert.equal(e.context.adminApproveOrder(first.recordId).status, 'QUEUED');
});
test('panel nie udziela dostępu anonimowemu ani nieuprawnionemu kontu', () => {
  const e = environment();
  e.context.Session.getActiveUser = () => ({ getEmail: () => '' });
  assert.throws(() => e.context.adminBootstrap(), /ADMIN_IDENTITY_UNAVAILABLE/);
  e.context.Session.getActiveUser = () => ({ getEmail: () => 'outsider@example.com' });
  assert.throws(() => e.context.adminCreateOrder({}), /ADMIN_ACCESS_DENIED/);
});
test('lista Workspace pobiera wszystkie strony i pomija konta zawieszone', () => {
  const e = environment();
  e.settings.staffDirectory.enabled = true;
  let calls = 0;
  e.context.AdminDirectory = { Users: { list: options => {
    calls++;
    if (!options.pageToken) return { users: [
      { primaryEmail: 'one@centrumtoto.pl', name: { fullName: 'Anna' } },
      { primaryEmail: 'disabled@centrumtoto.pl', suspended: true }
    ], nextPageToken: 'next' };
    return { users: [{ primaryEmail: 'two@centrumtoto.pl', name: { fullName: 'Zofia' } }] };
  } } };
  const result = e.context.adminBootstrap();
  assert.equal(calls, 2);
  assert.equal(result.staff.length, 2);
});
test('kod JavaScript panelu jest poprawny składniowo', () => {
  const e = environment();
  const html = e.context.doGet().text;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});


test('ręczna kopia istniejącego dokumentu nie zmienia źródła', () => {
  const e = environment();
  const original = e.file('existing-document-1234', 'Istniejąca opinia', ['original-folder']);
  const result = e.context.adminCreateOrder({
    requestId: '22222222-2222-4222-a222-222222222222', templateKey: 'ados-2',
    clientName: 'Klient Testowy', clientEmail: 'parent@example.com',
    staffEmail: 'sabina.baranowska@centrumtoto.pl', birthDate: '2020-01-23',
    sourceDocumentId: original.id
  });
  assert.notEqual(result.documentId, original.id);
  assert.equal(original.parents[0], 'original-folder');
  assert.equal(original.trashed, false);
});
test('ręczne zlecenie odrzuca pracownika spoza dozwolonej listy', () => {
  const e = environment();
  assert.throws(() => e.context.adminCreateOrder({
    requestId: '33333333-3333-4333-a333-333333333333', templateKey: 'ados-2',
    clientName: 'Klient Testowy', clientEmail: 'parent@example.com',
    staffEmail: 'outsider@example.com', birthDate: '2020-01-23'
  }), /STAFF_NOT_ALLOWED/);
  assert.equal(e.events.length, 0);
});

test('HTML maila ukrywa URL i odrzuca niepoprawne adresy', () => {
  const e = environment();
  const html = e.context.documentationEmailHtml_('https://drive.google.com/file/d/test/view?a=1&b=2');
  assert.ok(html.includes('view?a=1&amp;b=2"'));
  assert.ok(html.includes('>Pobierz dokumentację</a>'));
  assert.ok(html.includes('DDMMRRRR'));
  assert.throws(() => e.context.documentationEmailHtml_('javascript:alert(1)'), /PDF_LINK_INVALID/);
});
