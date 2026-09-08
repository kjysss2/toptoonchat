const DATA_URL = "./data/snapshots.json";
const number = new Intl.NumberFormat("ko-KR");
const dateLabel = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });
const asNumber = (value) => Number.isFinite(value) ? value : null;
const fmt = (value) => value === null ? "—" : number.format(value);
const dateOf = (snapshot) => new Date(snapshot.captured_at);
const dayKey = (snapshot) => dateOf(snapshot).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const byKey = (snapshot) => new Map((snapshot?.items || []).map((item) => [item.key, item]));

function totals(snapshot) {
  if (snapshot?.totals && Number.isFinite(snapshot.totals.view_count) && Number.isFinite(snapshot.totals.chat_count)) return snapshot.totals;
  const observed = (snapshot?.items || []).filter((item) => asNumber(item.view_count) !== null && asNumber(item.chat_count) !== null);
  return { view_count: observed.reduce((sum, item) => sum + item.view_count, 0), chat_count: observed.reduce((sum, item) => sum + item.chat_count, 0), observed_items: observed.length };
}

function growth(current, previous) {
  if (!current || !previous) return null;
  const now = totals(current), before = totals(previous);
  if (!now.observed_items || !before.observed_items) return null;
  return { view: now.view_count - before.view_count, chat: now.chat_count - before.chat_count };
}

function dailySnapshots(snapshots) {
  const days = new Map();
  snapshots.forEach((snapshot) => days.set(dayKey(snapshot), snapshot));
  return [...days.values()].sort((a, b) => dateOf(a) - dateOf(b));
}

function periodGrowth(daily, label) {
  const groups = new Map();
  daily.forEach((snapshot) => { const key = label(dateOf(snapshot)); groups.set(key, [...(groups.get(key) || []), snapshot]); });
  return [...groups.entries()].map(([key, values]) => ({ label: key, growth: growth(values.at(-1), values[0]) })).filter((entry) => entry.growth);
}

function bars(rootId, ariaLabel, entries) {
  const root = document.getElementById(rootId);
  if (!entries.length) { root.innerHTML = '<p class="empty-chart">두 번째 수집부터 순증 막대가 표시됩니다.</p>'; return; }
  const max = Math.max(1, ...entries.flatMap((entry) => [Math.abs(entry.growth.view), Math.abs(entry.growth.chat)]));
  const width = 900, height = 224, bottom = 46, left = 14, right = 14, top = 18, base = height - bottom;
  const slot = (width - left - right) / entries.length;
  const y = (value) => base - (value / max) * (height - top - bottom);
  let svg = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}"><line class="grid-line" x1="${left}" y1="${base}" x2="${width - right}" y2="${base}"/>`;
  entries.forEach((entry, i) => {
    const x = left + i * slot, bar = Math.max(3, Math.min(22, slot * .28)), viewY = y(entry.growth.view), chatY = y(entry.growth.chat);
    svg += `<rect class="bar-view" x="${x + slot * .5 - bar - 2}" y="${Math.min(base, viewY)}" width="${bar}" height="${Math.abs(base - viewY)}" rx="2"><title>${entry.label} View ${entry.growth.view >= 0 ? '+' : ''}${fmt(entry.growth.view)}</title></rect>`;
    svg += `<rect class="bar-chat" x="${x + slot * .5 + 2}" y="${Math.min(base, chatY)}" width="${bar}" height="${Math.abs(base - chatY)}" rx="2"><title>${entry.label} Chat ${entry.growth.chat >= 0 ? '+' : ''}${fmt(entry.growth.chat)}</title></rect>`;
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
  document.getElementById("status").textContent = `최종 수집 ${latest.captured_kst || dateLabel.format(dateOf(latest))} · 공개 View·Chat 카운터 기준`;
  document.getElementById("metric-tracked").textContent = `${latest.items.length}개`;
  document.getElementById("metric-view-growth").textContent = today ? `${today.view >= 0 ? "+" : ""}${fmt(today.view)}` : "대기";
  document.getElementById("metric-chat-growth").textContent = today ? `${today.chat >= 0 ? "+" : ""}${fmt(today.chat)}` : "대기";
  document.getElementById("metric-window").textContent = `${daily.length}일`;
  bars("trend-chart", "전체 일별 View와 Chat 순증", dailyBars); bars("weekly-chart", "전체 주별 View와 Chat 순증", weekly); bars("monthly-chart", "전체 월별 View와 Chat 순증", monthly);
  renderTable(latest, previous); document.getElementById("search").addEventListener("input", (event) => renderTable(latest, previous, event.target.value));
}

fetch(DATA_URL, { cache: "no-store" }).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }).then(render).catch((error) => { const status = document.getElementById("status"); status.textContent = `데이터를 불러오지 못했습니다: ${error.message}`; status.classList.add("error"); });
