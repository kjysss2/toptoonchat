const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '', listeners: [], classList: { add() {}, remove() {} }, addEventListener(event, handler) { this.listeners.push({event, handler}); } });
  return elements.get(id);
}
const events = {};
let timer, requests = 0, fail = false;
const row = (name, count) => ({ key: name, name, view_count: count, chat_count: count });
const history = { snapshots: [
  { captured_at: '2026-09-08T22:01:00Z', items: [{ name: 'Legacy', rank: 1 }] },
  { captured_at: '2026-09-09T22:01:00Z', captured_kst: '2026-09-10 07:01 KST', items: [row('Alpha', 10), row('Beta', 20)] },
  { captured_at: '2026-09-10T22:02:00Z', captured_kst: '2026-09-11 07:02 KST', items: [row('Alpha', 15), row('Gamma', 17)] }
] };
const document = { hidden: false, getElementById: element, querySelectorAll: () => [], addEventListener: (event, fn) => events[event] = fn };
const storage = new Map();
const dataUrls = ['./data/snapshots.json', './data/snapshots-tw.json', './data/snapshots-us.json', './data/snapshots-jp.json'];
const context = vm.createContext({ Intl, Date, Map, Math, Number, Error, Promise, Set, document, location: { search: '' }, localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, URLSearchParams, window: { addEventListener: (event, fn) => events[event] = fn }, setInterval: (fn, delay) => { assert.equal(delay, 60000); timer = fn; }, fetch: async (url, options) => { requests++; assert.ok(dataUrls.includes(url)); assert.equal(options.cache, 'no-store'); if (fail) throw new Error('offline'); return { ok: true, json: async () => history }; } });
vm.runInContext(fs.readFileSync('dist/app.js', 'utf8'), context);
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  await settle();
  assert.equal(requests, 1);
  assert.equal(element('metric-view-growth').textContent, '+2');
  assert.match(element('absolute-chart').innerHTML, /View 절대값/);
  assert.match(element('absolute-chart').innerHTML, />32</);
  assert.match(element('weekly-chart').innerHTML, /<svg/);
  assert.match(element('monthly-chart').innerHTML, /<svg/);
  const beforeAggregate = requests;
  vm.runInContext("selectMarket('all')", context); await settle();
  assert.equal(requests, beforeAggregate + 4);
  assert.equal(element('market-title').textContent, '탑툰챗 종합 대시보드');
  assert.equal(element('source-link').hidden, true);
  assert.match(element('trend-chart').innerHTML, /stacked-pair/);
  assert.match(element('trend-chart').innerHTML, /한국/);
  assert.match(element('absolute-chart').innerHTML, /View 절대값/);
  assert.match(element('absolute-chart').innerHTML, /한국/);
  assert.match(element('ranking-head').innerHTML, /국가/);
  vm.runInContext("selectMarket('kr')", context); await settle();
  assert.equal(element('source-link').hidden, false);
  vm.runInContext("bars('test-chart', 'negative growth', [{label:'9/10', growth:{view:-700000, chat:10000}}])", context);
  for (const rect of element('test-chart').innerHTML.matchAll(/<rect[^>]+y="([\d.]+)"[^>]+height="([\d.]+)"/g)) {
    assert.ok(Number(rect[1]) >= 18);
    assert.ok(Number(rect[1]) + Number(rect[2]) <= 178.001);
  }
  element('search').value = 'Alpha';
  await vm.runInContext('refreshData()', context);
  assert.equal(element('search').listeners.length, 1);
  assert.match(element('ranking-body').innerHTML, /Alpha/);
  assert.doesNotMatch(element('ranking-body').innerHTML, /Beta/);
  const goodTable = element('ranking-body').innerHTML;
  fail = true;
  await vm.runInContext('refreshData()', context);
  assert.equal(element('ranking-body').innerHTML, goodTable);
  assert.match(element('status').textContent, /기존 데이터 표시 중/);
  fail = false;
  timer(); await settle();
  assert.doesNotMatch(element('status').textContent, /갱신 실패/);
  document.hidden = true;
  const before = requests; timer(); await settle(); assert.equal(requests, before);
  document.hidden = false; events.visibilitychange(); await settle(); assert.equal(requests, before + 1);
  const label = vm.runInContext("statusLabel({captured_at: '2026-09-09T22:01:00Z', captured_kst: '2026-09-10 07:01 KST'}, new Date('2026-09-10T22:10:00Z'))", context);
  assert.match(label, /오늘 수집 대기·지연 중/);
  console.log('PASS: refresh, single search listener, preserved filter, failure recovery, visibility and KST freshness');
})().catch(error => { console.error(error); process.exitCode = 1; });
