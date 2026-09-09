import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const setup = async ({ audioLevel = 0.02 } = {}) => {
  let focused;
  const element = () => ({
    value: '', hidden: false, disabled: false, handlers: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    replaceChildren() {}, append() {}, removeAttribute() {}, setAttribute() {},
    focus() { focused = this; }, scrollIntoView() {},
  });
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let resolveRequest;
  const requests = [];
  const audioRequests = [];
  const timers = new Map();
  let timerId = 0;
  class AudioContext {
    async resume() {}
    async close() {}
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData: samples => samples.fill(audioLevel) }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  class MediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['fake-audio']) });
      queueMicrotask(() => this.onstop());
    }
  }
  const session = { status: 'collecting', version: 0, instanceId: 'test-instance', messages: [], brand: { slug: '' } };
  const response = (data, ok = true) => ({ ok, json: async () => data });
  vm.runInNewContext(await readFile(new URL('../bot/app.js', import.meta.url), 'utf8'), {
    document: { getElementById: get, createElement: element, createTextNode: text => text, body: element() },
    location: { search: '' }, window: { addEventListener() {}, AudioContext, MediaRecorder },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    MediaRecorder, File, Blob,
    setInterval: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; },
    clearInterval: id => timers.delete(id),
    URLSearchParams, URL, FormData, AbortSignal, crypto: { randomUUID },
    fetch: async (url, options) => {
      if (url.endsWith('/context')) return response({ available: true, brand: session.brand });
      if (url.endsWith('/session')) return response({ session });
      if (url.endsWith('/transcribe')) {
        audioRequests.push(options.body);
        return response({ text: 'Me duele la rodilla derecha' });
      }
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const submit = () => get('composer').handlers.submit({ preventDefault() {} });
  get('composer').requestSubmit = submit;
  return {
    get, submit, requests, audioRequests, focused: () => focused,
    sampleAudio: () => { for (const timer of timers.values()) if (timer.ms === 50) for (let i = 0; i < 6; i++) timer.callback(); },
    finish: (ok = true) => resolveRequest(response(ok ? { session: { ...session, version: 1 } } : { error: 'Error de prueba' }, ok)),
  };
};

test('sending clears and focuses the composer immediately while preserving the next draft', async () => {
  const app = await setup();
  const input = app.get('message');
  input.value = 'Primer mensaje';
  const pending = app.submit();
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
  assert.equal(app.focused(), input);
  assert.equal(app.get('send').disabled, true);
  input.value = 'Siguiente mensaje';
  input.handlers.input();
  input.handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(app.requests.length, 1);
  app.finish();
  await pending;
  assert.equal(input.value, 'Siguiente mensaje');
  assert.equal(app.get('send').disabled, false);
  assert.equal(app.requests[0].text, 'Primer mensaje');
});

test('recording sends its transcription directly without changing the typed draft', async () => {
  const app = await setup();
  const input = app.get('message');
  input.value = 'Borrador que todavía no envié';
  await app.get('record').handlers.click();
  assert.equal(app.get('record-label').textContent, 'Enviar');
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.audioRequests.length, 1);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].text, 'Me duele la rodilla derecha');
  assert.equal(input.value, 'Borrador que todavía no envié');
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('audio-retry').hidden, true);
  assert.equal(input.value, 'Borrador que todavía no envié');
});

test('silent recordings do not call transcription or send a message', async () => {
  const app = await setup({ audioLevel: 0 });
  await app.get('record').handlers.click();
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.audioRequests.length, 0);
  assert.equal(app.requests.length, 0);
  assert.match(app.get('error').textContent, /No detectamos voz/);
  assert.equal(app.get('record').disabled, false);
});

test('cancelled recordings never transcribe or send', async () => {
  const app = await setup();
  await app.get('record').handlers.click();
  app.sampleAudio();
  app.get('cancel-recording').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.audioRequests.length, 0);
  assert.equal(app.requests.length, 0);
});

test('failed audio sends retry with the same request id without entering the input', async () => {
  const app = await setup();
  await app.get('record').handlers.click();
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  app.finish(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('message').value, '');
  assert.equal(app.get('audio-retry').hidden, false);
  const retry = app.get('retry-audio').handlers.click();
  assert.equal(app.audioRequests.length, 1);
  assert.equal(app.requests[0].requestId, app.requests[1].requestId);
  app.finish();
  await retry;
  assert.equal(app.get('audio-retry').hidden, true);
});

test('a failed send restores the original message without losing the next draft', async () => {
  const app = await setup();
  app.get('message').value = 'Primer mensaje';
  const pending = app.submit();
  app.get('message').value = 'Borrador siguiente';
  app.finish(false);
  await pending;
  assert.equal(app.get('message').value, 'Primer mensaje\n\nBorrador siguiente');
  assert.equal(app.get('message').disabled, false);
  assert.equal(app.get('error').textContent, 'Error de prueba');
});
