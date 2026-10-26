// Atrapy modułów Wix dla Node: pozwalają zaimportować
// CreateInvoicesNovember.js w testach bez platformy Wix.
import { register } from 'node:module';

const atrapy = {
  'wix-data': 'export default {};',
  'wix-billing-backend': 'export const invoices = {};',
  'wix-crm-backend': 'export const contacts = {};',
  'wix-auth': 'export const elevate = f => f;',
  '@wix/ecom':
    'export const orders = {}; export const orderInvoices = {}; ' +
    'export const orderTransactions = {};',
  '@wix/essentials': 'export const auth = { elevate: f => f };'
};

const hooki = `
const atrapy = ${JSON.stringify(atrapy)};
export async function resolve(specifier, context, next) {
  if (atrapy[specifier]) {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(atrapy[specifier])
    };
  }
  return next(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(hooki));
