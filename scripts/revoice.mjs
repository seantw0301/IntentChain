// Replaces a video's narration with a neural voice.
//
//   node scripts/revoice.mjs <video-in> <video-out> [narration.json]
//
// Each line in the cue sheet is synthesized with the open Kokoro model
// (scripts/tts.py, run from video/tts-env) and placed at its start time. A line
// that would run into the next one is re-synthesized slightly faster so that
// it fits. The picture is copied untouched.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [input, output, sheet = 'scripts/narration.json'] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/revoice.mjs <video-in> <video-out> [narration.json]');

const ENV = path.resolve('video/tts-env');
const PY = path.join(ENV, 'bin/python');
const MODEL = path.join(ENV, 'model');
const TMP = path.resolve('video/voice');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts }).toString();
const seconds = (file) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]));

const { voice, speed: baseSpeed = 1, cues } = JSON.parse(fs.readFileSync(sheet, 'utf8'));
const VOICE = process.env.VOICE || voice;
const total = seconds(input);
const GAP = 0.35; // breathing room before the next line
const MAX_SPEED = 1.3;

function synth(file, text, speed) {
  run(PY, ['-I', 'scripts/tts.py', MODEL, VOICE, speed.toFixed(3), file], { input: text });
  return seconds(file);
}

const clips = cues.map((cue, i) => {
  const slot = (cues[i + 1]?.at ?? total) - cue.at - GAP;
  const file = path.join(TMP, `${String(i).padStart(2, '0')}.wav`);
  let speed = Number(process.env.SPEED || baseSpeed);
  let length = synth(file, cue.text, speed);
  for (let tries = 0; length > slot && speed < MAX_SPEED && tries < 3; tries++) {
    speed = Math.min(MAX_SPEED, (speed * length) / slot + 0.03);
    length = synth(file, cue.text, speed);
  }
  const note = length > slot ? `  OVERRUNS its slot by ${(length - slot).toFixed(1)}s` : '';
  console.log(`${cue.at.toFixed(1).padStart(6)}s  ${length.toFixed(1)}s of ${slot.toFixed(1)}s  speed ${speed.toFixed(2)}${note}`);
  return { at: cue.at, file };
});

const inputs = ['-i', input];
for (const c of clips) inputs.push('-i', c.file);
const mix =
  clips.map((c, i) => `[${i + 1}:a]aresample=44100,adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`).join(';') +
  `;${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,` +
  // even out loudness for online playback
  `loudnorm=I=-16:TP=-1.5:LRA=11,aformat=channel_layouts=stereo[a]`;

run('ffmpeg', [
  '-y', ...inputs, '-filter_complex', mix,
  '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(total), '-movflags', '+faststart', output,
]);
console.log(`Wrote ${output} — voice ${VOICE}`);
