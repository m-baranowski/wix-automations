import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../google/template/Menu.gs', import.meta.url), 'utf8');

function menu(choice, needsBirthDate = false) {
  const calls = [], alerts = [];
  const ui = {
    ButtonSet: { YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
    Button: { YES: 'YES', NO: 'NO', OK: 'OK' },
    alert: (...args) => { alerts.push(args); return choice; },
    prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => '23.01.2020' })
  };
  const context = vm.createContext({
    DocumentApp: { getUi: () => ui, getActiveDocument: () => ({
      getId: () => 'doc-id', saveAndClose: () => calls.push('flush')
    }) },
    DriveApp: { getFileById: () => ({ getDescription: () => JSON.stringify({
      totoDocumentation: { recordId: 'record-id', token: 'secret-capability' }
    }) }) }
  });
  vm.runInContext(source, context);
  context.totoRequest_ = (action, request) => {
    calls.push({ action, request: JSON.parse(JSON.stringify(request)) });
    if (action === 'preview') return { status: 'DRAFT', clientName: 'Klient Testowy',
      clientEmail: 'parent@example.com', needsBirthDate };
    return { status: 'QUEUED' };
  };
  context.zatwierdzIWyslij();
  return { calls, alerts };
}

test('odmowa w potwierdzeniu nie zleca wysyłki', () => {
  const { calls, alerts } = menu('NO');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'preview');
  assert.match(alerts[0][1], /parent@example.com/);
});
test('potwierdzenie utrwala dokument przed zleceniem wysyłki', () => {
  const { calls } = menu('YES');
  assert.deepEqual(calls.map(call => typeof call === 'string' ? call : call.action), ['preview', 'flush', 'approve']);
});
test('brakująca data z okna jest przekazywana jako jednoznaczna data ISO', () => {
  const { calls } = menu('YES', true);
  assert.equal(calls.at(-1).request.birthDate, '2020-01-23');
});
