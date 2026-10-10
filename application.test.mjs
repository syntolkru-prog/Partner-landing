import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="partner-application-script">([\s\S]*?)<\/script>/)[1];

// Exercise the shipped form's events and requests without starting a browser.
function setup({ protocol = 'https:', fetch: send = async () => ({ ok: true, json: async () => ({ ok: true, id: randomUUID() }) }) } = {}) {
  let focused;
  class Element {
    constructor(props = {}) { Object.assign(this, { value: '', checked: false, disabled: false, hidden: false, attrs: {}, events: {}, children: [], textContent: '' }, props); this.classes = new Set(); this.classList = { toggle: (key, on) => on ? this.classes.add(key) : this.classes.delete(key) }; }
    addEventListener(type, callback) { this.events[type] = callback; }
    setAttribute(key, value) { this.attrs[key] = value; }
    removeAttribute(key) { delete this.attrs[key]; }
    querySelectorAll() { return this.children; }
    querySelector() { return this.children[0]; }
    focus() { focused = this; }
    async fire(type) { await this.events[type]?.({ preventDefault() {} }); }
  }
  const keys = ['name', 'phone', 'contact', 'direction', 'audience', 'consent'];
  const ids = new Map(), groups = {}, fields = {};
  const form = new Element({ dataset: { endpoint: '/api/partner-applications' } });
  for (const key of [...keys, 'website']) {
    fields[key] = key === 'direction' ? ['Автор или блогер', 'CRM-интеграция и автоматизация'].map(value => new Element({ value })) : [new Element()];
    if (key !== 'website') { groups[key] = new Element({ children: fields[key] }); ids.set(key + '-error', new Element({ hidden: true })); }
  }
  const submit = new Element({ disabled: true });
  ids.set('partner-form', form); ids.set('form-status', new Element()); ids.set('form-fallback', new Element({ hidden: true })); ids.set('application-email', new Element()); ids.set('application-submit-label', new Element());
  form.children = Object.values(fields).flat();
  form.querySelector = selector => selector === '[type="submit"]' ? submit : selector === '[name="consent"]' ? fields.consent[0] : groups[selector.match(/data-field="(.*?)"/)[1]];
  form.reset = () => { for (const [key, controls] of Object.entries(fields)) for (const control of controls) { if (key !== 'direction') control.value = ''; control.checked = false; } };
  class FormData {
    get(key) { if (key === 'direction') return fields[key].find(control => control.checked && !control.disabled)?.value || null; const control = fields[key]?.[0]; return !control || control.disabled ? null : key === 'consent' ? control.checked ? 'on' : null : control.value; }
  }
  const calls = [];
  vm.runInNewContext(script, { document: { getElementById: key => ids.get(key) }, FormData, location: { protocol }, crypto: { randomUUID }, AbortController, setTimeout, clearTimeout, Error, TypeError, fetch: async (...args) => { calls.push(args); return send(...args); } });
  const valid = () => { fields.name[0].value = ' Анна '; fields.phone[0].value = '+7 (999) 123-45-67'; fields.contact[0].value = '@syntolk_test'; fields.direction[1].checked = true; fields.consent[0].checked = true; };
  return { form, fields, groups, submit, calls, valid, focused: () => focused, node: id => ids.get(id), send: () => form.fire('submit') };
}

test('пустая заявка показывает ошибки рядом с полями, фокусирует имя и не отправляется', async () => {
  const app = setup(); await app.send();
  assert.equal(app.calls.length, 0);
  assert.equal(app.focused(), app.fields.name[0]);
  for (const field of ['name', 'phone', 'contact', 'direction', 'consent']) assert.equal(app.node(field + '-error').hidden, false);
  assert.equal(app.node('audience-error').hidden, true);
});
test('обязательный телефон проверяется отдельно; исправление убирает ошибку', async () => {
  const app = setup(); app.valid(); app.fields.phone[0].value = '123'; await app.send();
  assert.equal(app.calls.length, 0); assert.equal(app.focused(), app.fields.phone[0]);
  assert.equal(app.fields.phone[0].attrs['aria-invalid'], 'true');
  app.fields.phone[0].value = '+44 20 7946 0958'; await app.groups.phone.fire('input');
  assert.equal(app.node('phone-error').hidden, true); assert.equal(app.fields.phone[0].attrs['aria-invalid'], undefined);
});
test('отправляет телефон и выбранное направление, подтверждает сохранение и очищает форму', async () => {
  const app = setup(); app.valid(); await app.send();
  assert.equal(app.calls.length, 1);
  const [url, request] = app.calls[0];
  assert.equal(url, '/api/partner-applications');
  assert.deepEqual(JSON.parse(request.body), { name: 'Анна', phone: '+79991234567', contact: '@syntolk_test', direction: 'CRM-интеграция и автоматизация', audience: '', consent: true, website: '' });
  assert.equal(app.node('form-status').className, 'form-status is-success');
  assert.equal(app.fields.phone[0].value, ''); assert.equal(app.fields.direction[1].checked, false);
  assert.equal(app.submit.disabled, false); assert(app.form.children.every(control => !control.disabled));
  assert.equal(app.focused(), app.node('form-status'));
});
test('сбой сохраняет заполнение и ключ повтора; изменение телефона создаёт новый ключ', async () => {
  const app = setup({ fetch: async () => { throw new TypeError('offline'); } }); app.valid();
  await app.send(); await app.send();
  assert.equal(app.fields.phone[0].value, '+7 (999) 123-45-67'); assert.equal(app.node('form-fallback').hidden, false);
  assert.match(decodeURIComponent(app.node('application-email').href), /Телефон: \+79991234567/);
  assert.equal(app.calls[0][1].headers['Idempotency-Key'], app.calls[1][1].headers['Idempotency-Key']);
  app.fields.phone[0].value = '+44 20 7946 0958'; await app.send();
  assert.notEqual(app.calls[1][1].headers['Idempotency-Key'], app.calls[2][1].headers['Idempotency-Key']);
});
test('ожидание ответа блокирует двойную отправку и изменение заявки', async () => {
  let complete;
  const app = setup({ fetch: () => new Promise(resolve => { complete = resolve; }) }); app.valid();
  const pending = app.send(); await app.send();
  assert.equal(app.calls.length, 1); assert.equal(app.submit.disabled, true); assert(app.form.children.every(control => control.disabled));
  complete({ ok: true, json: async () => ({ ok: true, id: randomUUID() }) }); await pending;
  assert.equal(app.submit.disabled, false); assert(app.form.children.every(control => !control.disabled));
});
test('локальный предпросмотр не сообщает об отправке и предлагает письмо с телефоном', async () => {
  const app = setup({ protocol: 'file:' }); app.valid(); await app.send();
  assert.equal(app.calls.length, 0); assert.equal(app.node('form-fallback').hidden, false);
  assert.match(app.node('form-status').textContent, /после публикации/);
  assert.equal(app.fields.name[0].value, ' Анна ');
});
