import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, realpath } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 16 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const TELEGRAM = /^(?:@|https:\/\/t\.me\/)[a-z0-9_]{3,32}$/i;
const DIRECTIONS = new Set(['Автор или блогер', 'Образование и преподавание', 'Эксперт или консультант', 'Агентство или работа с бизнесом', 'CRM-интеграция и автоматизация', 'Профессиональное сообщество', 'Пока выбираю направление', 'Другое направление']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const inside = (root, filename) => filename === root || filename.startsWith(root + path.sep);
const digest = value => createHash('sha256').update(value).digest('hex');

function fail(status, message) { return Object.assign(new Error(message), { status }); }
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Проверьте поля заявки.');
  const text = (key, max) => {
    if (typeof body[key] !== 'string' || body[key].trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body[key])) throw fail(400, 'Проверьте поля заявки.');
    return body[key].trim();
  };
  const name = text('name', 100), contact = text('contact', 160), direction = text('direction', 100), audience = text('audience', 2000);
  if (!name || /[\r\n]/.test(name) || !(EMAIL.test(contact) || TELEGRAM.test(contact)) || !DIRECTIONS.has(direction) || body.consent !== true || body.website !== '') throw fail(400, 'Укажите имя, email или Telegram, направление и согласие на обработку данных.');
  return { name, contact, direction, audience, consent: true };
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Неверный формат запроса.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail(413, 'Заявка слишком большая.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Проверьте поля заявки.'); }
}

export async function createApplicationServer({ publicDir = path.join(here, 'public'), dataDir = path.join(here, 'data'), publicOrigin = '', sendMail = null, trustProxy = false, retryMs = 60_000, rateMax = 8 } = {}) {
  const root = await realpath(publicDir);
  const storage = path.resolve(dataDir);
  if (inside(root, storage)) throw new Error('DATA_DIR must be outside public/.');
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const storageReal = await realpath(storage);
  if (inside(root, storageReal)) throw new Error('DATA_DIR must be outside public/.');
  const limits = new Map();
  let flushing = false;
  async function deliver(filename) {
    const location = path.join(storage, filename);
    const record = JSON.parse(await readFile(location, 'utf8'));
    if (record.delivery === 'sent' || !sendMail) return;
    await sendMail(record);
    const temporary = location + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify({ ...record, delivery: 'sent', deliveredAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(temporary, location);
  }
  async function flush() {
    if (flushing || !sendMail) return;
    flushing = true;
    try {
      for (const file of await readdir(storage)) {
        if (!UUID.test(file.slice(0, -5)) || !file.endsWith('.json')) continue;
        try { await deliver(file); }
        catch { console.error('Partner notification pending:', file.slice(0, -5)); }
      }
    } finally { flushing = false; }
  }
  function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/partner-applications') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw fail(405, 'Используйте форму заявки.'); }
        const origin = req.headers.origin;
        const expectedOrigin = publicOrigin || `http://${req.headers.host}`;
        if (origin !== expectedOrigin) throw fail(403, 'Отправьте заявку с сайта Syntolk.');
        if (Number(req.headers['content-length'] || 0) > MAX_BODY) throw fail(413, 'Заявка слишком большая.');
        const ip = trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
        const ipKey = digest(ip || 'unknown'), now = Date.now();
        for (const [key, value] of limits) if (value.until < now) limits.delete(key);
        const rate = limits.get(ipKey) || { count: 0, until: now + 15 * 60_000 };
        if (++rate.count > rateMax) { res.setHeader('Retry-After', '900'); throw fail(429, 'Слишком много попыток. Повторите позже или напишите на support@syntolk.ru.'); }
        limits.set(ipKey, rate);
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !UUID.test(key)) throw fail(400, 'Обновите страницу и повторите отправку.');
        const application = validate(await jsonBody(req));
        const payloadHash = digest(JSON.stringify(application));
        const record = { id: key, createdAt: new Date().toISOString(), application, payloadHash, delivery: 'pending' };
        try { await writeFile(path.join(storage, key + '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const previous = JSON.parse(await readFile(path.join(storage, key + '.json'), 'utf8'));
          if (previous.payloadHash !== payloadHash) throw fail(409, 'Данные изменились. Повторите отправку заявки.');
        }
        send(res, 201, { ok: true, id: key });
        void flush().catch(() => console.error('Partner notification queue unavailable.'));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Метод не поддерживается.');
      let requested;
      try { requested = decodeURIComponent(url.pathname); } catch { throw fail(400, 'Неверный адрес.'); }
      const filename = path.resolve(root, '.' + (requested === '/' ? '/index.html' : requested));
      if (!inside(root, filename) || !MIME[path.extname(filename)]) throw fail(404, 'Страница не найдена.');
      let resolved;
      try { resolved = await realpath(filename); } catch { throw fail(404, 'Страница не найдена.'); }
      if (!inside(root, resolved)) throw fail(404, 'Страница не найдена.');
      const data = await readFile(resolved);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)], 'Cache-Control': path.extname(filename) === '.html' ? 'no-cache' : 'public, max-age=3600', 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!error.status) console.error('Partner request failed:', error.code || 'internal');
      if (!res.headersSent) send(res, error.status || 503, { ok: false, message: error.status ? error.message : 'Не удалось сохранить заявку. Попробуйте ещё раз или напишите на support@syntolk.ru.' });
      else res.end();
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 15_000;
  const timer = setInterval(() => void flush().catch(() => console.error('Partner notification queue unavailable.')), retryMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return { server, flush };
}

async function main() {
  if (!process.env.PUBLIC_ORIGIN || !process.env.SMTP_HOST || !process.env.SMTP_FROM || !process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error('Configure PUBLIC_ORIGIN and SMTP settings in .env before starting.');
  const origin = new URL(process.env.PUBLIC_ORIGIN);
  if (origin.origin !== process.env.PUBLIC_ORIGIN || origin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must be an HTTPS origin with no path.');
  const to = process.env.APPLICATION_TO || 'support@syntolk.ru';
  if (!EMAIL.test(to) || !EMAIL.test(process.env.SMTP_FROM)) throw new Error('Invalid sender or recipient.');
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: process.env.SMTP_SECURE !== 'false', requireTLS: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  await transport.verify();
  const { server, flush } = await createApplicationServer({ publicOrigin: origin.origin, dataDir: path.resolve(process.env.DATA_DIR || path.join(here, 'data')), trustProxy: process.env.TRUST_PROXY === 'true', sendMail: async ({ id, createdAt, application: a }) => {
    const result = await transport.sendMail({ from: process.env.SMTP_FROM, to, replyTo: EMAIL.test(a.contact) ? a.contact : undefined, messageId: `<partner-${id}@${origin.hostname}>`, subject: 'Новая заявка партнёра Syntolk', text: [`Заявка: ${id}`, `Дата: ${createdAt}`, `Имя: ${a.name}`, `Связь: ${a.contact}`, `Направление: ${a.direction}`, `Аудитория или проект: ${a.audience || 'Не указано'}`, 'Согласие на обработку данных: получено'].join('\n') });
    if (!result.accepted?.length) throw new Error('SMTP did not accept the notification.');
  } });
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('Syntolk partner server is ready.'));
  void flush();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { transport.close(); process.exit(0); }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
