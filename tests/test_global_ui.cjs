const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map();
function fakeClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    toggle(value, force) { if (force) values.add(value); else values.delete(value); },
    contains(value) { return values.has(value); },
  };
}
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, textContent: '', innerHTML: '', value: '', hidden: id === 'global-dashboard', href: '', listeners: [],
      classList: fakeClassList(), attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(event, handler) { this.listeners.push({ event, handler }); },
      focus() { this.focused = true; },
    });
  }
  return elements.get(id);
}
const globalButton = element('global-tab-button');
const marketButton = element('market-kr');
marketButton.dataset = { market: 'kr' };
globalButton.dataset = { dashboardTab: 'global' };
element('main-dashboard').dataset = { dashboardPanel: 'main' };
element('global-dashboard').dataset = { dashboardPanel: 'global' };
element('market-title').textContent = '한국 탑툰챗 카운터';
element('source-link').href = 'https://chat.toptoon.com/ranking';

const document = {
  hidden: false,
  getElementById: element,
  querySelectorAll(selector) {
    if (selector === '[data-dashboard-tab]') return [globalButton];
    if (selector === '[data-dashboard-panel]') return [element('main-dashboard'), element('global-dashboard')];
    if (selector === '[data-market]') return [marketButton];
    return [];
  },
  addEventListener() {},
};
const payload = {
  source: { note: 'Global(EN)은 미국 한정 수치가 아닌 영어권 글로벌 사이트 수치입니다.' },
  captured_kst: '2026-09-17 13:03 KST',
  source_latest_date: '2026-09-17',
  comparison: {
    rows: [
      { name: '한나리', kr_chats: 1000, global_chats: 20, global_pct: 2, jp_chats: 100, jp_pct: 10, tw_chats: 50, tw_pct: 5 },
      { name: '김고은', kr_chats: 700, global_chats: 30, global_pct: 4.2857, jp_chats: 500, jp_pct: 71.4286, tw_chats: null, tw_pct: null },
      { name: '유소희', kr_chats: 300, global_chats: null, global_pct: null, jp_chats: null, jp_pct: null, tw_chats: null, tw_pct: null },
    ],
    overall: {
      overseas_total: 700,
      global_traction_pct: 41.176,
      per_site_pct: { global: 2, jp: 30, tw: 9 },
      per_site: {
        kr: { chats: 1700, views: 57000, char_count: 2, conversion_pct: 2.98 },
        global: { chats: 50, views: 800, char_count: 2, conversion_pct: 6.25 },
        jp: { chats: 600, views: 80000, char_count: 2, conversion_pct: 0.75 },
        tw: { chats: 50, views: 1500, char_count: 1, conversion_pct: 3.333 },
      },
    },
  },
  traction: { daily: [
    { date: '2026-09-16', kr_delta: 10, overseas_delta: 3 },
    { date: '2026-09-17', kr_delta: 12, overseas_delta: 5 },
  ] },
};
let requests = 0;
let timer;
const context = vm.createContext({
  Intl, Date, Map, Set, Math, Number, String, Error, Promise, document,
  window: { addEventListener() {} },
  setInterval: (callback, delay) => { assert.equal(delay, 300000); timer = callback; },
  fetch: async (url, options) => {
    requests += 1;
    assert.equal(url, './data/global-expansion.json');
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => payload };
  },
});
vm.runInContext(fs.readFileSync('dist/global.js', 'utf8'), context);
const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  await settle();
  await settle();
  assert.equal(requests, 1);
  assert.match(element('global-metrics').innerHTML, /1,700/);
  assert.match(element('global-country-bars').innerHTML, /Global\(EN\)/);
  assert.match(element('global-traction-chart').innerHTML, /해외 합계/);
  assert.match(element('global-source-date').textContent, /2026\.9\.17/);
  assert.match(element('global-source-date').textContent, /마지막 데이터 갱신/);
  assert.match(element('global-ranking-body').innerHTML, /한나리/);
  assert.match(element('global-ranking-body').innerHTML, /김고은/);
  assert.match(element('global-ranking-body').innerHTML, /한국 대비 2\.0%/);
  assert.match(element('global-ranking-body').innerHTML, /확인 지역 합계/);
  const unmappedRow = element('global-ranking-body').innerHTML.match(/<tr>\s*<td class="name-cell">유소희<\/td>[\s\S]*?<\/tr>/)[0];
  assert.match(unmappedRow, /<td>—<\/td>/);
  assert.doesNotMatch(unmappedRow, /<td>0/);

  element('global-search').value = '한나';
  element('global-search').listeners.find(({ event }) => event === 'input').handler();
  assert.match(element('global-ranking-body').innerHTML, /한나리/);
  assert.doesNotMatch(element('global-ranking-body').innerHTML, /김고은/);

  globalButton.listeners.find(({ event }) => event === 'click').handler();
  await settle();
  await settle();
  assert.equal(element('main-dashboard').hidden, true);
  assert.equal(element('global-dashboard').hidden, false);
  assert.equal(element('market-title').textContent, '탑툰챗 글로벌 진출');
  assert.equal(element('source-link').hidden, true);
  assert.equal(globalButton.attributes['aria-expanded'], 'true');

  element('global-back').listeners.find(({ event }) => event === 'click').handler();
  assert.equal(element('main-dashboard').hidden, false);
  assert.equal(element('global-dashboard').hidden, true);
  assert.equal(element('market-title').textContent, '한국 탑툰챗 카운터');
  assert.equal(element('source-link').hidden, false);
  assert.equal(globalButton.attributes['aria-expanded'], 'false');
  assert.equal(globalButton.focused, true);
  timer(); await settle(); await settle();
  assert.equal(requests, 3);
  console.log('PASS: global payload, search, global-tab navigation, and scheduled refresh');
})().catch((error) => { console.error(error); process.exitCode = 1; });
