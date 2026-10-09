// Connects PayPal auto-pay for your own sandbox app.
//
//   node scripts/connect-autopay.mjs
//
// Auto-pay uses the PayPal Vault: a sandbox buyer saves their PayPal account
// once, and your app may then charge it without a login each time. This script
// creates the setup token, waits while you approve it in the browser as a
// sandbox *personal* account, exchanges it for a payment token, and prints the
// line to put in .env.
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
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `intentchain-connect-${Date.now()}` }
      : { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${json.message ?? json.error_description ?? JSON.stringify(json)}`);
  return json;
}

const { access_token } = await paypal('/v1/oauth2/token', 'grant_type=client_credentials');

const setup = await paypal(
  '/v3/vault/setup-tokens',
  JSON.stringify({
    payment_source: {
      paypal: {
        usage_type: 'MERCHANT',
        description: 'IntentChain auto-pay for company purchases',
        experience_context: { return_url: 'https://example.com/approved', cancel_url: 'https://example.com/cancelled' },
      },
    },
  }),
  access_token,
);

console.log('\n1. Open this link and approve as a sandbox PERSONAL (buyer) account:\n');
console.log(`   ${setup.links.find((l) => l.rel === 'approve').href}\n`);
console.log('2. When PayPal redirects you to example.com, come back here.\n');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press Enter once you have approved… ');
rl.close();

const saved = await paypal(
  '/v3/vault/payment-tokens',
  JSON.stringify({ payment_source: { token: { id: setup.id, type: 'SETUP_TOKEN' } } }),
  access_token,
);
console.log(`\nSaved the PayPal account of ${saved.payment_source?.paypal?.email_address ?? 'the buyer'} as payment token ${saved.id}.`);
console.log('\nAdd this line to .env and restart the app:\n');
console.log(`   PAYPAL_AUTOPAY_VAULT_ID=${saved.id}\n`);
