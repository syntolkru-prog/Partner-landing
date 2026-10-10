import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./public/Syntolk-product-demo.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const landingHtml = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const landingScript = landingHtml.match(/const sdRoot=document\.querySelector\('\.sd-app'\);[\s\S]*?sdFilter\(\);(?=\s*const clients)/)[0];

// A small event harness tests the shipped script without a browser or layout engine.
function setup(documentHtml = html, documentScript = script) {
  let focused;
  class Element {
    constructor(props = {}) { Object.assign(this, { dataset: {}, value: '', hidden: false, attrs: {}, events: {} }, props); this.classes = new Set(); this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }; }
    addEventListener(name, callback) { this.events[name] = callback; }
    setAttribute(name, value) { this.attrs[name] = value; }
    focus() { focused = this; }
    fire(name, props = {}) { const event = { preventDefault() { this.prevented = true; }, ...props }; this.events[name]?.(event); return event; }
  }
  const tabs = [...documentHtml.matchAll(/id="sd-tab-([a-z]+)"[^>]*data-sd-view="([a-z]+)"/g)].map(m => new Element({ id: 'sd-tab-' + m[1], dataset: { sdView: m[2] } }));
  const panels = [...documentHtml.matchAll(/id="(sd-panel-[a-z]+)" role="tabpanel"[^>]*?( hidden)?>/g)].map(m => new Element({ id: m[1], hidden: Boolean(m[2]) }));
  const files = [...documentHtml.matchAll(/data-sd-category="([^"]+)" data-sd-file="([^"]+)"/g)].map(m => new Element({ dataset: { sdCategory: m[1], sdFile: m[2] } }));
  const folders = [...documentHtml.matchAll(/data-sd-folder="([^"]*)"/g)].map(m => new Element({ dataset: { sdFolder: m[1] } }));
  assert.equal(tabs.length, 3); assert.equal(panels.length, 3); assert.equal(files.length, 12); assert.equal(folders.length, 13);
  const nodes = new Map(['.sd-panels', '[data-sd-source]', '[data-sd-back]', '#sd-source-heading', '#sd-citation', '#sd-search', '#sd-category', '#sd-file-count', '#sd-empty'].map(key => [key, new Element()]));
  const lists = { '[data-sd-view]': tabs, '[role="tabpanel"]': panels, '[data-sd-file]': files, '[data-sd-folder]': folders };
  const root = { querySelector: selector => { assert(nodes.has(selector), selector); return nodes.get(selector); }, querySelectorAll: selector => { assert(selector in lists, selector); return lists[selector]; } };
  vm.runInNewContext(documentScript, { document: { querySelector: selector => { assert.equal(selector, '.sd-app'); return root; } } });
  return { tabs, panels, files, folders, node: selector => nodes.get(selector), focused: () => focused };
}

test('вкладки показывают только выбранный экран, клавиатура замыкает цикл', () => {
  const app = setup();
  app.tabs[0].fire('click');
  assert.deepEqual(app.panels.map(p => p.hidden), [false, true, true]);
  assert.equal(app.tabs[0].attrs['aria-selected'], 'true');
  assert(app.tabs[0].fire('keydown', { key: 'ArrowLeft' }).prevented);
  assert.deepEqual(app.panels.map(p => p.hidden), [true, true, false]);
  assert.equal(app.focused(), app.tabs[2]);
  app.tabs[2].fire('keydown', { key: 'Home' }); assert.equal(app.focused(), app.tabs[0]);
});
test('ссылка открывает источник, возврат восстанавливает экран ответа и фокус', () => {
  const app = setup();
  assert(app.node('[data-sd-source]').fire('click').prevented);
  assert.deepEqual(app.panels.map(p => p.hidden), [true, true, false]);
  assert.equal(app.focused(), app.node('#sd-source-heading'));
  app.node('[data-sd-back]').fire('click');
  assert.deepEqual(app.panels.map(p => p.hidden), [true, false, true]);
  assert.equal(app.focused(), app.node('#sd-citation'));
});
test('отрасль и поиск работают вместе; нулевой результат показан явно', () => {
  const app = setup();
  app.node('#sd-category').value = 'Финансы'; app.node('#sd-category').fire('change');
  assert.equal(app.files.filter(f => !f.hidden).length, 1);
  app.node('#sd-search').value = 'ОТЧЕТ'; app.node('#sd-search').fire('input');
  assert.equal(app.files.filter(f => !f.hidden).length, 1);
  app.node('#sd-search').value = 'несуществующий файл'; app.node('#sd-search').fire('input');
  assert.equal(app.files.filter(f => !f.hidden).length, 0);
  assert.equal(app.node('#sd-empty').hidden, false);
  assert.equal(app.node('#sd-file-count').textContent, 'Найдено документов: 0');
});
test('папка открывает нужные файлы, вся база возвращает все 12 документов', () => {
  const app = setup();
  app.node('#sd-search').value = 'нет совпадений';
  const folder = app.folders.find(f => f.dataset.sdFolder === 'Проекты');
  folder.fire('click');
  assert.equal(app.node('#sd-search').value, '');
  assert.equal(app.files.filter(f => !f.hidden)[0].dataset.sdFile, 'Регламент запуска проектов.pdf');
  assert(folder.classes.has('is-active'));
  assert.equal(app.panels[0].hidden, false);
  app.folders[0].fire('click');
  assert.equal(app.files.filter(f => !f.hidden).length, 12);
  assert.equal(app.node('#sd-empty').hidden, true);
});

test('встроенный экран сбрасывает прокрутку при смене вкладки и открывает источник с начала', () => {
  const app = setup(landingHtml, landingScript);
  const scroller = app.node('.sd-panels');
  scroller.scrollTop = 640;
  app.tabs[0].fire('click');
  assert.equal(scroller.scrollTop, 0);
  assert.deepEqual(app.panels.map(p => p.hidden), [false, true, true]);
  app.node('#sd-category').value = 'Финансы';
  app.node('#sd-category').fire('change');
  assert.equal(app.files.filter(f => !f.hidden).length, 1);
  scroller.scrollTop = 380;
  app.tabs[1].fire('click');
  assert.equal(scroller.scrollTop, 0);
  assert.deepEqual(app.panels.map(p => p.hidden), [true, false, true]);
  scroller.scrollTop = 900;
  assert(app.node('[data-sd-source]').fire('click').prevented);
  assert.equal(scroller.scrollTop, 0);
  assert.deepEqual(app.panels.map(p => p.hidden), [true, true, false]);
  assert.equal(app.focused(), app.node('#sd-source-heading'));
  app.node('[data-sd-back]').fire('click');
  assert.deepEqual(app.panels.map(p => p.hidden), [true, false, true]);
  assert.equal(app.focused(), app.node('#sd-citation'));
});
