import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { validateConsultationAudio } from "../src/consultation-bot-audio.mjs";

const wav = (seconds, rate = 8000) => {
  const length = Math.round(seconds * rate), data = Buffer.alloc(44 + length, 128);
  data.write("RIFF", 0); data.writeUInt32LE(36 + length, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate, 28); data.writeUInt16LE(1, 32);
  data.writeUInt16LE(8, 34); data.write("data", 36); data.writeUInt32LE(length, 40);
  return data;
};
const file = seconds => ({ mimeType: "audio/wav", buffer: wav(seconds) });

test("real decoder verifies media and outputs canonical bounded WAV", async () => {
  const result = await validateConsultationAudio(file(1));
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.durationSeconds, 1);
  assert.equal(result.buffer.length, 44 + 32000);
  assert.equal(result.buffer.readUInt32LE(24), 16000);
});

test("client duration and claimed MIME cannot authorize a ten-minute recording", async () => {
  await assert.rejects(validateConsultationAudio({ ...file(600), duration: 1, durationSeconds: 1 }), { message: "BOT_AUDIO_DURATION" });
  await assert.rejects(validateConsultationAudio({ mimeType: "audio/webm", buffer: Buffer.from('not audio') }), { message: "BOT_AUDIO_INVALID" });
});

test("four-minute auto-stop encoder padding is accepted but removed before provider", async () => {
  const result = await validateConsultationAudio(file(241));
  assert.equal(result.durationSeconds, 240);
  assert.equal(result.buffer.length, 44 + 240 * 32000);
  await assert.rejects(validateConsultationAudio(file(243)), { message: "BOT_AUDIO_DURATION" });
});

test("streamed WebM without duration metadata and fragmented MP4 decode correctly", async () => {
  for (const [format, mimeType, encoder] of [
    ['webm', 'audio/webm', ['-c:a', 'libopus']],
    ['mp4', 'audio/mp4', ['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov']],
    ['mp3', 'audio/mpeg', ['-c:a', 'libmp3lame']],
    ['ogg', 'audio/ogg', ['-c:a', 'libopus']],
  ]) {
    const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...encoder, '-f', format, 'pipe:1'], { input: wav(1), timeout: 5000 });
    assert.equal(encoded.status, 0, encoded.stderr?.toString());
    const result = await validateConsultationAudio({ mimeType, buffer: encoded.stdout });
    assert.ok(result.durationSeconds >= .9 && result.durationSeconds <= 1.3, format);
  }
});

const pendingDecoder = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { child.killedWith = signal; queueMicrotask(() => child.emit('close', null)); };
  return child;
};
test("native decoding has a hard timeout, safe arguments and no application secrets", async () => {
  const child = pendingDecoder();
  await assert.rejects(validateConsultationAudio(file(1), { timeoutMs: 10, spawnImpl(command, args, options) {
    assert.equal(command, 'ffmpeg'); assert.equal(options.shell, false);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'pipe');
    assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
    assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
    return child;
  } }), { message: 'BOT_AUDIO_DECODE_TIMEOUT' });
  assert.equal(child.killedWith, 'SIGKILL');
});
test("aborting an in-flight decoder kills it and oversized output rejects early", async () => {
  const child = pendingDecoder(), controller = new AbortController();
  const result = validateConsultationAudio(file(1), { signal: controller.signal, spawnImpl: () => child });
  controller.abort();
  await assert.rejects(result, { message: 'BOT_AUDIO_ABORTED' });
  assert.equal(child.killedWith, 'SIGKILL');
  const oversized = pendingDecoder();
  const invalid = validateConsultationAudio(file(1), { spawnImpl: () => oversized });
  oversized.stdout.write(Buffer.alloc(243 * 32000));
  await assert.rejects(invalid, { message: 'BOT_AUDIO_DURATION' });
  assert.equal(oversized.killedWith, 'SIGKILL');
});
