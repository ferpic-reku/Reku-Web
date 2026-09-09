import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceConsultation, mergeConsultationData } from '../src/consultation-bot-conversation.mjs';
import { fallbackConsultationNarrative } from '../src/consultation-bot-narrative.mjs';

const symptom = (id = 'c1', location = 'cabeza') => ({ id, reason: `Dolor de ${location}`, location, locationClear: true,
  sideRequired: false, side: null, onset: 'ayer', mechanism: 'de a poco', mechanismClear: true, pain: null,
  painNote: null, limitations: null, evidence: { reason: 'me duele', location, onset: 'ayer', mechanism: 'de a poco' } });
const state = (complaints = [symptom()]) => ({ complaints, urgent: false, priorCare: null, goal: null, followups: [] });
const correction = (field, evidence, complaintId = 'c1') => ({ complaintId, field, evidence });
const analyzeAs = data => ({ analyze: async () => data, chooseFollowup: async () => null });
const messages = text => [{ role: 'user', text }];

test('a denied symptom is removed before asking the pending pain question; stale extraction cannot resurrect it', async () => {
  const previous = state([symptom(), symptom('c2', 'rodilla')]);
  previous.followups = [{ complaintId: 'c1', question: 'Detalle de cabeza', answer: 'ayer' }];
  const text = 'No me duele la cabeza';
  const extracted = { ...state([symptom()]), corrections: [correction('complaint', text)], lastAnswer: { status: 'correction', value: null, evidence: text } };
  const turn = await advanceConsultation({ data: previous, version: 2, lastQuestion: { complaintId: 'c1', field: 'pain', text: '¿Cuánto te duele la cabeza?' } }, messages(text), analyzeAs(extracted));
  assert.deepEqual(turn.data.complaints.map(item => item.id), ['c2']);
  assert.ok(!turn.next.text.includes('cabeza'));
  assert.equal(turn.data.followups.length, 0);
  assert.equal(turn.data.followupCount, 1);
  const later = mergeConsultationData(turn.data, state([symptom(), symptom(null)]), '4', { complaintId: 'c2', field: 'pain' });
  assert.deepEqual(later.complaints.map(item => item.id), ['c2']);
  assert.ok(!fallbackConsultationNarrative(later).includes('cabeza'));
});

test('denying the only complaint asks what actually happened instead of finishing', async () => {
  const text = 'No era la cabeza';
  const turn = await advanceConsultation({ data: state(), version: 2 }, messages(text), analyzeAs({ ...state([]), corrections: [correction('complaint', text)] }));
  assert.equal(turn.data.complaints.length, 0);
  assert.equal(turn.next.key, 'reason');
  assert.ok(!turn.next.complete);
});

test('replacement complaint gets a fresh id and does not inherit pain or onset', () => {
  const text = 'No es cabeza, me duele la rodilla';
  const replacement = { ...symptom(null, 'rodilla'), onset: null, mechanism: null, evidence: { reason: 'me duele', location: 'rodilla' } };
  const data = mergeConsultationData(state(), { ...state([replacement]), corrections: [correction('complaint', text)] }, text, { field: 'pain', complaintId: 'c1' });
  assert.equal(data.complaints[0].id, 'c2');
  assert.equal(data.complaints[0].location, 'rodilla');
  assert.equal(data.complaints[0].onset, null);
});

test('a cleared field cannot be filled by old evidence, then accepts a new clarification', () => {
  const previous = state([{ ...symptom('c1', 'rodilla'), side: 'derecha', sideRequired: true, evidence: { side: 'derecha' } }]);
  const text = 'No es derecha';
  let data = mergeConsultationData(previous, { ...state([]), corrections: [correction('side', text)] }, text, { field: 'onset', complaintId: 'c1' });
  assert.equal(data.complaints[0].side, null);
  data = mergeConsultationData(data, previous, 'no sé', null);
  assert.equal(data.complaints[0].side, null);
  const fresh = { ...symptom('c1', 'rodilla'), side: 'izquierda', evidence: { side: 'izquierda' } };
  data = mergeConsultationData(data, state([fresh]), 'izquierda', { field: 'side', complaintId: 'c1' });
  assert.equal(data.complaints[0].side, 'izquierda');
  assert.equal(data.complaints[0].onset, 'ayer');
});

test('unverified correction or invented id cannot delete a complaint', () => {
  const data = mergeConsultationData(state(), { ...state([]), corrections: [correction('complaint', 'no cabeza'), correction('complaint', 'hola', 'c99')] }, 'hola', null);
  assert.equal(data.complaints.length, 1);
});

test('unclear correction pauses even when all fields are complete and does not become a followup answer', async () => {
  const previous = state([{ ...symptom(), pain: 4 }]);
  previous.followups = [{ complaintId: 'c1', question: '¿Algo más?', answer: null }];
  const text = 'No, me entendiste mal';
  const turn = await advanceConsultation({ data: previous, version: 3, lastQuestion: { field: 'followup', complaintId: 'c1', followupIndex: 0 } }, messages(text), {
    analyze: async () => ({ ...state([]), lastAnswer: { status: 'correction_unclear', evidence: text, value: null } }),
    chooseFollowup: async () => { throw new Error('Must clarify first'); },
  });
  assert.equal(turn.next.field, 'correction');
  assert.equal(turn.data.followups[0].answer, null);
  assert.ok(!turn.next.complete);
});

test('unintelligible followup answer stays pending and does not consume another question', async () => {
  const previous = state([{ ...symptom(), pain: 4 }]);
  previous.followups = [{ complaintId: 'c1', question: '¿Notaste algún cambio?', answer: null }];
  const turn = await advanceConsultation({ data: previous, version: 3, lastQuestion: { field: 'followup', complaintId: 'c1', followupIndex: 0, text: '¿Notaste algún cambio?' } }, messages('mmm lalala'), {
    analyze: async () => ({ ...state([]), lastAnswer: { status: 'unclear', value: null, evidence: 'mmm lalala' } }),
    chooseFollowup: async () => { throw new Error('Must clarify first'); },
  });
  assert.equal(turn.next.field, 'followup');
  assert.equal(turn.data.followups[0].answer, null);
  assert.equal(turn.data.followupCount, 1);
});

test('unresolved correction cannot silently resume the old questionnaire on an unrelated reply', async () => {
  const turn = await advanceConsultation({ data: state(), version: 3, lastQuestion: { field: 'correction', key: 'correction' } }, messages('hola'), analyzeAs({
    ...state([]), lastAnswer: { status: 'unrelated', value: null, evidence: 'hola' },
  }));
  assert.equal(turn.next.field, 'correction');
  assert.ok(!turn.next.text.includes('cabeza'));
});
