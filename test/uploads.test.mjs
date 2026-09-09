import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import {
  parseMultipartForm,
  saveAgreementLogo,
  saveAgreementPdf,
} from "../src/uploads.mjs";

const multipart = (body, { pending = false } = {}) => {
  const request = pending ? new PassThrough() : Readable.from([Buffer.from(body)]);
  request.headers = { "content-type": "multipart/form-data; boundary=test-boundary" };
  return request;
};
const filePart = '--test-boundary\r\nContent-Disposition: form-data; name="audio"; filename="test.webm"\r\nContent-Type: audio/webm\r\n\r\nsample-audio';

test("multipart truncated file rejects without terminating the Node process", () => {
  const source = `import { Readable } from 'node:stream';
    import { parseMultipartForm } from ${JSON.stringify(new URL('../src/uploads.mjs', import.meta.url).href)};
    const request = Readable.from([Buffer.from(${JSON.stringify(filePart)})]);
    request.headers = {'content-type':'multipart/form-data; boundary=test-boundary'};
    try { await parseMultipartForm(request); process.exitCode=2; }
    catch (error) { console.log(error.statusCode); }
    await new Promise(resolve => setTimeout(resolve, 20));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 2000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "422");
});

test("valid multipart still returns fields and files", async () => {
  const result = await parseMultipartForm(multipart(`${filePart}\r\n--test-boundary--\r\n`));
  assert.equal(result.files.audio.buffer.toString(), "sample-audio");
  assert.equal(result.files.audio.mimeType, "audio/webm");
});

test("client disconnect settles the parser and detaches request listeners", async () => {
  const request = new IncomingMessage(new PassThrough());
  request.headers = { "content-type": "multipart/form-data; boundary=test-boundary" };
  const result = parseMultipartForm(request);
  request.push(Buffer.from(filePart));
  await new Promise(resolve => setImmediate(resolve));
  request.destroy();
  await assert.rejects(result, { message: "UPLOAD_ABORTED" });
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(request.listenerCount("data"), 0);
});

test("parser deadline and cancellation release pending uploads", async () => {
  const timed = multipart('', { pending: true });
  await assert.rejects(parseMultipartForm(timed, { timeoutMs: 10 }), { message: "UPLOAD_TIMEOUT" });
  assert.equal(timed.destroyed, true);
  const request = multipart('', { pending: true });
  const controller = new AbortController();
  const result = parseMultipartForm(request, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { message: "UPLOAD_ABORTED" });
  request.destroy();
});

test("multipart rejects file and field size overflow instead of truncating silently", async () => {
  await assert.rejects(parseMultipartForm(multipart(`${filePart}\r\n--test-boundary--\r\n`), { maxBytes: 4 }), { statusCode: 413 });
  const body = '--test-boundary\r\nContent-Disposition: form-data; name="note"\r\n\r\nabcdef\r\n--test-boundary--\r\n';
  await assert.rejects(parseMultipartForm(multipart(body), { maxBytes: 4 }), { statusCode: 413 });
});

test("agreement logos reject SVG even when the client declares an SVG MIME", async () => {
  await assert.rejects(
    saveAgreementLogo({
      filename: "payload.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg><script>alert(1)</script></svg>"),
    }),
    { message: "INVALID_IMAGE" },
  );
});

test("agreement PDFs require MIME, extension and PDF magic bytes", async () => {
  await assert.rejects(
    saveAgreementPdf({
      filename: "payload.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<html>not a pdf</html>"),
    }),
    { message: "INVALID_PDF" },
  );
  await assert.rejects(
    saveAgreementPdf({
      filename: "payload.txt",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7"),
    }),
    { message: "INVALID_PDF" },
  );
});
