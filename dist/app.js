const DATA_URL = "./data/snapshots.json";
const DAY_MS = 24 * 60 * 60 * 1000;

const formatDate = (value) => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
};

const snapshotBefore = (snapshots, latest, days) => {
  const target = new Date(latest.captured_at).getTime() - days * DAY_MS;
  return [...snapshots].reverse().find((snapshot) => new Date(snapshot.captured_at).getTime() <= target) || null;
};

const byKey = (snapshot) => new Map((snapshot?.items || []).map((item) => [item.key, item]));

const movement = (current, previous) => {
  if (!previous) return null;
  return previous.rank - current.rank;
};

const movementMarkup = (change) => {
  if (change === null) return '<span class="move flat">기준 없음</span>';
  if (change > 0) return `<span class="move up">▲ ${change}</span>`;
  if (change < 0) return `<span class="move down">▼ ${Math.abs(change)}</span>`;
  return '<span class="move flat">—</span>';
};

function setMetric(id, value) {
  document.getElementById(id).textContent = value;
}

function renderTrendChart(snapshots, latest) {
  const root = document.getElementById("trend-chart");
  const caption = document.getElementById("trend-caption");
  const cutoff = new Date(latest.captured_at).getTime() - 29 * DAY_MS;
  const period = snapshots.filter((snapshot) => new Date(snapshot.captured_at).getTime() >= cutoff);
  const active = period.length ? period : [latest];
  const latestTop = latest.items.slice(0, 4);
  caption.textContent = `${active.length}개 스냅샷 · 최근 30일`;

  if (active.length < 2) {
    root.innerHTML = '<p class="empty-chart">두 번째 일별 스냅샷부터 순위 흐름이 그려집니다.</p>';
    return;
  }

  const width = 900;
  const height = 224;
  const pad = { top: 18, right: 20, bottom: 33, left: 36 };
  const ranks = active.flatMap((snapshot) => snapshot.items.map((item) => item.rank));
  const maxRank = Math.max(10, ...ranks, ...latestTop.map((item) => item.rank));
  const x = (index) => pad.left + (index * (width - pad.left - pad.right)) / Math.max(1, active.length - 1);
  const y = (rank) => pad.top + ((rank - 1) * (height - pad.top - pad.bottom)) / Math.max(1, maxRank - 1);
  const colors = ["#4ee2c1", "#61a7ff", "#ffc66d", "#d98cff"];
  const grid = [1, Math.ceil(maxRank / 2), maxRank];

  let svg = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="상위 캐릭터 최근 순위 흐름">`;
  grid.forEach((rank) => {
    svg += `<line class="grid-line" x1="${pad.left}" y1="${y(rank)}" x2="${width - pad.right}" y2="${y(rank)}"/>`;
    svg += `<text class="axis-label" x="0" y="${y(rank) + 4}">${rank}위</text>`;
  });
  active.forEach((snapshot, index) => {
    if (index === 0 || index === active.length - 1 || index === Math.floor(active.length / 2)) {
      svg += `<text class="axis-label" text-anchor="middle" x="${x(index)}" y="${height - 8}">${formatDate(snapshot.captured_at).replace(" ", "")}</text>`;
    }
  });

  latestTop.forEach((item, seriesIndex) => {
    const points = active.map((snapshot, index) => {
      const observed = byKey(snapshot).get(item.key);
      return observed ? `${x(index)},${y(observed.rank)}` : null;
    }).filter(Boolean);
    if (points.length > 1) svg += `<polyline class="chart-line" stroke="${colors[seriesIndex]}" points="${points.join(" ")}"/>`;
    const newest = byKey(active.at(-1)).get(item.key);
    if (newest) svg += `<circle class="chart-dot" fill="${colors[seriesIndex]}" cx="${x(active.length - 1)}" cy="${y(newest.rank)}" r="4"/>`;
  });
  svg += "</svg>";
  const legend = latestTop.map((item, index) => `<span><i style="background:${colors[index]}"></i>${item.name}</span>`).join("");
  root.innerHTML = `${svg}<div class="chart-legend">${legend}</div>`;
}

function renderMovers(latest, previous) {
  const root = document.getElementById("movers-list");
  const baseline = byKey(previous);
  const movers = latest.items
    .map((item) => ({ item, change: movement(item, baseline.get(item.key)) }))
    .filter(({ change }) => change !== null)
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);
  if (!movers.length) {
    root.innerHTML = '<li class="empty-list">7일 비교 데이터가 쌓이면 상승 캐릭터를 표시합니다.</li>';
    return;
  }
  root.innerHTML = movers.map(({ item, change }) => `
    <li>
      <span class="rank-badge">${item.rank}위</span>
      <div><div class="mover-name">${item.name}</div><div class="mover-meta">7일 전 ${item.rank + change}위</div></div>
      ${movementMarkup(change)}
    </li>`).join("");
}

function renderTable(latest, previous, query = "") {
  const root = document.getElementById("ranking-body");
  const baseline = byKey(previous);
  const lowered = query.trim().toLocaleLowerCase("ko-KR");
  const rows = latest.items.filter((item) => item.name.toLocaleLowerCase("ko-KR").includes(lowered));
  root.innerHTML = rows.map((item) => {
    const prior = baseline.get(item.key);
    const isNew = !prior || item.is_new || item.has_new_start || item.badges.includes("NEW");
    const signal = isNew ? '<span class="signal">NEW</span>' : '<span class="signal neutral">추적 중</span>';
    const kind = item.kind === "content" ? '<span class="type-tag">멀티</span>' : "";
    const score = item.score ?? "—";
    return `<tr>
      <td>${item.rank}</td>
      <td class="name-cell">${item.name}${kind}</td>
      <td>${score}</td>
      <td>${movementMarkup(movement(item, prior))}</td>
      <td>${signal}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="5" class="empty-chart">검색 결과가 없습니다.</td></tr>';
}

function renderDashboard(history) {
  const snapshots = history.snapshots || [];
  const latest = snapshots.at(-1);
  if (!latest?.items?.length) throw new Error("아직 저장된 랭킹 스냅샷이 없습니다.");
  const previous7 = snapshotBefore(snapshots, latest, 7);
  const initialTop10 = new Set((previous7?.items || []).slice(0, 10).map((item) => item.key));
  const latestTop10 = new Set(latest.items.slice(0, 10).map((item) => item.key));
  const incoming7d = latest.items.filter((item) => !byKey(previous7).has(item.key)).length;
  const retained = previous7 ? [...initialTop10].filter((key) => latestTop10.has(key)).length : null;

  document.getElementById("status").textContent = `최종 수집 ${latest.captured_kst || formatDate(latest.captured_at)} · 원본 갱신 ${formatDate(latest.source_updated_at)}`;
  setMetric("metric-tracked", `${latest.items.length}개`);
  setMetric("metric-new", previous7 ? `${incoming7d}개` : "대기");
  setMetric("metric-retention", retained === null ? "대기" : `${retained * 10}%`);
  setMetric("metric-window", `${snapshots.length}일`);
  renderTrendChart(snapshots, latest);
  renderMovers(latest, previous7);
  renderTable(latest, previous7);
  document.getElementById("search").addEventListener("input", (event) => renderTable(latest, previous7, event.target.value));
}

async function boot() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderDashboard(await response.json());
  } catch (error) {
    const status = document.getElementById("status");
    status.textContent = `데이터를 불러오지 못했습니다: ${error.message}`;
    status.classList.add("error");
  }
}

boot();
