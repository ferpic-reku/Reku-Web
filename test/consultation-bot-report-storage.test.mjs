import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBotReport, decryptBotReport, requireBotReportKey } from '../src/consultation-bot-report-storage.mjs';

test('final PDF encryption is appointment-bound, authenticated, bounded and requires an explicit key', () => {
  const before = process.env.CONSULTATION_BOT_REPORT_KEY;
  try {
    delete process.env.CONSULTATION_BOT_REPORT_KEY;
    assert.throws(requireBotReportKey, /BOT_REPORT_KEY_REQUIRED/);
    process.env.CONSULTATION_BOT_REPORT_KEY = 'test-only-report-key-not-a-real-secret';
    const pdf = Buffer.from('%PDF-1.4 fictional consultation');
    const encrypted = encryptBotReport(pdf, '123');
    assert.notEqual(encryptBotReport(pdf, '123'), encrypted);
    assert.deepEqual(decryptBotReport(encrypted, '123'), pdf);
    assert.throws(() => decryptBotReport(encrypted, '456'), /BOT_REPORT_DECRYPT_FAILED/);
    assert.throws(() => encryptBotReport(Buffer.alloc(2 * 1024 * 1024 + 1), '123'), /BOT_REPORT_INVALID/);
    assert.throws(() => encryptBotReport(Buffer.from('not pdf'), '123'), /BOT_REPORT_INVALID/);
    process.env.CONSULTATION_BOT_REPORT_KEY = 'a-different-test-key-not-a-real-secret';
    assert.throws(() => decryptBotReport(encrypted, '123'), /BOT_REPORT_DECRYPT_FAILED/);
  } finally {
    if (before === undefined) delete process.env.CONSULTATION_BOT_REPORT_KEY; else process.env.CONSULTATION_BOT_REPORT_KEY = before;
  }
});
