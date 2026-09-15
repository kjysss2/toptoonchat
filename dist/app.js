const MARKETS = {
  kr: { label: "한국", locale: "ko-KR", dataUrl: "./data/snapshots.json", sourceUrl: "https://chat.toptoon.com/ranking" },
  tw: { label: "대만", locale: "zh-TW", dataUrl: "./data/snapshots-tw.json", sourceUrl: "https://chat.toptoon.net/ranking" },
  us: { label: "미국", locale: "en-US", dataUrl: "./data/snapshots-us.json", sourceUrl: "https://chat.global.toptoon.com/ranking" },
  jp: { label: "일본", locale: "ja-JP", dataUrl: "./data/snapshots-jp.json", sourceUrl: "https://chat.toptoon.jp/ranking" },
};
const MARKET_KEYS = Object.keys(MARKETS);
const DASHBOARDS = { all: { label: "종합", locale: "ko-KR" }, ...MARKETS };
const number = new Intl.NumberFormat("ko-KR");
const dateLabel = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", timeZone: "Asia/Seoul" });
const asNumber = (value) => Number.isFinite(value) ? value : null;
const fmt = (value) => value === null ? "—" : number.format(value);
const dateOf = (snapshot) => new Date(snapshot.captured_at);
const dayKey = (snapshot) => dateOf(snapshot).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const byKey = (snapshot) => new Map((snapshot?.items || []).map((item) => [item.key, item]));
let currentHistory = null;
let activeMarket = new URLSearchParams(location.search).get("market") || localStorage.getItem("toptoonchat-market") || "kr";
if (!DASHBOARDS[activeMarket]) activeMarket = "kr";
let requestSerial = 0;

const marketConfig = () => DASHBOARDS[activeMarket];

function statusLabel(latest, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(({ type, value }) => [type, value]));
  const morning = new Date(`${parts.year}-${parts.month}-${parts.day}T07:00:00+09:00`);
  const pending = now >= morning && dateOf(latest) < morning;
  return `${marketConfig().label} · 최종 수집 ${latest.captured_kst || dateLabel.format(dateOf(latest))} · 매일 07:00 KST 예약${pending ? " · 오늘 수집 대기·지연 중" : ""} · 화면은 1분마다 갱신`;
}

function totals(snapshot) {
  if (snapshot?.totals && Number.isFinite(snapshot.totals.view_count) && Number.isFinite(snapshot.totals.chat_count)) return snapshot.totals;
  const observed = (snapshot?.items || []).filter((item) => asNumber(item.view_count) !== null && asNumber(item.chat_count) !== null);
  return { view_count: observed.reduce((sum, item) => sum + item.view_count, 0), chat_count: observed.reduce((sum, item) => sum + item.chat_count, 0), observed_items: observed.length };
}

function growth(current, previous) {
  if (!current || !previous) return null;
  const currentTotals = totals(current), previousTotals = totals(previous);
  if (!currentTotals.observed_items || !previousTotals.observed_items) return null;
  return {
    view: currentTotals.view_count - previousTotals.view_count,
    chat: currentTotals.chat_count - previousTotals.chat_count,
  };
}

function dailySnapshots(snapshots) {
  const days = new Map();
  snapshots.forEach((snapshot) => days.set(dayKey(snapshot), snapshot));
  return [...days.values()].sort((a, b) => dateOf(a) - dateOf(b));
}

function periodGrowth(daily, label) {
  const groups = new Map();
  daily.filter((snapshot) => totals(snapshot).observed_items > 0).forEach((snapshot) => {
    const period = label(dateOf(snapshot));
    const descriptor = typeof period === "string" ? { key: period, label: period } : period;
    const group = groups.get(descriptor.key) || { ...descriptor, values: [] };
    group.values.push(snapshot);
    groups.set(descriptor.key, group);
  });
  return [...groups.values()].filter(({ values }) => values.length > 1).map(({ key, label: periodLabel, values }) => ({ key, label: periodLabel, growth: growth(values.at(-1), values[0]) })).filter((entry) => entry.growth);
}

function weekPeriod(date) {
  const key = date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const [year, month, day] = key.split("-").map(Number);
  const monday = new Date(Date.UTC(year, month - 1, day));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return { key: monday.toISOString().slice(0, 10), label: `${monday.getUTCMonth() + 1}/${monday.getUTCDate()}주` };
}

function monthPeriod(date) {
  const key = date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(0, 7);
  return { key, label: key.replace("-", ".") };
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
    const valueLabel = (value, barY, labelX, className) => { const yPos = value >= 0 ? Math.max(12, Math.min(base, barY) - 6) : Math.min(height - bottom - 2, Math.max(base, barY) + 14); return `<text class="value-label ${className}" text-anchor="middle" x="${labelX}" y="${yPos}" font-size="11" font-weight="700" fill="#ffffff">${value >= 0 ? '+' : ''}${fmt(value)}</text>`; };
    svg += valueLabel(entry.growth.view, viewY, x + slot * .5 - bar / 2 - 2, 'view-label');
    svg += valueLabel(entry.growth.chat, chatY, x + slot * .5 + bar / 2 + 2, 'chat-label');
    if (entries.length <= 10 || i === 0 || i === entries.length - 1 || i === Math.floor(entries.length / 2)) svg += `<text class="axis-label" text-anchor="middle" x="${x + slot / 2}" y="${height - 12}">${entry.label}</text>`;
  });
  root.innerHTML = `${svg}</svg><div class="chart-legend"><span><i class="legend-view"></i>View 순증</span><span><i class="legend-chat"></i>Chat 순증</span></div>`;
}

function aggregateSeries(histories, period) {
  const merged = new Map();
  MARKET_KEYS.forEach((market) => {
    const daily = dailySnapshots(histories[market]?.snapshots || []);
    const entries = period === "daily"
      ? daily.slice(1).map((snapshot, index) => ({ key: dayKey(snapshot), label: dateLabel.format(dateOf(snapshot)), growth: growth(snapshot, daily[index]) })).filter((entry) => entry.growth)
      : periodGrowth(daily, period === "weekly" ? weekPeriod : monthPeriod);
    entries.forEach((entry) => {
      const combined = merged.get(entry.key) || { key: entry.key, label: entry.label, countries: {} };
      combined.countries[market] = entry.growth;
      merged.set(entry.key, combined);
    });
  });
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function aggregateAbsoluteSeries(histories) {
  const merged = new Map();
  MARKET_KEYS.forEach((market) => {
    dailySnapshots(histories[market]?.snapshots || []).forEach((snapshot) => {
      const summary = totals(snapshot);
      if (!summary.observed_items) return;
      const key = dayKey(snapshot);
      const combined = merged.get(key) || { key, label: dateLabel.format(dateOf(snapshot)), countries: {} };
      combined.countries[market] = { view: summary.view_count, chat: summary.chat_count };
      merged.set(key, combined);
    });
  });
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function stackedMetric(entries, metric, title, signed = true) {
  const width = 600, height = 300, left = 18, right = 18, top = 24, bottom = 48;
  const positiveMax = Math.max(0, ...entries.map((entry) => MARKET_KEYS.reduce((sum, market) => sum + Math.max(0, entry.countries[market]?.[metric] || 0), 0)));
  const negativeMin = Math.min(0, ...entries.map((entry) => MARKET_KEYS.reduce((sum, market) => sum + Math.min(0, entry.countries[market]?.[metric] || 0), 0)));
  const range = positiveMax - negativeMin || 1;
  const y = (value) => top + ((positiveMax - value) / range) * (height - top - bottom);
  const base = y(0), slot = (width - left - right) / entries.length, barWidth = Math.max(10, Math.min(54, slot * .58));
  let svg = `<p class="stacked-metric-title">${title}</p><svg class="chart-svg stacked-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title} 국가별 누적 막대그래프"><line class="grid-line" x1="${left}" y1="${base}" x2="${width - right}" y2="${base}"/>`;
  entries.forEach((entry, index) => {
    const x = left + index * slot + (slot - barWidth) / 2;
    let positive = 0, negative = 0;
    MARKET_KEYS.forEach((market) => {
      const value = entry.countries[market]?.[metric];
      if (!Number.isFinite(value) || value === 0) return;
      const start = value > 0 ? positive : negative;
      const end = start + value;
      const rectY = value > 0 ? y(end) : y(start);
      const rectHeight = Math.abs(y(start) - y(end));
      svg += `<rect class="stack-segment country-${market}" x="${x}" y="${rectY}" width="${barWidth}" height="${rectHeight}"><title>${entry.label} ${MARKETS[market].label} ${signed && value >= 0 ? "+" : ""}${fmt(value)}</title></rect>`;
      if (value > 0) positive = end; else negative = end;
    });
    const total = positive + negative;
    const labelY = total >= 0 ? Math.max(12, y(positive) - 6) : Math.min(height - bottom + 15, y(negative) + 14);
    svg += `<text class="value-label" text-anchor="middle" x="${x + barWidth / 2}" y="${labelY}" font-size="11" font-weight="700" fill="#ffffff">${signed && total >= 0 ? "+" : ""}${fmt(total)}</text>`;
    if (entries.length <= 10 || index === 0 || index === entries.length - 1 || index === Math.floor(entries.length / 2)) svg += `<text class="axis-label" text-anchor="middle" x="${x + barWidth / 2}" y="${height - 12}">${entry.label}</text>`;
  });
  return `${svg}</svg>`;
}

function stackedBars(rootId, entries) {
  const root = document.getElementById(rootId);
  if (!entries.length) { root.innerHTML = '<p class="empty-chart">각 국가에 비교 가능한 두 날짜의 카운터가 쌓이면 표시됩니다.</p>'; return; }
  const legend = MARKET_KEYS.map((market) => `<span><i class="country-${market}"></i>${MARKETS[market].label}</span>`).join("");
  root.innerHTML = `<div class="stacked-pair"><div class="stacked-chart">${stackedMetric(entries, "view", "View 순증")}</div><div class="stacked-chart">${stackedMetric(entries, "chat", "Chat 순증")}</div></div><div class="chart-legend country-legend">${legend}</div>`;
}

function stackedAbsoluteBars(rootId, entries) {
  const root = document.getElementById(rootId);
  if (!entries.length) { root.innerHTML = '<p class="empty-chart">아직 저장된 절대값 스냅샷이 없습니다.</p>'; return; }
  const legend = MARKET_KEYS.map((market) => `<span><i class="country-${market}"></i>${MARKETS[market].label}</span>`).join("");
  root.innerHTML = `<div class="stacked-pair"><div class="stacked-chart">${stackedMetric(entries, "view", "View 절대값", false)}</div><div class="stacked-chart">${stackedMetric(entries, "chat", "Chat 절대값", false)}</div></div><div class="chart-legend country-legend">${legend}</div>`;
}

function absoluteMetric(entries, metric, title, className) {
  const width = 600, height = 300, left = 18, right = 18, top = 24, bottom = 48;
  const max = Math.max(1, ...entries.map((entry) => entry[metric]));
  const y = (value) => top + ((max - value) / max) * (height - top - bottom);
  const base = height - bottom, slot = (width - left - right) / entries.length, barWidth = Math.max(8, Math.min(54, slot * .58));
  let svg = `<p class="stacked-metric-title">${title}</p><svg class="chart-svg stacked-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title} 일별 막대그래프"><line class="grid-line" x1="${left}" y1="${base}" x2="${width - right}" y2="${base}"/>`;
  entries.forEach((entry, index) => {
    const x = left + index * slot + (slot - barWidth) / 2, barY = y(entry[metric]);
    svg += `<rect class="${className}" x="${x}" y="${barY}" width="${barWidth}" height="${base - barY}" rx="2"><title>${entry.label} ${title} ${fmt(entry[metric])}</title></rect>`;
    svg += `<text class="value-label" text-anchor="middle" x="${x + barWidth / 2}" y="${Math.max(12, barY - 6)}" font-size="11" font-weight="700" fill="#ffffff">${fmt(entry[metric])}</text>`;
    if (entries.length <= 10 || index === 0 || index === entries.length - 1 || index === Math.floor(entries.length / 2)) svg += `<text class="axis-label" text-anchor="middle" x="${x + barWidth / 2}" y="${height - 12}">${entry.label}</text>`;
  });
  return `${svg}</svg>`;
}

function absoluteBars(rootId, daily) {
  const root = document.getElementById(rootId);
  const entries = daily.map((snapshot) => {
    const summary = totals(snapshot);
    return { label: dateLabel.format(dateOf(snapshot)), view: summary.view_count, chat: summary.chat_count, observed: summary.observed_items };
  }).filter((entry) => entry.observed).slice(-30);
  if (!entries.length) { root.innerHTML = '<p class="empty-chart">아직 저장된 절대값 스냅샷이 없습니다.</p>'; return; }
  root.innerHTML = `<div class="stacked-pair"><div class="stacked-chart">${absoluteMetric(entries, "view", "View 절대값", "bar-view")}</div><div class="stacked-chart">${absoluteMetric(entries, "chat", "Chat 절대값", "bar-chat")}</div></div>`;
}

function renderTable(latest, previous, query = "") {
  const priorRows = byKey(previous), root = document.getElementById("ranking-body"), keyword = query.trim().toLocaleLowerCase(marketConfig().locale);
  const delta = (value) => value === null ? "—" : `<span class="delta ${value < 0 ? "negative" : ""}">${value >= 0 ? "+" : ""}${fmt(value)}</span>`;
  root.innerHTML = (latest.items || []).filter((item) => item.name.toLocaleLowerCase(marketConfig().locale).includes(keyword)).map((item) => {
    const prior = priorRows.get(item.key);
    const view = prior && asNumber(item.view_count) !== null && asNumber(prior.view_count) !== null ? item.view_count - prior.view_count : null;
    const chat = prior && asNumber(item.chat_count) !== null && asNumber(prior.chat_count) !== null ? item.chat_count - prior.chat_count : null;
    return `<tr><td>${item.rank ?? "—"}</td><td class="name-cell">${item.name}</td><td>${fmt(asNumber(item.view_count))}</td><td>${fmt(asNumber(item.chat_count))}</td><td>${delta(view)}</td><td>${delta(chat)}</td></tr>`;
  }).join("") || '<tr><td colspan="6" class="empty-chart">검색 결과가 없습니다.</td></tr>';
}

function setDashboardLabels(aggregate) {
  document.getElementById("trend-title").textContent = aggregate ? "국가별 누적 일별 순증" : "전체 View · Chat 일별 순증";
  document.getElementById("absolute-title").textContent = aggregate ? "국가별 누적 일별 절대값" : "전체 View · Chat 일별 절대값";
  document.getElementById("weekly-title").textContent = aggregate ? "국가별 누적 주별 순증" : "주별 순증";
  document.getElementById("monthly-title").textContent = aggregate ? "국가별 누적 월별 순증" : "월별 순증";
  document.getElementById("table-title").textContent = aggregate ? "국가별 최신 현황" : "작품별 공개 카운터";
  document.getElementById("table-tools").hidden = aggregate;
  document.getElementById("ranking-head").innerHTML = aggregate
    ? "<th>국가</th><th>추적 작품</th><th>누적 View</th><th>누적 Chat</th><th>최근 View 순증</th><th>최근 Chat 순증</th>"
    : "<th>순위</th><th>작품</th><th>View</th><th>Chat</th><th>View 증감</th><th>Chat 증감</th>";
}

function renderAggregate(histories, failures = []) {
  const available = MARKET_KEYS.filter((market) => histories[market]);
  if (!available.length) throw new Error("수집된 국가 데이터를 불러오지 못했습니다.");
  const latestByMarket = Object.fromEntries(available.map((market) => [market, dailySnapshots(histories[market].snapshots || []).at(-1)]).filter(([, latest]) => latest?.items?.length));
  const comparable = {};
  available.forEach((market) => {
    const daily = dailySnapshots(histories[market].snapshots || []);
    const latestGrowth = growth(daily.at(-1), daily.at(-2));
    if (latestGrowth) comparable[market] = latestGrowth;
  });
  const growths = Object.values(comparable);
  const totalViewGrowth = growths.reduce((sum, item) => sum + item.view, 0);
  const totalChatGrowth = growths.reduce((sum, item) => sum + item.chat, 0);
  const allDays = new Set(available.flatMap((market) => dailySnapshots(histories[market].snapshots || []).map(dayKey)));
  const latestCapture = Object.values(latestByMarket).sort((a, b) => dateOf(a) - dateOf(b)).at(-1);
  const tracked = Object.values(latestByMarket).reduce((sum, latest) => sum + latest.items.length, 0);
  document.getElementById("status").textContent = `4개 국가 종합 · 최종 수집 ${latestCapture?.captured_kst || "—"} · 순증 비교 가능 ${growths.length}/4개 국가${failures.length ? ` · ${failures.length}개 국가 갱신 실패` : ""} · 화면은 1분마다 갱신`;
  if (failures.length) document.getElementById("status").classList.add("error"); else document.getElementById("status").classList.remove("error");
  document.querySelectorAll(".comparison-time").forEach((element) => { element.textContent = `비교 가능한 ${growths.length}개 국가 합계`; });
  document.getElementById("metric-tracked").textContent = `${tracked}개`;
  document.getElementById("metric-view-growth").textContent = growths.length ? `${totalViewGrowth >= 0 ? "+" : ""}${fmt(totalViewGrowth)}` : "대기";
  document.getElementById("metric-chat-growth").textContent = growths.length ? `${totalChatGrowth >= 0 ? "+" : ""}${fmt(totalChatGrowth)}` : "대기";
  document.getElementById("metric-window").textContent = `${allDays.size}일`;
  setDashboardLabels(true);
  stackedBars("trend-chart", aggregateSeries(histories, "daily").slice(-30));
  stackedAbsoluteBars("absolute-chart", aggregateAbsoluteSeries(histories).slice(-30));
  stackedBars("weekly-chart", aggregateSeries(histories, "weekly"));
  stackedBars("monthly-chart", aggregateSeries(histories, "monthly"));
  document.getElementById("ranking-body").innerHTML = MARKET_KEYS.map((market) => {
    const latest = latestByMarket[market];
    if (!latest) return `<tr><td><span class="country-name"><i class="country-dot country-${market}"></i>${MARKETS[market].label}</span></td><td colspan="5">데이터를 불러오지 못했습니다.</td></tr>`;
    const recent = comparable[market];
    const summary = totals(latest);
    const delta = (value) => Number.isFinite(value) ? `<span class="delta ${value < 0 ? "negative" : ""}">${value >= 0 ? "+" : ""}${fmt(value)}</span>` : "—";
    return `<tr><td><span class="country-name"><i class="country-dot country-${market}"></i>${MARKETS[market].label}</span></td><td>${latest.items.length}개</td><td>${fmt(summary.view_count)}</td><td>${fmt(summary.chat_count)}</td><td>${delta(recent?.view)}</td><td>${delta(recent?.chat)}</td></tr>`;
  }).join("");
}

function render(history) {
  const daily = dailySnapshots(history.snapshots || []), latest = daily.at(-1), previous = daily.at(-2), today = growth(latest, previous);
  if (!latest?.items?.length) throw new Error("아직 저장된 작품 스냅샷이 없습니다.");
  const tail = daily.slice(-30);
  const dailyBars = tail.map((snapshot, i) => ({ label: dateLabel.format(dateOf(snapshot)), growth: i ? growth(snapshot, tail[i - 1]) : null })).filter((entry) => entry.growth);
  const weekly = periodGrowth(daily, weekPeriod);
  const monthly = periodGrowth(daily, monthPeriod);
  document.getElementById("status").textContent = statusLabel(latest);
  document.getElementById("status").classList.remove("error");
  document.querySelectorAll(".comparison-time").forEach((element) => { element.textContent = previous ? `${previous.captured_kst || dateLabel.format(dateOf(previous))} 대비` : "비교할 이전 수집 대기"; });
  document.getElementById("metric-tracked").textContent = `${latest.items.length}개`;
  document.getElementById("metric-view-growth").textContent = today ? `${today.view >= 0 ? "+" : ""}${fmt(today.view)}` : "대기";
  document.getElementById("metric-chat-growth").textContent = today ? `${today.chat >= 0 ? "+" : ""}${fmt(today.chat)}` : "대기";
  document.getElementById("metric-window").textContent = `${daily.length}일`;
  setDashboardLabels(false);
  absoluteBars("absolute-chart", daily);
  bars("trend-chart", "전체 일별 View와 Chat 순증", dailyBars); bars("weekly-chart", "전체 주별 View와 Chat 순증", weekly); bars("monthly-chart", "전체 월별 View와 Chat 순증", monthly);
  renderTable(latest, previous, document.getElementById("search").value);
}

async function refreshData() {
  const market = activeMarket;
  const serial = ++requestSerial;
  try {
    if (market === "all") {
      const results = await Promise.allSettled(MARKET_KEYS.map(async (key) => {
        const response = await fetch(MARKETS[key].dataUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`${MARKETS[key].label} HTTP ${response.status}`);
        return [key, await response.json()];
      }));
      if (market !== activeMarket || serial !== requestSerial) return;
      const histories = {}, failures = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") histories[result.value[0]] = result.value[1];
        else failures.push(MARKET_KEYS[index]);
      });
      renderAggregate(histories, failures);
      currentHistory = histories;
      return;
    }
    const response = await fetch(MARKETS[market].dataUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const history = await response.json();
    if (market !== activeMarket || serial !== requestSerial) return;
    render(history);
    currentHistory = history;
  } catch (error) {
    if (market !== activeMarket || serial !== requestSerial) return;
    const status = document.getElementById("status");
    const latest = market !== "all" && currentHistory && dailySnapshots(currentHistory.snapshots || []).at(-1);
    status.textContent = `${latest ? `${statusLabel(latest)} · 기존 데이터 표시 중. ` : ""}데이터 갱신 실패: ${error.message} · 잠시 후 자동 재시도`;
    status.classList.add("error");
  }
}

function selectMarket(market) {
  if (!DASHBOARDS[market]) return;
  activeMarket = market;
  currentHistory = null;
  localStorage.setItem("toptoonchat-market", market);
  const config = marketConfig();
  document.getElementById("market-title").textContent = market === "all" ? "탑툰챗 종합 대시보드" : `${config.label} 탑툰챗 카운터`;
  document.getElementById("source-link").hidden = market === "all";
  if (market !== "all") document.getElementById("source-link").href = config.sourceUrl;
  document.querySelectorAll("[data-market]").forEach((button) => {
    const selected = button.dataset.market === market;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  document.getElementById("status").textContent = `${config.label} 데이터를 불러오는 중…`;
  refreshData();
}

document.getElementById("search").addEventListener("input", (event) => {
  if (!currentHistory || activeMarket === "all") return;
  const daily = dailySnapshots(currentHistory.snapshots || []);
  renderTable(daily.at(-1), daily.at(-2), event.target.value);
});
document.querySelectorAll("[data-market]").forEach((button) => button.addEventListener("click", () => selectMarket(button.dataset.market)));
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshData(); });
window.addEventListener("focus", refreshData);
setInterval(() => { if (!document.hidden) refreshData(); }, 60_000);
selectMarket(activeMarket);
