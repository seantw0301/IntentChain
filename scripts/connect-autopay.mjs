// Connects PayPal auto-pay for your own sandbox app.
//
//   node scripts/connect-autopay.mjs
//
// Auto-pay needs a billing agreement: a sandbox buyer approves once that your
// app may charge them without a login each time. This script creates the
// request, waits while you approve it in the browser as a sandbox *personal*
// account, then prints the agreement id to put in .env.
//
// Reads PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from .env. Sandbox only.

import fs from 'node:fs';
import readline from 'node:readline/promises';

const API = 'https://api-m.sandbox.paypal.com';
const env = Object.fromEntries(
  (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const id = process.env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.');
  process.exit(1);
}

async function paypal(path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${json.message ?? json.error_description ?? JSON.stringify(json)}`);
  return json;
}

const { access_token } = await paypal('/v1/oauth2/token', 'grant_type=client_credentials');

const request = await paypal(
  '/v1/billing-agreements/agreement-tokens',
  JSON.stringify({
    description: 'IntentChain auto-pay for company purchases',
    payer: { payment_method: 'PAYPAL' },
    plan: {
      type: 'MERCHANT_INITIATED_BILLING',
      merchant_preferences: {
        return_url: 'https://example.com/approved',
        cancel_url: 'https://example.com/cancelled',
        accepted_pymt_type: 'INSTANT',
        skip_shipping_address: true,
      },
    },
  }),
  access_token,
);

console.log('\n1. Open this link and approve as a sandbox PERSONAL (buyer) account:\n');
console.log(`   ${request.links.find((l) => l.rel === 'approval_url').href}\n`);
console.log('2. When PayPal redirects you to example.com, come back here.\n');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press Enter once you have approved… ');
rl.close();

const agreement = await paypal('/v1/billing-agreements/agreements', JSON.stringify({ token_id: request.token_id }), access_token);
console.log(`\nAgreement ${agreement.id} is ${agreement.state} for ${agreement.payer?.payer_info?.email}.`);
console.log('\nAdd this line to .env and restart the app:\n');
console.log(`   PAYPAL_AUTOPAY_AGREEMENT_ID=${agreement.id}\n`);
