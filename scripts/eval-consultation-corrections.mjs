// Opt-in real-model checks; fictional messages only, never patient session logs.
// node --env-file=.env scripts/eval-consultation-corrections.mjs
import assert from 'node:assert/strict';
import { advanceConsultation } from '../src/consultation-bot-conversation.mjs';
const fixtures = [
  { name: 'deny_head_then_knee', texts: ['Me duele la cabeza', 'No, no era la cabeza', 'Me duele la rodilla izquierda', 'Hace dos semanas'], checks: [
    null, t => { assert.equal(t.data.complaints.length, 0); assert.ok(!/cabeza/i.test(t.next.text)); },
    t => { assert.match(t.data.complaints[0].location, /rodilla/i); assert.ok(!JSON.stringify(t.data.complaints).includes('cabeza')); },
    t => assert.ok(!/cabeza/i.test(JSON.stringify(t.data.complaints))),
  ] },
  { name: 'replace_while_asked_onset', texts: ['Me duele la cabeza', 'No es la cabeza, es el tobillo derecho'], checks: [null,
    t => { assert.equal(t.data.complaints.length, 1); assert.match(t.data.complaints[0].location, /tobillo/i); assert.ok(!/cabeza/i.test(t.next.text)); assert.notEqual(t.data.complaints[0].id, 'c1'); },
  ] },
  { name: 'vague_correction_then_side', texts: ['Me duele la rodilla derecha', 'No, me entendiste mal', 'Es la izquierda, no la derecha'], checks: [null,
    t => assert.equal(t.next.field, 'correction'), t => { assert.match(t.data.complaints[0].side, /izquierd/i); assert.equal(t.data.complaints.length, 1); },
  ] },
  { name: 'unknown_onset_is_not_retraction', texts: ['Me duele la rodilla izquierda', 'No sé desde cuándo'], checks: [null,
    t => { assert.equal(t.data.complaints.length, 1); assert.match(t.data.complaints[0].onset, /no informado/i); },
  ] },
  { name: 'gibberish_does_not_create_headache', texts: ['sarasa piripipi blabla'], checks: [t => { assert.equal(t.data.complaints.length, 0); assert.ok(!t.next.complete); }] },
  { name: 'no_pain_now_keeps_injury', texts: ['Me torcí el tobillo derecho caminando ayer', 'Ahora no me duele'], checks: [null,
    t => { assert.equal(t.data.complaints.length, 1); assert.equal(t.data.complaints[0].pain, 0); },
  ] },
];
async function run(fixture) {
  let session = { data: null, version: 0 };
  const messages = [];
  for (const [index, text] of fixture.texts.entries()) {
    messages.push({ role: 'user', text });
    const turn = await advanceConsultation(session, messages, { chooseFollowup: async () => null });
    fixture.checks[index]?.(turn);
    session = { data: turn.data, lastQuestion: turn.next, version: session.version + 1 };
    messages.push({ role: 'assistant', text: turn.next.text });
  }
  console.log(JSON.stringify({ fixture: fixture.name, passed: true }));
}
for (let i = 0; i < fixtures.length; i += 2) await Promise.all(fixtures.slice(i, i + 2).map(run));
