// Run against reviewed checkout: node --import ./tests/wix-stub.mjs --test reviews/november-944a44c.regression.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {_test as api} from '../CreateInvoicesNovember.js';
test('REVIEW P1: invoice with changed service and price must be rejected',()=>{
 const op={_id:'op',invoiceId:'i',klientContactId:'c',kwotaGrosze:64000,
 pozycje:[{nazwa:'Logopedia',cena:16000,ilosc:4}]};
 const invoice={id:{id:'i',version:1},customer:{contactId:'c'},currency:'PLN',metadata:{sourceRefId:'op'},totals:{total:640},
 lineItems:[{name:'Inna usługa',price:640,quantity:1}]};
 assert.ok(api.sprawdzFakture(invoice,op).length>0,'Validator accepted changed service/quantity/unit price');
});
test('REVIEW P1: missing required source amounts must not normalize as valid zero',()=>{
 const raw={_id:'o',lineItems:[{_id:'l',quantity:1,productName:{original:'Terapia'}}],priceSummary:{}};
 let rejected=false;
 try {rejected=api.normalizujZamowienie(raw).problemy.length>0;} catch {rejected=true;}
 assert.ok(rejected,'Missing price/subtotal/total were accepted as valid zero');
});
