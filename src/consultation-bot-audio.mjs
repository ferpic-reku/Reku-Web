import { spawn } from "node:child_process";

export const MAX_CONSULTATION_AUDIO_SECONDS = 240;
const stopPaddingSeconds = 2;
const sampleRate = 16_000;
const bytesPerSecond = sampleRate * 2;
const maxInputBytes = 8 * 1024 * 1024;
const maxDecodedBytes = (MAX_CONSULTATION_AUDIO_SECONDS + stopPaddingSeconds) * bytesPerSecond;
const allowedTypes = new Set(["audio/webm", "video/webm", "audio/mp4", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/x-m4a"]);
const audioError = (code, statusCode = 422, publicMessage = "No pudimos leer el audio. Probá grabarlo nuevamente o escribí tu mensaje.") =>
  Object.assign(new Error(code), { statusCode, publicMessage });

const wavFromPcm = pcm => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(bytesPerSecond, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

// Decode instead of trusting MIME, duration tags or client-supplied seconds.
// MediaRecorder WebM commonly has no duration metadata. Only pipes and a small
// allowlist of media demuxers/decoders are permitted; no files, URLs or playlists.
export const validateConsultationAudio = async (file, { signal, spawnImpl = spawn, timeoutMs = 10_000 } = {}) => {
  if (!allowedTypes.has(file?.mimeType) || !Buffer.isBuffer(file.buffer) || !file.buffer.length)
    throw audioError("BOT_AUDIO_TYPE", 415);
  if (file.buffer.length > maxInputBytes) throw audioError("PAYLOAD_TOO_LARGE", 413, "El audio es demasiado grande. Usá uno de hasta 8 MB.");
  if (signal?.aborted) throw audioError("BOT_AUDIO_ABORTED", 408);
  const pcm = await new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-max_alloc", "16777216",
      "-filter_threads", "1", "-filter_complex_threads", "1", "-protocol_whitelist", "pipe",
      "-format_whitelist", "wav,mp3,ogg,mov,matroska,webm",
      "-codec_whitelist", "aac,mp3,mp3float,opus,vorbis,flac,alac,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_alaw,pcm_mulaw",
      "-threads", "1", "-i", "pipe:0", "-map", "0:a:0", "-vn", "-sn", "-dn",
      // Read slightly beyond the acceptable padding so longer recordings are
      // rejected, while still bounding CPU and bytes even for hours of input.
      "-t", String(MAX_CONSULTATION_AUDIO_SECONDS + stopPaddingSeconds + 0.1),
      "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_s16le", "-threads", "1", "-f", "s16le", "pipe:1"];
    const child = spawnImpl("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      // Do not expose application secrets to a native media decoder.
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    let settled = false, size = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) { child.kill("SIGKILL"); chunks.length = 0; reject(error); }
      else resolve(result);
    };
    const abort = () => finish(audioError("BOT_AUDIO_ABORTED", 408));
    const timer = setTimeout(() => finish(audioError("BOT_AUDIO_DECODE_TIMEOUT", 422, "No pudimos procesar el audio a tiempo. Probá grabarlo nuevamente o escribí tu mensaje.")), timeoutMs);
    child.on("error", () => finish(audioError("BOT_AUDIO_DECODER_UNAVAILABLE", 503)));
    // Drain but never retain/log decoder diagnostics (they can contain input).
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {}); // EPIPE is expected when rejecting early.
    child.stdout.on("error", () => finish(audioError("BOT_AUDIO_INVALID")));
    child.stdout.on("data", chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxDecodedBytes) {
        finish(audioError("BOT_AUDIO_DURATION", 422, "El audio puede durar hasta 4 minutos. Grabá uno más corto para continuar."));
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", code => {
      if (settled) return;
      if (code !== 0 || size === 0 || size % 2 !== 0) { finish(audioError("BOT_AUDIO_INVALID")); return; }
      // Encoder padding is tolerated only here, then removed. The provider
      // receives at most four minutes, regardless of the original container.
      finish(null, Buffer.concat(chunks).subarray(0, MAX_CONSULTATION_AUDIO_SECONDS * bytesPerSecond));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(file.buffer);
  });
  return { mimeType: "audio/wav", buffer: wavFromPcm(pcm), durationSeconds: pcm.length / bytesPerSecond };
};
