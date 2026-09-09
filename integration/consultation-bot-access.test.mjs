import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { hashToken } from '../src/security.mjs';
import { requireBotAppointment, beginBotAppointmentAction, finishBotAppointmentAction, readBotAppointmentReport } from '../src/consultation-bot-access.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL enforces appointment-scoped one-use, concurrency and cumulative quotas', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl).pathname, /test/i, 'Only use an isolated test database');
  const schema = `bot_access_${randomBytes(8).toString('hex')}`;
  const previousKey = process.env.CONSULTATION_BOT_REPORT_KEY;
  process.env.CONSULTATION_BOT_REPORT_KEY = randomBytes(32).toString('hex');
  const reportPdf = Buffer.from('%PDF-1.4 synthetic report');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const execute = pool.query.bind(pool);
  const transaction = async fn => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  try {
    await pool.query(`
      CREATE TABLE agreements (id BIGINT PRIMARY KEY, slug TEXT, subdomain_prefix TEXT);
      CREATE TABLE appointments (id BIGINT PRIMARY KEY, agreement_id BIGINT, status TEXT,
        appointment_date DATE, end_time TIME);
      CREATE TABLE patient_appointment_access_links (id BIGINT PRIMARY KEY, token_hash TEXT,
        appointment_id BIGINT, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ);
      CREATE TABLE public_rate_limits (scope TEXT, key_hash TEXT, bucket_started_at TIMESTAMPTZ,
        hit_count INTEGER, updated_at TIMESTAMPTZ, PRIMARY KEY (scope, key_hash, bucket_started_at));
      INSERT INTO agreements VALUES (1, 'ypf', 'ypf');
      INSERT INTO appointments VALUES (1, 1, 'confirmed', CURRENT_DATE + 2, '18:00'),
        (2, 1, 'confirmed', CURRENT_DATE + 2, '18:00');
    `);
    await pool.query(await readFile(new URL('../migrations/022_consultation_bot_usage.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/023_consultation_bot_reports.sql', import.meta.url), 'utf8'));
    const token = randomBytes(32).toString('base64url');
    const second = randomBytes(32).toString('base64url');
    const other = randomBytes(32).toString('base64url');
    for (const [id, value, appointmentId] of [[1, token, 1], [2, second, 1], [3, other, 2]])
      await pool.query("INSERT INTO patient_appointment_access_links VALUES ($1, $2, $3, NOW() + INTERVAL '3 days', NULL)", [id, hashToken(value), appointmentId]);
    const req = value => ({ headers: { host: 'ypf.reku.io', cookie: `reku_bot_appointment=${value}` } });
    const request = req(token);
    assert.equal(String((await requireBotAppointment(request, { execute })).appointment_id), '1');
    await assert.rejects(requireBotAppointment({ headers: { host: 'www.reku.io', cookie: request.headers.cookie } }, { execute }), /ACCESS_REQUIRED/);
    await assert.rejects(requireBotAppointment(req('z'.repeat(43)), { execute }), /ACCESS_REQUIRED/);
    await assert.rejects(beginBotAppointmentAction(request, 2, 'message', { transaction }), /ACCESS_REQUIRED/);

    const racing = await Promise.allSettled([
      beginBotAppointmentAction(request, 1, 'message', { transaction }),
      beginBotAppointmentAction(req(second), 1, 'message', { transaction }),
    ]);
    assert.equal(racing.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(racing.find(result => result.status === 'rejected').reason.message, /ACCESS_BUSY/);
    const winner = racing.find(result => result.status === 'fulfilled').value;
    await finishBotAppointmentAction(winner, { execute }); // Recoverable provider failure still counts.
    const retry = await beginBotAppointmentAction(req(second), 1, 'message', { transaction });
    await assert.rejects(finishBotAppointmentAction(retry, { completed: true, execute }), /BOT_REPORT_INVALID/);
    assert.equal((await pool.query('SELECT completed_at FROM consultation_bot_usage WHERE appointment_id = 1')).rows[0].completed_at, null);
    await finishBotAppointmentAction(retry, { completed: true, reportPdf, execute });
    const saved = (await pool.query('SELECT * FROM consultation_bot_usage WHERE appointment_id = 1')).rows[0];
    assert.equal(saved.message_count, 2);
    assert.ok(saved.completed_at);
    assert.equal(saved.active_request_hash, null);
    assert.ok(saved.report_encrypted.startsWith('v1.'));
    assert.ok(!saved.report_encrypted.includes('synthetic report'));
    assert.deepEqual(await readBotAppointmentReport(request, { execute }), reportPdf);
    assert.deepEqual(await readBotAppointmentReport(req(second), { execute }), reportPdf);
    await assert.rejects(readBotAppointmentReport(req(other), { execute }), /BOT_REPORT_NOT_READY/);
    await assert.rejects(readBotAppointmentReport({ headers: { host: 'other.reku.io', cookie: request.headers.cookie } }, { execute }), /ACCESS_REQUIRED/);
    // A fresh Node process has no session map: exercise the real HTTP handler,
    // not just storage helpers, after reset and with foreign/tampered tokens.
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
    const routeCheck = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { Readable } from 'node:stream';
      import { handleConsultationBot } from './src/consultation-bot.mjs';
      import { pool } from './src/db.mjs';
      const call = async (host, action='report', token=${JSON.stringify(token)}) => {
        const request = Readable.from([Buffer.from('{}')]);
        request.method = action==='reset' ? 'POST' : 'GET';
        request.headers = {host, origin:'https://'+host, cookie:'reku_bot_appointment='+token};
        request.socket = {remoteAddress:'127.0.0.1'};
        let status, headers, body;
        await handleConsultationBot(request, {writeHead(code,h){status=code;headers=h;},end(value){body=value;}}, new URL('https://'+host+'/api/bot/'+action));
        return {status,headers,body};
      };
      try {
        assert.equal((await call('ypf.reku.io','reset')).status,200);
        const report=await call('ypf.reku.io');
        assert.equal(report.status,200);
        assert.equal(report.headers['Content-Type'],'application/pdf');
        assert.match(report.headers['Cache-Control'],/no-store/);
        assert.equal(report.body.toString(),'%PDF-1.4 synthetic report');
        assert.equal((await call('other.reku.io')).status,403);
        assert.equal((await call('ypf.reku.io','report','z'.repeat(43))).status,403);
      } finally {await pool.end();}
    `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, DATABASE_URL: isolatedUrl.href, APP_ENV: 'production', CONSULTATION_BOT_MODE: 'production', CONSULTATION_BOT_REPORT_KEY: process.env.CONSULTATION_BOT_REPORT_KEY } });
    assert.equal(routeCheck.status, 0, routeCheck.stderr);
    for (const value of [token, second]) {
      await assert.rejects(requireBotAppointment(req(value), { execute }), /ACCESS_COMPLETED/);
      await assert.rejects(beginBotAppointmentAction(req(value), 1, 'transcribe', { transaction }), /ACCESS_COMPLETED/);
    }
    assert.ok(await requireBotAppointment(request, { allowCompleted: true, execute }));

    // A different appointment has its own allowance; renewal cannot reset counters.
    const next = await beginBotAppointmentAction(req(other), 2, 'transcribe', { transaction });
    await finishBotAppointmentAction(next, { execute });
    const crashed = await beginBotAppointmentAction(req(other), 2, 'message', { transaction });
    await pool.query("UPDATE consultation_bot_usage SET active_until = NOW() - INTERVAL '1 second' WHERE appointment_id = 2");
    const recovered = await beginBotAppointmentAction(req(other), 2, 'message', { transaction });
    await assert.rejects(finishBotAppointmentAction(crashed, { completed: true, reportPdf, execute }), /ACCESS_BUSY/);
    await finishBotAppointmentAction(recovered, { execute });
    await pool.query('UPDATE consultation_bot_usage SET audio_count = 15, message_count = 25 WHERE appointment_id = 2');
    for (const kind of ['message', 'transcribe']) await assert.rejects(beginBotAppointmentAction(req(other), 2, kind, { transaction }), /ACCESS_LIMIT/);
    await pool.query("UPDATE appointments SET status = 'cancelled' WHERE id = 2");
    await assert.rejects(requireBotAppointment(req(other), { execute }), /ACCESS_REQUIRED/);
    await pool.query("UPDATE appointments SET status = 'confirmed' WHERE id = 2");
    await pool.query('UPDATE patient_appointment_access_links SET revoked_at = NOW() WHERE id = 3');
    await assert.rejects(requireBotAppointment(req(other), { execute }), /ACCESS_REQUIRED/);
    await pool.query("UPDATE patient_appointment_access_links SET revoked_at = NULL, expires_at = NOW() - INTERVAL '1 second' WHERE id = 3");
    await assert.rejects(requireBotAppointment(req(other), { execute }), /ACCESS_REQUIRED/);
  } finally {
    if (previousKey === undefined) delete process.env.CONSULTATION_BOT_REPORT_KEY; else process.env.CONSULTATION_BOT_REPORT_KEY = previousKey;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
