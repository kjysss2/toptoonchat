const DATA_URL = "./data/snapshots.json";
const number = new Intl.NumberFormat("ko-KR");
const dateLabel = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", timeZone: "Asia/Seoul" });
const asNumber = (value) => Number.isFinite(value) ? value : null;
const fmt = (value) => value === null ? "—" : number.format(value);
const dateOf = (snapshot) => new Date(snapshot.captured_at);
const dayKey = (snapshot) => dateOf(snapshot).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const byKey = (snapshot) => new Map((snapshot?.items || []).map((item) => [item.key, item]));
let currentHistory = null;
let refreshing = false;

function statusLabel(latest, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(({ type, value }) => [type, value]));
  const morning = new Date(`${parts.year}-${parts.month}-${parts.day}T07:00:00+09:00`);
  const pending = now >= morning && dateOf(latest) < morning;
  return `최종 수집 ${latest.captured_kst || dateLabel.format(dateOf(latest))} · 매일 07:00 KST 예약${pending ? " · 오늘 수집 대기·지연 중" : ""} · 화면은 1분마다 갱신`;
}

function totals(snapshot) {
  if (snapshot?.totals && Number.isFinite(snapshot.totals.view_count) && Number.isFinite(snapshot.totals.chat_count)) return snapshot.totals;
  const observed = (snapshot?.items || []).filter((item) => asNumber(item.view_count) !== null && asNumber(item.chat_count) !== null);
  return { view_count: observed.reduce((sum, item) => sum + item.view_count, 0), chat_count: observed.reduce((sum, item) => sum + item.chat_count, 0), observed_items: observed.length };
}

function growth(current, previous) {
  if (!current || !previous) return null;
  const beforeByKey = new Map((previous.items || []).filter((item) => asNumber(item.view_count) !== null && asNumber(item.chat_count) !== null).map((item) => [item.key, item]));
  const common = (current.items || []).filter((item) => beforeByKey.has(item.key) && asNumber(item.view_count) !== null && asNumber(item.chat_count) !== null);
  if (!common.length) return null;
  return {
    view: common.reduce((sum, item) => sum + item.view_count - beforeByKey.get(item.key).view_count, 0),
    chat: common.reduce((sum, item) => sum + item.chat_count - beforeByKey.get(item.key).chat_count, 0),
  };
}

function dailySnapshots(snapshots) {
  const days = new Map();
  snapshots.forEach((snapshot) => days.set(dayKey(snapshot), snapshot));
  return [...days.values()].sort((a, b) => dateOf(a) - dateOf(b));
}

function periodGrowth(daily, label) {
  const groups = new Map();
  daily.filter((snapshot) => totals(snapshot).observed_items > 0).forEach((snapshot) => { const key = label(dateOf(snapshot)); groups.set(key, [...(groups.get(key) || []), snapshot]); });
  return [...groups.entries()].filter(([, values]) => values.length > 1).map(([key, values]) => ({ label: key, growth: growth(values.at(-1), values[0]) })).filter((entry) => entry.growth);
}

function bars(rootId, ariaLabel, entries) {
  const root = document.getElementById(rootId);
  if (!entries.length) { root.innerHTML = '<p class="empty-chart">View·Chat 카운터가 서로 다른 날짜에 두 번 이상 수집되면 표시됩니다.</p>'; return; }
  const values = entries.flatMap((entry) => [entry.growth.view, entry.growth.chat]);
  const min = Math.min(0, ...values), max = Math.max(0, ...values), range = max - min || 1;
  const width = 900, height = 224, bottom = 46, left = 14, right = 14, top = 18;
  const slot = (width - left - right) / entries.length;
  const y = (value) => top + ((max - value) / range) * (height - top - bottom);
  const base = y(0);
  let svg = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}"><line class="grid-line" x1="${left}" y1="${base}" x2="${width - right}" y2="${base}"/>`;
  entries.forEach((entry, i) => {
    const x = left + i * slot, bar = Math.max(3, Math.min(22, slot * .28)), viewY = y(entry.growth.view), chatY = y(entry.growth.chat);
    svg += `<rect class="bar-view" x="${x + slot * .5 - bar - 2}" y="${Math.min(base, viewY)}" width="${bar}" height="${Math.abs(base - viewY)}" rx="2"><title>${entry.label} View ${entry.growth.view >= 0 ? '+' : ''}${fmt(entry.growth.view)}</title></rect>`;
    svg += `<rect class="bar-chat" x="${x + slot * .5 + 2}" y="${Math.min(base, chatY)}" width="${bar}" height="${Math.abs(base - chatY)}" rx="2"><title>${entry.label} Chat ${entry.growth.chat >= 0 ? '+' : ''}${fmt(entry.growth.chat)}</title></rect>`;
    const valueLabel = (value, barY, labelX, className) => { const yPos = value >= 0 ? Math.max(12, Math.min(base, barY) - 6) : Math.min(height - bottom - 2, Math.max(base, barY) + 14); return `<text class="value-label ${className}" text-anchor="middle" x="${labelX}" y="${yPos}" font-size="11" font-weight="700">${value >= 0 ? '+' : ''}${fmt(value)}</text>`; };
    svg += valueLabel(entry.growth.view, viewY, x + slot * .5 - bar / 2 - 2, 'view-label');
    svg += valueLabel(entry.growth.chat, chatY, x + slot * .5 + bar / 2 + 2, 'chat-label');
    if (entries.length <= 10 || i === 0 || i === entries.length - 1 || i === Math.floor(entries.length / 2)) svg += `<text class="axis-label" text-anchor="middle" x="${x + slot / 2}" y="${height - 12}">${entry.label}</text>`;
  });
  root.innerHTML = `${svg}</svg><div class="chart-legend"><span><i class="legend-view"></i>View 순증</span><span><i class="legend-chat"></i>Chat 순증</span></div>`;
}

function renderTable(latest, previous, query = "") {
  const priorRows = byKey(previous), root = document.getElementById("ranking-body"), keyword = query.trim().toLocaleLowerCase("ko-KR");
  const delta = (value) => value === null ? "—" : `<span class="delta ${value < 0 ? "negative" : ""}">${value >= 0 ? "+" : ""}${fmt(value)}</span>`;
  root.innerHTML = (latest.items || []).filter((item) => item.name.toLocaleLowerCase("ko-KR").includes(keyword)).map((item) => {
    const prior = priorRows.get(item.key);
    const view = prior && asNumber(item.view_count) !== null && asNumber(prior.view_count) !== null ? item.view_count - prior.view_count : null;
    const chat = prior && asNumber(item.chat_count) !== null && asNumber(prior.chat_count) !== null ? item.chat_count - prior.chat_count : null;
    return `<tr><td>${item.rank ?? "—"}</td><td class="name-cell">${item.name}</td><td>${fmt(asNumber(item.view_count))}</td><td>${fmt(asNumber(item.chat_count))}</td><td>${delta(view)}</td><td>${delta(chat)}</td></tr>`;
  }).join("") || '<tr><td colspan="6" class="empty-chart">검색 결과가 없습니다.</td></tr>';
}

function render(history) {
  const daily = dailySnapshots(history.snapshots || []), latest = daily.at(-1), previous = daily.at(-2), today = growth(latest, previous);
  if (!latest?.items?.length) throw new Error("아직 저장된 작품 스냅샷이 없습니다.");
  const tail = daily.slice(-30);
  const dailyBars = tail.map((snapshot, i) => ({ label: dateLabel.format(dateOf(snapshot)), growth: i ? growth(snapshot, tail[i - 1]) : null })).filter((entry) => entry.growth);
  const weekly = periodGrowth(daily, (date) => { const monday = new Date(date); monday.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return `${monday.getMonth() + 1}/${monday.getDate()}주`; });
  const monthly = periodGrowth(daily, (date) => `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}`);
  document.getElementById("status").textContent = statusLabel(latest);
  document.getElementById("status").classList.remove("error");
  document.querySelectorAll(".comparison-time").forEach((element) => { element.textContent = previous ? `${previous.captured_kst || dateLabel.format(dateOf(previous))} 대비` : "비교할 이전 수집 대기"; });
  document.getElementById("metric-tracked").textContent = `${latest.items.length}개`;
  document.getElementById("metric-view-growth").textContent = today ? `${today.view >= 0 ? "+" : ""}${fmt(today.view)}` : "대기";
  document.getElementById("metric-chat-growth").textContent = today ? `${today.chat >= 0 ? "+" : ""}${fmt(today.chat)}` : "대기";
  document.getElementById("metric-window").textContent = `${daily.length}일`;
  bars("trend-chart", "전체 일별 View와 Chat 순증", dailyBars); bars("weekly-chart", "전체 주별 View와 Chat 순증", weekly); bars("monthly-chart", "전체 월별 View와 Chat 순증", monthly);
  renderTable(latest, previous, document.getElementById("search").value);
}

async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const history = await response.json();
    render(history);
    currentHistory = history;
  } catch (error) {
    const status = document.getElementById("status");
    const latest = currentHistory && dailySnapshots(currentHistory.snapshots || []).at(-1);
    status.textContent = `${latest ? `${statusLabel(latest)} · 기존 데이터 표시 중. ` : ""}데이터 갱신 실패: ${error.message} · 잠시 후 자동 재시도`;
    status.classList.add("error");
  } finally {
    refreshing = false;
  }
}

document.getElementById("search").addEventListener("input", (event) => {
  if (!currentHistory) return;
  const daily = dailySnapshots(currentHistory.snapshots || []);
  renderTable(daily.at(-1), daily.at(-2), event.target.value);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshData(); });
window.addEventListener("focus", refreshData);
setInterval(() => { if (!document.hidden) refreshData(); }, 60_000);
refreshData();
