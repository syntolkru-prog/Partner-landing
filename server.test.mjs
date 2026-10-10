import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplicationServer } from './server.mjs';

const origin = 'https://partners.syntolk.ru';
const testRoot = path.resolve('.test-temp');
const valid = () => ({ name: 'Проверка <b>имени</b>', phone: '+79991234567', contact: 'test@example.com', direction: 'Автор или блогер', audience: 'Тестовая заявка без отправки письма.', consent: true, website: '' });
async function fixture(t, options = {}) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, 'syntolk-partner-test-'));
  const publicDir = path.join(root, 'public'), dataDir = path.join(root, 'data');
  await mkdir(publicDir); await writeFile(path.join(publicDir, 'index.html'), '<h1>Syntolk</h1>');
  const app = await createApplicationServer({ publicDir, dataDir, publicOrigin: origin, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.flush(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); assert.equal(path.dirname(path.resolve(root)), testRoot); assert(path.basename(root).startsWith('syntolk-partner-test-')); await rm(root, { recursive: true, force: true }); });
  return { ...app, dataDir, publicDir, base, post: (body, key = randomUUID(), headers = {}) => fetch(base + '/api/partner-applications', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) };
}

test('сохраняет заявку и повтор с тем же ключом не создаёт дубликат', async t => {
  const app = await fixture(t); const id = randomUUID(), body = valid();
  const response = await app.post(body, id); assert.equal(response.status, 201); assert.deepEqual(await response.json(), { ok: true, id });
  const record = JSON.parse(await readFile(path.join(app.dataDir, id + '.json'), 'utf8'));
  const { website, ...storedBody } = body; assert.deepEqual(record.application, storedBody); assert.equal(record.delivery, 'pending');
  assert.equal((await app.post(body, id)).status, 201); assert.equal((await readdir(app.dataDir)).length, 1);
  assert.equal((await app.post({ ...body, name: 'Другое имя' }, id)).status, 409);
});
test('принимает Telegram вместе с обязательным телефоном', async t => {
  const app = await fixture(t);
  assert.equal((await app.post({ ...valid(), contact: '@partner_test' })).status, 201);
});
test('телефон обязателен; сохраняет международные номера без разделителей и передаёт в уведомление', async t => {
  const notifications = [];
  const app = await fixture(t, { sendMail: async record => { notifications.push(record); }, rateMax: 20 });
  for (const phone of ['', '12345', '+7 999 call me', '1234567890123456', '+7\n9991234567']) assert.equal((await app.post({ ...valid(), phone })).status, 400);
  const { phone, ...withoutPhone } = valid();
  assert.equal((await app.post(withoutPhone)).status, 400);
  for (const number of ['+7 (999) 123-45-67', '+44 20 7946 0958', '8 999 123 45 67']) {
    const id = randomUUID();
    assert.equal((await app.post({ ...valid(), phone: number }, id)).status, 201);
    const record = JSON.parse(await readFile(path.join(app.dataDir, id + '.json'), 'utf8'));
    assert.equal(record.application.phone, number.replace(/[ ()-]/g, ''));
  }
  for (let i = 0; i < 20 && notifications.length < 3; i++) { await app.flush(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(notifications.length, 3);
  assert.equal(notifications[0].application.phone, '+79991234567');
});
test('отклоняет неверные поля, инъекцию заголовков, отсутствие согласия и ловушку', async t => {
  const app = await fixture(t, { rateMax: 20 });
  for (const changes of [{ name: '' }, { name: 'Имя\nBcc: test@example.com' }, { contact: 'no-contact' }, { consent: false }, { website: 'https://spam.example' }, { direction: 'unknown' }, { audience: 'a'.repeat(2001) }]) assert.equal((await app.post({ ...valid(), ...changes })).status, 400);
  assert.equal((await readdir(app.dataDir)).length, 0);
});
test('не принимает запрос с постороннего сайта или неверным форматом', async t => {
  const app = await fixture(t);
  assert.equal((await app.post(valid(), randomUUID(), { Origin: 'https://other.example' })).status, 403);
  assert.equal((await app.post(valid(), randomUUID(), { Origin: 'null' })).status, 403);
  assert.equal((await app.post(valid(), randomUUID(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.post('{broken')).status, 400);
  assert.equal((await app.post(valid(), 'bad-key')).status, 400);
  assert.equal((await readdir(app.dataDir)).length, 0);
});
test('ограничивает размер и число запросов', async t => {
  const app = await fixture(t, { rateMax: 2 });
  assert.equal((await app.post('x'.repeat(17000))).status, 413);
  assert.equal((await app.post(valid())).status, 201);
  assert.equal((await app.post(valid())).status, 201);
  const limited = await app.post(valid()); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '900');
});
test('раздаёт только public/, без доступа к заявкам и серверному коду', async t => {
  const app = await fixture(t); const id = randomUUID(); await app.post(valid(), id);
  assert.equal((await fetch(app.base + '/')).status, 200);
  for (const name of ['/server.mjs', '/.env', `/data/${id}.json`, '/../data/' + id + '.json', '/%2e%2e%2fdata%2f' + id + '.json']) assert.equal((await fetch(app.base + name)).status, 404);
  assert.equal((await fetch(app.base + '/api/partner-applications')).status, 405);
});
test('сбой уведомления сохраняет заявку, очередь повторяет доставку', async t => {
  let available = false, sent = 0;
  const app = await fixture(t, { sendMail: async () => { if (!available) throw new Error('test SMTP offline'); sent++; } });
  const id = randomUUID(); assert.equal((await app.post(valid(), id)).status, 201);
  // Wait for the request-triggered drain to finish before testing the explicit retry.
  for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 5)); if ((await readFile(path.join(app.dataDir, id + '.json'), 'utf8')).includes('pending')) break; }
  available = true;
  for (let i = 0; i < 20 && !sent; i++) { await app.flush(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(sent, 1);
  assert.equal(JSON.parse(await readFile(path.join(app.dataDir, id + '.json'), 'utf8')).delivery, 'sent');
  await app.flush(); assert.equal(sent, 1);
});
test('не разрешает хранить заявки в публичной папке', async t => {
  const app = await fixture(t);
  await assert.rejects(createApplicationServer({ publicDir: app.publicDir, dataDir: path.join(app.publicDir, 'data') }), /outside public/);
});
