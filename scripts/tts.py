"""Neural text-to-speech for the demo narration, using the open Kokoro model.

    <venv>/bin/python -I scripts/tts.py <model-dir> <voice> <speed> <out.wav> < text

Reads the text from stdin and writes a mono WAV. The model (Apache-2.0) runs
locally; nothing is sent to a service. See scripts/revoice.mjs for how the
clips are laid onto the video.
"""
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

model_dir, voice, speed, out = sys.argv[1:5]
text = sys.stdin.read().strip()
kokoro = Kokoro(f"{model_dir}/kokoro-v1.0.onnx", f"{model_dir}/voices-v1.0.bin")
samples, rate = kokoro.create(text, voice=voice, speed=float(speed), lang="en-us")
sf.write(out, samples, rate)
