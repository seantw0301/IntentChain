// Records a 30-second opening with narration. Three variants:
//   node scripts/record-intro.mjs b          → video/intro-b.mp4   product style (scripts/intro-b.html)
//   node scripts/record-intro.mjs a 2,4,5    → video/intro-a.mp4   three illustrations from video/intro-assets/
//   node scripts/record-intro.mjs desk       → video/intro-desk.mp4  objects on a desk (scripts/intro.html)
// Needs no server and no PayPal: each is a self-contained animated page.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve('video');
const VOICE = process.env.VOICE || 'Samantha';
const RATE = process.env.RATE || '176';
const LENGTH = 30; // seconds
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
fs.mkdirSync(path.join(OUT, 'intro-audio'), { recursive: true });

const variant = process.argv[2] || 'b';
const PAGES = { a: 'intro-a.html', b: 'intro-b.html', desk: 'intro.html' };
if (!PAGES[variant]) throw new Error(`Unknown variant "${variant}". Use a, b or desk.`);
const query = variant === 'a' && process.argv[3] ? `?f=${process.argv[3]}` : '';

// what is said, and when it starts
const STORY = [
  [0.4, 'AI can follow every rule, and still do the wrong thing. You asked for a client meeting in Tokyo. Two hand-offs later, an agent paid for a dinner cruise.'],
  [10.2, 'Let AI spend. Keep your business in control. Small purchases auto-pay. Big ones wait for a manager. Drift gets blocked.'],
  [20.2, 'IntentChain Business Agent. Channel three finds it. Claude agents decide. IntentChain checks every hand-off. PayPal pays. A G Grid records it.'],
];
const DESK = [
  [0.3, 'You asked an AI to book a business trip. It handed the job to another agent. That agent bought a sunset cruise. Every expense rule passed.'],
  [10.3, 'IntentChain Business Agent. Let AI spend. Keep your business in control. We verify every hand-off between agents, before a dollar reaches PayPal.'],
  [20.2, 'The owner sets the rules. Authority shrinks, signed, at every hand-off. Five checks guard PayPal: auto-pay, manager approval, or blocked.'],
];
const LINES = variant === 'desk' ? DESK : STORY;

const clips = LINES.map(([at, text], i) => {
  const file = path.join(OUT, 'intro-audio', `${i}.aiff`);
  run('say', ['-v', VOICE, '-r', RATE, '-o', file, text]);
  const seconds = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]));
  console.log(`line ${i + 1}: starts ${at}s, lasts ${seconds.toFixed(1)}s${seconds > 9.7 ? '  (too long for its 10 seconds)' : ''}`);
  return { at, file };
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
const page = await context.newPage();
const t0 = Date.now();
await page.goto(`file://${path.join(here, PAGES[variant])}${query}`);
// the recording starts with the page; the animation starts once the page has loaded and painted
const lead = (Date.now() - t0) / 1000 - 0.25;
await page.waitForTimeout(LENGTH * 1000);
const raw = await page.video().path();
await context.close();
await browser.close();

const inputs = ['-i', raw];
for (const c of clips) inputs.push('-i', c.file);
const audio =
  clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`).join(';') +
  `;${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0[a]`;
const final = path.join(OUT, `intro-${variant}.mp4`);
run('ffmpeg', [
  '-y', ...inputs,
  '-filter_complex', `[0:v]trim=start=${lead.toFixed(3)}:duration=${LENGTH},setpts=PTS-STARTPTS[v];${audio}`,
  '-map', '[v]', '-map', '[a]', '-t', String(LENGTH),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart',
  final,
]);
fs.rmSync(raw, { force: true });
console.log(`Wrote ${final}`);
