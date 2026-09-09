import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

test('intro invites a detailed account and steps remain informational without progress highlighting', async () => {
  const html = await readFile(new URL('../bot/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../bot/app.js', import.meta.url), 'utf8');
  assert.match(html, /con el mayor detalle que puedas\. No te preocupes por el orden: contalo como te salga\./);
  assert.equal((html.match(/class="step" id="step-/g) || []).length, 3);
  assert.doesNotMatch(html, /class="step active"/);
  assert.doesNotMatch(script, /\$\('step-(?:talk|detail|report)'\)/);
});

test('audio button stays light green before recording and when ready to send', async () => {
  const css = await readFile(new URL('../bot/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#record\{[^}]*background:#e0f3e8;[^}]*color:#236747;/);
  assert.match(css, /#record\.recording\{background:#e0f3e8;color:#236747\}/);
  assert.match(css, /#record:not\(:disabled\):hover\{background:#cdebd9\}/);
});

test('recording cancellation sits beside audio send and the textbox cannot be resized', async () => {
  const html = await readFile(new URL('../bot/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../bot/styles.css', import.meta.url), 'utf8');
  const actions = html.match(/<div class="audio-actions">([\s\S]*?)<\/div>/)[1];
  assert.match(actions, /id="record"[\s\S]*id="cancel-recording"/);
  assert.match(css, /#message\{resize:none\}/);
  assert.equal((html.match(/id="cancel-recording"/g) || []).length, 1);
  assert.match(html, /class="recording-timer">Grabando <strong id="timer">0:00<\/strong><\/div>\s*<div class="recording-help">Tocá Enviar/);
});

const setup = async ({ audioLevel = 0.02, search = '', hash = '', sessionOverrides = {}, autoStart = true, resetFails = false, transcription = 'Me duele la rodilla derecha', transcriptionFailures = 0, access = { allowed: true } } = {}) => {
  let focused;
  const element = tagName => ({
    tagName, children: [],
    value: '', hidden: false, disabled: false, handlers: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, removeAttribute() {}, setAttribute() {},
    focus() { focused = this; }, scrollIntoView() {},
  });
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let resolveRequest;
  const requests = [];
  const urls = [];
  const replacedHistory = [];
  const audioRequests = [];
  const diagnostics = [];
  const windowHandlers = {};
  const beacons = [];
  let reloads = 0;
  const timers = new Map();
  let timerId = 0;
  let now = 0;
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
  const session = { status: 'collecting', version: 0, instanceId: 'test-instance', messages: [], brand: { slug: '' }, ...sessionOverrides };
  const response = (data, ok = true) => ({ ok, json: async () => data });
  vm.runInNewContext(await readFile(new URL('../bot/app.js', import.meta.url), 'utf8'), {
    document: { getElementById: get, createElement: element, createTextNode: text => text, body: element() },
    location: { search, hash, pathname: '/bot', reload: () => reloads++ }, history: { replaceState: (_state, _title, url) => replacedHistory.push(url) }, window: { addEventListener: (event, fn) => { windowHandlers[event] = fn; }, AudioContext, MediaRecorder },
    navigator: { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; }, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    MediaRecorder, File, Blob, Date: { now: () => now },
    console: { info: (...args) => diagnostics.push(args) },
    setInterval: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; },
    clearInterval: id => timers.delete(id),
    URLSearchParams, URL, FormData, AbortSignal, crypto: { randomUUID },
    fetch: async (url, options) => {
      urls.push(url);
      if (url.endsWith('/access')) { assert.equal(replacedHistory.length, 1); assert.equal(JSON.parse(options.body).token, 'private-test-token'); return response({ ok: true }); }
      if (url.endsWith('/reset')) { assert.equal(options.method, 'POST'); return response(resetFails ? { error: 'Reset failed' } : { session: null }, !resetFails); }
      if (url.endsWith('/context')) return response({ available: true, brand: session.brand, access });
      if (url.endsWith('/session')) { assert.equal(options.method, 'POST', 'Never restore a previous session'); return response({ session }); }
      if (url.endsWith('/transcribe')) {
        audioRequests.push(options.body);
        if (transcriptionFailures-- > 0) return response({ error: 'Error temporal' }, false);
        return response({ text: transcription });
      }
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  if (autoStart && !resetFails && access.allowed) await get('start').handlers.click();
  const submit = () => get('composer').handlers.submit({ preventDefault() {} });
  get('composer').requestSubmit = submit;
  return {
    get, submit, requests, urls, replacedHistory, audioRequests, diagnostics, windowHandlers, beacons, reloads: () => reloads, focused: () => focused,
    sampleAudio: () => { for (const timer of timers.values()) if (timer.ms === 50) for (let i = 0; i < 6; i++) timer.callback(); },
    tickRecording: ms => { now += ms; for (const timer of timers.values()) if (timer.ms === 500) timer.callback(); },
    finish: (ok = true, overrides = {}) => resolveRequest(response(ok ? { session: { ...session, version: 1, ...overrides } } : { error: 'Error de prueba' }, ok)),
  };
};

for (const status of ['complete', 'partial', 'urgent']) test('finished ' + status + ' result shows only readiness and download, without clinical summary', async () => {
  const data = { complaints: [{ reason: 'dolor', location: 'tobillo derecho', pain: 5 }], followups: [{ question: '¿Cambió tu rutina?', answer: 'Me cuesta caminar' }] };
  const app = await setup({ sessionOverrides: { status, data, messages: [{ role: 'assistant', text: 'Mensaje de cierre u orientación' }] } });
  assert.equal(app.get('result').hidden, false);
  assert.equal(app.get('composer').hidden, true);
  assert.equal(app.get('result-title').textContent, status === 'partial' ? 'Tu informe parcial está listo' : 'Tu informe está listo');
  assert.equal(typeof app.get('download').handlers.click, 'function');
  assert.equal(app.get('summary').children.length, 0);
  assert.equal(app.get('messages').children.length, 1);
  assert.equal(data.followups[0].answer, 'Me cuesta caminar');
});
test('private appointment token is removed from navigation before its POST exchange', async () => {
  const app = await setup({ hash: '#appointment=private-test-token', autoStart: false });
  assert.deepEqual(app.replacedHistory, ['/bot']);
  assert.deepEqual(app.urls, ['/api/bot/access', '/api/bot/reset', '/api/bot/context']);
});
test('access denial hides the interview and consent and displays the friendly message', async () => {
  for (const message of ['Ingresá desde el enlace de tu turno.', 'Ya completaste la entrevista para este turno.']) {
    const app = await setup({ access: { allowed: false, message } });
    assert.equal(app.get('access-notice').textContent, message);
    assert.equal(app.get('access-notice').hidden, false);
    assert.equal(app.get('messages').hidden, true);
    assert.equal(app.get('start-panel').hidden, true);
    assert.equal(app.get('start').disabled, true);
    assert.equal(app.urls.includes('/api/bot/session'), false);
  }
});
test('each visit resets before starting and never restores a finished conversation', async () => {
  const app = await setup({ autoStart: false, sessionOverrides: { status: 'complete', messages: [{ role: 'user', text: 'Conversación anterior' }] } });
  assert.deepEqual(app.urls, ['/api/bot/reset', '/api/bot/context']);
  assert.equal(app.get('start-panel').hidden, false);
  assert.equal(app.get('result').hidden, true);
  assert.equal(app.get('composer').hidden, true);
  assert.equal(app.get('message').value, '');
  assert.equal(app.get('consent').checked, false);
  assert.equal(app.get('messages').children.length, 2);
  assert.ok(!JSON.stringify(app.get('messages').children).includes('Conversación anterior'));
});
test('a failed reset cannot expose or start an old conversation', async () => {
  const app = await setup({ autoStart: false, resetFails: true });
  assert.deepEqual(app.urls, ['/api/bot/reset']);
  assert.equal(app.get('start').disabled, true);
  assert.equal(app.get('error').textContent, 'Reset failed');
});
test('leaving clears the visible draft and closes only that conversation; back cache reloads', async () => {
  const app = await setup();
  app.get('message').value = 'Borrador privado';
  app.windowHandlers.pagehide();
  assert.equal(app.get('message').value, '');
  assert.equal(app.get('result').hidden, true);
  assert.equal(app.beacons.length, 1);
  assert.equal(app.beacons[0].url, '/api/bot/close');
  assert.deepEqual(JSON.parse(await app.beacons[0].body.text()), { instanceId: 'test-instance' });
  app.windowHandlers.pageshow({ persisted: false });
  assert.equal(app.reloads(), 0);
  app.windowHandlers.pageshow({ persisted: true });
  assert.equal(app.reloads(), 1);
});
test('a pending message cannot bring back private content after leaving', async () => {
  const app = await setup();
  app.get('message').value = 'Relato privado';
  const pending = app.submit();
  app.windowHandlers.pagehide();
  app.finish(true, { messages: [{ role: 'user', text: 'Relato privado' }] });
  await pending;
  assert.equal(app.get('message').value, '');
  assert.equal(app.get('composer').hidden, true);
  assert.ok(!JSON.stringify(app.get('messages').children).includes('Relato privado'));
});
test('result markup contains only the title and download button', async () => {
  const html = await readFile(new URL('../bot/index.html', import.meta.url), 'utf8');
  const result = html.match(/<div id="result"[\s\S]*?<\/div>/)?.[0];
  assert.ok(result);
  assert.deepEqual([...result.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]), ['result', 'result-title', 'download']);
  const script = await readFile(new URL('../bot/app.js', import.meta.url), 'utf8');
  assert.ok(!script.includes("$('summary')"));
  assert.ok(!script.includes("$('restart')"));
});

test('bot API requests stay on the current subdomain without forwarding form parameters', async () => {
  const app = await setup({ search: '?form=other-agreement' });
  assert.ok(app.urls.includes('/api/bot/context'));
  assert.ok(app.urls.includes('/api/bot/session'));
  app.get('message').value = 'Mensaje';
  const pending = app.submit();
  assert.ok(app.urls.includes('/api/bot/message'));
  assert.ok(app.urls.every(url => url.startsWith('/api/bot/') && !url.includes('?')));
  app.finish();
  await pending;
});

test('browser diagnostics contain only this turn decision and its non-authenticating reference', async () => {
  const app = await setup();
  app.get('message').value = 'Relato privado del paciente';
  const pending = app.submit();
  app.finish(true, { diagnosticId: 'qa-reference', followupDiagnostics: [
    { turn: 0, stage: 'review', reason: 'accepted' },
    { turn: 1, stage: 'review', reason: 'review_rejected', failedChecks: ['clear'] },
  ] });
  await pending;
  assert.equal(app.diagnostics.length, 1);
  const diagnostic = JSON.parse(JSON.stringify(app.diagnostics[0][1]));
  assert.equal(diagnostic.diagnosticId, 'qa-reference');
  assert.equal(diagnostic.decisions.length, 1);
  assert.equal(diagnostic.decisions[0].turn, 1);
  assert.ok(!JSON.stringify(app.diagnostics).includes('Relato privado'));
  assert.ok(!JSON.stringify(app.diagnostics).includes('test-instance'));
});

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
  assert.equal(app.get('cancel-recording').hidden, true);
  assert.equal(app.get('send').hidden, false);
  await app.get('record').handlers.click();
  assert.equal(app.get('record-label').textContent, 'Enviar');
  assert.equal(app.get('cancel-recording').hidden, false);
  assert.equal(app.get('send').hidden, true);
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('cancel-recording').hidden, true);
  assert.equal(app.get('send').hidden, false);
  assert.equal(app.audioRequests.length, 1);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].text, 'Me duele la rodilla derecha');
  assert.equal(input.value, 'Borrador que todavía no envié');
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('audio-retry').hidden, true);
  assert.equal(input.value, 'Borrador que todavía no envié');
});

test('four-minute limit sends the captured audio and its full long transcription exactly once', async () => {
  const transcription = 'Relato de prueba. '.repeat(300);
  const app = await setup({ transcription });
  await app.get('record').handlers.click();
  app.sampleAudio();
  app.tickRecording(239000);
  assert.equal(app.get('timer').textContent, '3:59');
  assert.equal(app.get('send').hidden, true);
  assert.equal(app.audioRequests.length, 0);
  app.tickRecording(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.audioRequests.length, 1);
  assert.equal(await app.audioRequests[0].get('audio').text(), 'fake-audio');
  assert.equal(app.get('send').hidden, false);
  assert.equal(app.requests[0].text, transcription.trim());
  assert.equal(app.get('message').value, '');
  app.tickRecording(10000);
  assert.equal(app.audioRequests.length, 1);
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('audio-retry').hidden, true);
});

test('automatic cutoff preserves audio for retry if transcription fails', async () => {
  const app = await setup({ transcriptionFailures: 1 });
  await app.get('record').handlers.click();
  app.sampleAudio();
  app.tickRecording(240000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('audio-retry').hidden, false);
  assert.equal(app.requests.length, 0);
  const retry = app.get('retry-audio').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await app.audioRequests[1].get('audio').arrayBuffer(), await app.audioRequests[0].get('audio').arrayBuffer());
  assert.equal(app.requests.length, 1);
  app.finish();
  await retry;
  assert.equal(app.get('audio-retry').hidden, true);
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
  assert.equal(app.get('send').hidden, false);
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
