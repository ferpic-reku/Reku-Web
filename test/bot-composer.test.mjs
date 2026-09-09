import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const setup = async () => {
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
  const session = { status: 'collecting', version: 0, instanceId: 'test-instance', messages: [], brand: { slug: '' } };
  const response = (data, ok = true) => ({ ok, json: async () => data });
  vm.runInNewContext(await readFile(new URL('../bot/app.js', import.meta.url), 'utf8'), {
    document: { getElementById: get, createElement: element, createTextNode: text => text, body: element() },
    location: { search: '' }, window: { addEventListener() {} },
    URLSearchParams, URL, FormData, AbortSignal, crypto: { randomUUID },
    fetch: async (url, options) => {
      if (url.endsWith('/context')) return response({ available: true, brand: session.brand });
      if (url.endsWith('/session')) return response({ session });
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const submit = () => get('composer').handlers.submit({ preventDefault() {} });
  get('composer').requestSubmit = submit;
  return {
    get, submit, requests, focused: () => focused,
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
