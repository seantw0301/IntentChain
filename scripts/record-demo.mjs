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
const RATE = process.env.RATE || '178';
const HEADED = process.env.HEADED === '1';
const VIEW = { width: 1120, height: 630 }; // small viewport, recorded at 1080p, so text stays readable

// keep earlier takes; only clear this run's scratch files
fs.rmSync(path.join(OUT, 'audio'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.webm')) fs.rmSync(path.join(OUT, f));

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
    id: 'hook',
    say: 'AI agents are about to spend your company’s money. The question is not whether they can pay. It is whether you would ever know why they did.',
    do: async (p) => {
      await card(p, ['AI agents are about to spend your company’s money.', 'Would you ever know why?'], 54);
      await sleep(9000);
    },
  },
  {
    id: 'intro',
    say: 'IntentChain: autonomous travel and procurement for small businesses, built on PayPal. Let AI spend. Keep your business in control.',
    do: async (p) => {
      await card(p, ['Ten people. No travel desk. No procurement team.', 'IntentChain', 'Let AI spend. Keep your business in control.']);
      await sleep(8000);
      await card(p, null);
    },
  },
  {
    id: 'policy',
    say: 'The owner sets the rules once: what agents may buy, a trip budget, and an auto-pay limit. Above it, a manager approves.',
    do: async (p) => {
      await view(p, '.panel');
    },
  },
  {
    id: 'request',
    say: 'An employee needs a trip to Tokyo for a client meeting. The request becomes a structured intent, and authority flows down a chain of agents. Each grant is smaller than its parent: less money, a narrower scope, fewer PayPal tools. And every grant is signed.',
    do: async (p) => {
      await guide(p, 3500);
      await guide(p, 2500);
      await view(p, '.chain');
    },
  },
  {
    id: 'esim',
    say: 'The travel agent buys an eighteen dollar e-SIM. Five checks pass, and it is under the limit. So it is paid instantly through PayPal, with nobody in the loop.',
    do: async (p) => {
      await sleep(1000);
      await guide(p, 3500);
      await view(p, '.checks');
    },
  },
  {
    id: 'attack',
    say: 'Now an attack. An agent requests a grant with the same five hundred dollars, plus one new capability. Same amount, but not a subset. Rejected.',
    do: async (p) => {
      await sleep(800);
      await guide(p);
      await view(p, '.note.block');
      await sleep(5500);
      await guide(p, 1800); // the over-limit suite: shown briefly, stopped on authority
      await view(p, '.checks');
    },
  },
  {
    id: 'policy-block',
    say: 'A theme park ticket? The company blocks entertainment. Any expense policy would catch that.',
    do: async (p) => {
      await guide(p);
      await view(p, '.checks');
    },
  },
  {
    id: 'drift',
    say: 'Here is what a policy cannot catch. The travel agent hands off a vague task: improve the overall travel experience. A valid subset, so no rule rejects it. But its intent fidelity drops. Now a real L L M acts as that agent. It knows the company policy, so it looks for something the policy allows, and books a sunset dinner cruise as a business meal. Allowed category. In budget. Within authority. Every policy check passes. But it is not what the employee was sent to do. Blocked, and traced to the exact hand-off where the intent drifted.',
    do: async (p) => {
      await sleep(1500);
      await guide(p);
      await view(p, '.branch');
      await sleep(4500);
      await guide(p, 1500); // the model plans and calls tools; this takes a while
      if (await p.locator('.transcript').count()) {
        await view(p, '.transcript');
        await sleep(5000);
      }
      await view(p, '.checks');
    },
  },
  {
    id: 'hotel',
    say: 'The hotel is four hundred and eighty six dollars: over the limit. The agent records why it rejected the alternatives, and the manager approves in PayPal.',
    do: async (p) => {
      await guide(p);
      await view(p, '.checks');
      await click(p, p.getByRole('button', { name: 'Why this payment?' }));
      await sleep(3000);
      await click(p, p.getByRole('button', { name: 'Close' }));
      await pay(p);
      await view(p, '.checks');
    },
  },
  {
    id: 'outcome',
    say: 'Then the hotel cancels. The payment succeeded. The goal did not. IntentChain refunds through PayPal, and proposes a replacement.',
    do: async (p) => {
      await sleep(1200);
      await guide(p, 5000);
      await view(p, '.banner');
    },
  },
  {
    id: 'reconcile',
    say: 'Every order and refund is read back from PayPal, and matched to our ledger.',
    do: async (p) => {
      await guide(p, 3500);
      await view(p, '.reconcile');
    },
  },
  {
    id: 'office',
    say: 'And it is not just travel. Under the same policy, adapters for new hires are auto-paid, and a gaming graphics card is blocked.',
    do: async (p) => {
      await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(800);
      await guide(p, 3500); // reset, then submit the office request
      await guide(p, 2500); // confirm & delegate
      await guide(p, 3000); // adapters → auto-pay
      await view(p, '.checks');
      await guide(p, 2500); // graphics card → blocked
      await view(p, '.checks');
    },
  },
  {
    id: 'outro',
    say: 'Agents can delegate tasks. They should not be able to delegate away your intent. IntentChain. Trust the chain, not just the agent.',
    do: async (p) => {
      await card(p, ['IntentChain', 'Let AI spend. Keep your business in control.', 'Trust the chain, not just the agent.']);
      await sleep(8500);
    },
  },
];

// ---- on-screen helpers ----

/** Full-screen caption card for the opening and closing. Pass null to remove it. */
async function card(p, lines, size = 40) {
  await p.evaluate(({ lines, size }) => {
    document.getElementById('demo-card')?.remove();
    if (!lines) return;
    const el = document.createElement('div');
    el.id = 'demo-card';
    el.style.cssText =
      'position:fixed;inset:0;z-index:999;display:grid;place-content:center;gap:18px;text-align:center;padding:40px;' +
      'background:radial-gradient(900px 500px at 70% 0%,rgba(107,147,255,.22),transparent 60%),#0a0f1e;color:#e8edff;' +
      `font:700 ${size}px/1.2 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:-.5px`;
    for (const [i, line] of lines.entries()) {
      const row = document.createElement('div');
      row.textContent = line;
      if (i === lines.length - 1 && lines.length > 1) row.style.color = '#2fd08f';
      el.appendChild(row);
    }
    document.body.appendChild(el);
  }, { lines, size });
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
  // long enough for a step in which an LLM agent plans and calls tools
  await p.waitForFunction(() => !document.querySelector('.guide button')?.disabled, null, { timeout: 120000 }).catch(() => {});
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

/** Manager approval: simulated, or the real PayPal sandbox with a human approving. */
async function pay(p) {
  await click(p, p.getByRole('button', { name: 'Approve & pay with PayPal' }));
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
  console.log('\n>>> PayPal sandbox is waiting: log in and approve as the manager in the browser window. <<<\n');
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
  locale: 'en-US', // so third-party pages such as PayPal render in English
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

const final = path.join(OUT, process.env.OUTPUT || 'intentchain-demo.mp4');
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
