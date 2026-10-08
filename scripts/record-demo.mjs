// Records the demo walkthrough as a narrated video.
//
//   node scripts/record-demo.mjs [base-url]        default http://localhost:3100
//
// Playwright drives the real app and records the screen. The narration is
// synthesized with the macOS `say` command, one clip per scene, and each scene
// lasts at least as long as its clip. ffmpeg then lays the clips onto the
// recording at the moments their scenes started.
//
// PayPal sandbox mode: buyer approval needs a human. Run with HEADED=1; when
// the PayPal page appears, log in and approve as the sandbox buyer. The time
// you spend there is cut out of the final video automatically.
//
// Requires: macOS (`say`), ffmpeg, and `npx playwright install chromium`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ORIGIN = (process.argv[2] || 'http://localhost:3100').replace(/\/$/, '');
const APP = `${ORIGIN}/intentchain`;
const OUT = path.resolve('video');
const VOICE = process.env.VOICE || 'Samantha';
const RATE = process.env.RATE || '172';
const HEADED = process.env.HEADED === '1';
const VIEW = { width: 1120, height: 630 }; // small viewport, recorded at 1080p, so text stays readable

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Synthesizes one narration clip and returns its path and length in seconds. */
function speak(id, text) {
  const file = path.join(OUT, 'audio', `${id}.aiff`);
  run('say', ['-v', VOICE, '-r', RATE, '-o', file, text]);
  const seconds = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]));
  return { file, seconds };
}

// ---- the script: what is said, and what happens on screen while it is said ----

const SCENES = [
  {
    id: 'intro',
    say: 'Your AI agent just delegated your task to another agent. And that agent delegated it again. So who makes sure it is still what you asked for? This is IntentChain: an intent integrity firewall for multi-agent commerce, built on PayPal.',
    do: async (p) => {
      await card(p, ['Your agent delegated your task to another agent.', 'That agent delegated it again.', 'Who makes sure it is still what you asked for?']);
      await sleep(9500);
      await card(p, null);
    },
  },
  {
    id: 'intent',
    say: 'I ask for a Tokyo business trip, with six hundred dollars. One sentence becomes a structured intent: the root that every payment must trace back to.',
    do: async (p) => {
      await sleep(1500);
      await guide(p);
      await view(p, '.panel');
    },
  },
  {
    id: 'chain',
    say: 'When I confirm, authority flows down a chain of agents. Each grant is smaller than its parent: less money, a narrower scope, and fewer PayPal tools. The hotel agent can search, but holds no PayPal tools at all. And every grant is signed over its parent’s signature.',
    do: async (p) => {
      await guide(p);
      await view(p, '.chain');
    },
  },
  {
    id: 'esim',
    say: 'The travel agent buys an e-SIM. All four checks pass, so the firewall lets it call PayPal through the Agent Toolkit. I approve as the buyer, and the payment is captured.',
    do: async (p) => {
      await guide(p);
      await view(p, '.checks');
      await sleep(3500);
      await pay(p);
      await view(p, '.checks');
    },
  },
  {
    id: 'attack',
    say: 'Now an attack. An agent requests a grant with the same five hundred dollars, plus one new capability. Same amount, but not a subset. Rejected. And when the booking agent tries a seven hundred and eighty dollar suite, it is stopped, and named as the source.',
    do: async (p) => {
      await sleep(1200);
      await guide(p);
      await view(p, '.note.block');
      await sleep(8500);
      await guide(p);
      await view(p, '.checks');
    },
  },
  {
    id: 'drift',
    say: 'Here is the subtle case. The travel agent delegates a vague task: improve the overall travel experience. It is a valid subset, so no rule rejects it. But its intent fidelity drops, and drift is flagged. That agent then buys a theme park ticket. It is affordable. It is in scope. It is within authority. It is not what I asked for. Blocked, and traced back to the exact hand-off where the intent drifted.',
    do: async (p) => {
      await sleep(2500);
      await guide(p);
      await view(p, '.branch');
      await sleep(11000);
      await guide(p);
      await view(p, '.checks');
    },
  },
  {
    id: 'hotel',
    say: 'For the hotel, the agent records why it rejected the alternatives, before any money moves. Approved, and paid.',
    do: async (p) => {
      await guide(p);
      await view(p, '.checks');
      await click(p, p.getByRole('button', { name: 'Why this payment?' }));
      await sleep(4500);
      await click(p, p.getByRole('button', { name: 'Close' }));
      await pay(p);
      await view(p, '.checks');
    },
  },
  {
    id: 'outcome',
    say: 'Then the hotel cancels. The payment succeeded. The goal did not. IntentChain refunds through PayPal, and proposes a replacement that waits for my approval.',
    do: async (p) => {
      await sleep(1500);
      await guide(p, 5000);
      await view(p, '.banner');
    },
  },
  {
    id: 'reconcile',
    say: 'Finally, every order and refund is read back from PayPal, and matched against our own ledger.',
    do: async (p) => {
      await guide(p, 3500);
      await view(p, '.reconcile');
    },
  },
  {
    id: 'gateway',
    say: 'And this is not limited to our agents. Any agent can act under a signed grant token through the gateway, and it meets the same firewall.',
    do: async (p) => {
      await p.locator('details.byo summary').click();
      await view(p, 'details.byo');
    },
  },
  {
    id: 'outro',
    say: 'Agents can delegate tasks. They should not be able to delegate away your intent. IntentChain. Trust the chain, not just the agent.',
    do: async (p) => {
      await card(p, ['IntentChain', 'Trust the chain, not just the agent.']);
      await sleep(8500);
    },
  },
];

// ---- on-screen helpers ----

/** Full-screen caption card for the opening and closing. Pass null to remove it. */
async function card(p, lines) {
  await p.evaluate((lines) => {
    document.getElementById('demo-card')?.remove();
    if (!lines) return;
    const el = document.createElement('div');
    el.id = 'demo-card';
    el.style.cssText =
      'position:fixed;inset:0;z-index:999;display:grid;place-content:center;gap:18px;text-align:center;padding:40px;' +
      'background:radial-gradient(900px 500px at 70% 0%,rgba(107,147,255,.22),transparent 60%),#0a0f1e;color:#e8edff;' +
      'font:700 40px/1.25 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:-.5px';
    for (const [i, line] of lines.entries()) {
      const row = document.createElement('div');
      row.textContent = line;
      if (i === lines.length - 1 && lines.length > 1) row.style.color = '#2fd08f';
      el.appendChild(row);
    }
    document.body.appendChild(el);
  }, lines);
}

/** Flashes a ring around the element, then clicks it, so the viewer can see what was pressed. */
async function click(p, locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el) => {
    el.style.transition = 'box-shadow .2s';
    el.style.boxShadow = '0 0 0 4px rgba(255,196,57,.9)';
    setTimeout(() => (el.style.boxShadow = ''), 900);
  });
  await sleep(550);
  await locator.click();
}

/** Presses the guide bar's button — the app decides what the next step is — and waits for it to finish. */
async function guide(p, settle = 2500) {
  const button = p.locator('.guide button');
  await button.waitFor({ state: 'visible', timeout: 15000 });
  await click(p, button);
  await p.waitForFunction(() => !document.querySelector('.guide button')?.disabled, null, { timeout: 30000 }).catch(() => {});
  await sleep(settle);
}

/** Smoothly brings a part of the page into view. */
async function view(p, selector) {
  await p.evaluate((selector) => {
    const all = document.querySelectorAll(selector);
    all[all.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, selector);
  await sleep(900);
}

const cuts = []; // [start, end] in seconds of raw recording, removed from the final video
let t0 = 0;
const now = () => (Date.now() - t0) / 1000;

/** Pays the approved transaction: simulated approval, or the real PayPal sandbox with a human buyer. */
async function pay(p) {
  await click(p, p.getByRole('button', { name: 'Pay with PayPal' }));
  const simulated = p.getByRole('button', { name: 'Approve & capture' });
  const toPayPal = p.getByRole('link', { name: 'Continue to PayPal' });
  await simulated.or(toPayPal).first().waitFor({ timeout: 30000 });
  await sleep(1800);
  if (await simulated.isVisible()) {
    await click(p, simulated);
    await sleep(2200);
    return;
  }
  await click(p, toPayPal);
  await p.waitForURL(/paypal\.com/, { timeout: 60000 });
  await sleep(3000); // show the real PayPal page briefly
  const left = now();
  console.log('\n>>> PayPal sandbox is waiting: log in and approve as the buyer in the browser window. <<<\n');
  await p.waitForURL((url) => url.href.startsWith(APP), { timeout: 10 * 60 * 1000 });
  await p.locator('.banner').waitFor({ timeout: 30000 });
  cuts.push([left, now() - 0.3]);
  await sleep(2500);
}

// ---- record ----

console.log(`Narration voice: ${VOICE}. Synthesizing ${SCENES.length} clips…`);
const clips = SCENES.map((s) => ({ ...s, ...speak(s.id, s.say) }));
console.log(`Narration total: ${clips.reduce((a, c) => a + c.seconds, 0).toFixed(1)}s`);

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({
  viewport: VIEW,
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
t0 = Date.now();
await page.goto(APP, { waitUntil: 'networkidle' });
await page.locator('.guide').waitFor();

const marks = [];
for (const clip of clips) {
  const start = now();
  marks.push({ file: clip.file, start });
  console.log(`[${start.toFixed(1)}s] ${clip.id}`);
  await clip.do(page);
  // hold the scene until its narration has finished (time spent at PayPal does not count)
  const cutInScene = cuts.filter(([a]) => a >= start).reduce((s, [a, b]) => s + (b - a), 0);
  const remaining = clip.seconds + 0.6 - (now() - start - cutInScene);
  if (remaining > 0) await sleep(remaining * 1000);
}
const total = now();
const raw = await page.video().path();
await context.close();
await browser.close();

// ---- assemble ----

const cutBefore = (t) => cuts.filter(([, b]) => b <= t).reduce((s, [a, b]) => s + (b - a), 0);
const keep = [];
let cursor = 0;
for (const [a, b] of cuts) {
  keep.push([cursor, a]);
  cursor = b;
}
keep.push([cursor, total]);

const inputs = ['-i', raw];
for (const m of marks) inputs.push('-i', m.file);
const video =
  keep.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`).join(';') +
  `;${keep.map((_, i) => `[v${i}]`).join('')}concat=n=${keep.length}:v=1:a=0[v]`;
const audio =
  marks.map((m, i) => `[${i + 1}:a]adelay=${Math.round((m.start - cutBefore(m.start)) * 1000)}:all=1[a${i}]`).join(';') +
  `;${marks.map((_, i) => `[a${i}]`).join('')}amix=inputs=${marks.length}:normalize=0[a]`;

const final = path.join(OUT, 'intentchain-demo.mp4');
run('ffmpeg', [
  '-y', ...inputs,
  '-filter_complex', `${video};${audio}`,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  final,
]);
const length = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final]));
console.log(`\nWrote ${final} — ${Math.floor(length / 60)}:${String(Math.round(length % 60)).padStart(2, '0')}${length >= 180 ? '  (OVER the 3-minute limit)' : ''}`);
