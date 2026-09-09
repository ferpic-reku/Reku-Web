import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashToken } from '../src/security.mjs';
import { requireBotAppointment, beginBotAppointmentAction, finishBotAppointmentAction } from '../src/consultation-bot-access.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL enforces appointment-scoped one-use, concurrency and cumulative quotas', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl).pathname, /test/i, 'Only use an isolated test database');
  const schema = `bot_access_${randomBytes(8).toString('hex')}`;
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
      INSERT INTO agreements VALUES (1, 'ypf', 'ypf');
      INSERT INTO appointments VALUES (1, 1, 'confirmed', CURRENT_DATE + 2, '18:00'),
        (2, 1, 'confirmed', CURRENT_DATE + 2, '18:00');
    `);
    await pool.query(await readFile(new URL('../migrations/022_consultation_bot_usage.sql', import.meta.url), 'utf8'));
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
    await finishBotAppointmentAction(retry, { completed: true, execute });
    const saved = (await pool.query('SELECT * FROM consultation_bot_usage WHERE appointment_id = 1')).rows[0];
    assert.equal(saved.message_count, 2);
    assert.ok(saved.completed_at);
    assert.equal(saved.active_request_hash, null);
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
    await assert.rejects(finishBotAppointmentAction(crashed, { completed: true, execute }), /ACCESS_BUSY/);
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
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
