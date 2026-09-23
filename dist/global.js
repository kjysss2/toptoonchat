(() => {
  const GLOBAL_DATA_URL = "./data/global-expansion.json";
  const number = new Intl.NumberFormat("ko-KR");
  const SITE_META = [
    { key: "kr", label: "한국", className: "kr" },
    { key: "global", label: "Global(EN)", sublabel: "영어권", className: "global" },
    { key: "jp", label: "일본", className: "jp" },
    { key: "tw", label: "대만", className: "tw" },
  ];
  let globalPayload = null;
  let globalRefreshing = false;
  let mainHeaderState = null;

  const asNumber = (value) => Number.isFinite(value) ? value : null;
  const fmt = (value) => value === null ? "—" : number.format(value);
  const fmtPct = (value, digits = 1) => value === null ? "—" : `${value.toFixed(digits)}%`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));

  function sourceDateLabel(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "날짜 미확인";
    const [year, month, day] = value.split("-").map(Number);
    return `${year}.${month}.${day}`;
  }

  function validateGlobalPayload(payload) {
    const perSite = payload?.comparison?.overall?.per_site;
    const rows = payload?.comparison?.rows;
    if (!perSite || !Array.isArray(rows) || !SITE_META.every(({ key }) => perSite[key])) {
      throw new Error("글로벌 데이터 형식이 올바르지 않습니다.");
    }
    return { perSite, rows };
  }

  function renderGlobalMetrics(payload) {
    const { perSite } = validateGlobalPayload(payload);
    const overseasTotal = asNumber(payload.comparison?.overall?.overseas_total);
    const globalPct = asNumber(payload.comparison?.overall?.global_traction_pct);
    let cards = SITE_META.map(({ key, label, sublabel, className }) => {
      const item = perSite[key];
      const share = key === "kr" ? null : asNumber(payload.comparison?.overall?.per_site_pct?.[key]);
      return `<article class="global-metric-card ${className}">
        <span>${label}${sublabel ? ` <small>${sublabel}</small>` : ""}</span>
        <strong>${fmt(asNumber(item.chats))}</strong>
        <small>누적 대화수${share === null ? "" : ` · 한국 대비 ${fmtPct(share)}`}</small>
      </article>`;
    }).join("");
    cards += `<article class="global-metric-card overseas">
      <span>해외 합계</span>
      <strong>${fmt(overseasTotal)}</strong>
      <small>한국 대비 ${fmtPct(globalPct, 2)}</small>
    </article>`;
    document.getElementById("global-metrics").innerHTML = cards;
  }

  function renderSiteBars(payload) {
    const { perSite } = validateGlobalPayload(payload);
    const maximum = Math.max(1, ...SITE_META.map(({ key }) => asNumber(perSite[key].chats) || 0));
    document.getElementById("global-country-bars").innerHTML = SITE_META.map(({ key, label, sublabel, className }) => {
      const item = perSite[key];
      const chats = asNumber(item.chats) || 0;
      const pct = Math.max(0, Math.min(100, (chats / maximum) * 100));
      const conversion = asNumber(item.conversion_pct);
      return `<div class="global-bar-row">
        <div class="global-bar-label"><strong>${label}</strong>${sublabel ? `<small>${sublabel}</small>` : ""}</div>
        <div class="global-bar-track" aria-label="${label} 누적 대화수 ${fmt(chats)}"><i class="global-bar-fill ${className}" style="width:${pct}%"></i></div>
        <div class="global-bar-value"><strong>${fmt(chats)}</strong><small>대화/조회 ${fmtPct(conversion, 3)}</small></div>
      </div>`;
    }).join("");
  }

  function linePath(points, key, width, height, padding, minimum, maximum) {
    const xSpan = width - padding.left - padding.right;
    const ySpan = height - padding.top - padding.bottom;
    const range = maximum - minimum || 1;
    let continues = false;
    return points.map((point, index) => {
      const current = asNumber(point[key]);
      if (current === null) {
        continues = false;
        return "";
      }
      const x = padding.left + (points.length === 1 ? xSpan / 2 : (xSpan * index) / (points.length - 1));
      const y = padding.top + ((maximum - current) / range) * ySpan;
      const command = continues ? "L" : "M";
      continues = true;
      return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
    }).filter(Boolean).join(" ");
  }

  function renderTraction(payload) {
    const daily = Array.isArray(payload?.traction?.daily) ? payload.traction.daily : [];
    const points = daily
      .filter((row) => typeof row?.date === "string" && (asNumber(row.kr_delta) !== null || asNumber(row.overseas_delta) !== null))
      .slice(-21);
    const root = document.getElementById("global-traction-chart");
    if (!points.length) {
      root.innerHTML = '<p class="empty-chart">원본의 일별 대화 증가 데이터가 아직 없습니다.</p>';
      return;
    }
    const values = points.flatMap((point) => [asNumber(point.kr_delta), asNumber(point.overseas_delta)]).filter((value) => value !== null);
    const minimum = Math.min(0, ...values);
    const maximum = Math.max(0, ...values);
    const width = 920, height = 214, padding = { top: 18, right: 14, bottom: 38, left: 14 };
    const path = (key) => linePath(points, key, width, height, padding, minimum, maximum);
    const xAxis = points.length === 1 ? width / 2 : padding.left + ((width - padding.left - padding.right) * (points.length - 1)) / (points.length - 1);
    const yAxis = padding.top + ((maximum - 0) / (maximum - minimum || 1)) * (height - padding.top - padding.bottom);
    const first = points[0].date.slice(5).replace("-", "/"), last = points.at(-1).date.slice(5).replace("-", "/");
    root.innerHTML = `<svg class="chart-svg global-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="한국과 해외 합계의 일별 대화수 증가 추이">
      <line class="grid-line" x1="${padding.left}" y1="${yAxis.toFixed(1)}" x2="${width - padding.right}" y2="${yAxis.toFixed(1)}" />
      <path class="global-line-kr" d="${path("kr_delta")}" />
      <path class="global-line-overseas" d="${path("overseas_delta")}" />
      <text class="axis-label" x="${padding.left}" y="${height - 12}">${first}</text>
      <text class="axis-label" text-anchor="end" x="${xAxis}" y="${height - 12}">${last}</text>
    </svg>
    <div class="chart-legend"><span><i class="legend-kr"></i>한국</span><span><i class="legend-overseas"></i>해외 합계</span><span class="muted">최근 ${points.length}일 · 누적값이 아닌 일별 증가</span></div>`;
  }

  function foreignTotal(row) {
    const values = [row.global_chats, row.jp_chats, row.tw_chats]
      .map(asNumber)
      .filter((value) => value !== null);
    return {
      value: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      incomplete: values.length > 0 && values.length < 3,
    };
  }

  function countryCell(row, site) {
    const value = asNumber(row[`${site}_chats`]);
    const percentage = asNumber(row[`${site}_pct`]);
    return `<td>${fmt(value)}${percentage === null ? "" : `<small class="global-pct">한국 대비 ${fmtPct(percentage)}</small>`}</td>`;
  }

  function renderGlobalTable() {
    if (!globalPayload) return;
    const { rows } = validateGlobalPayload(globalPayload);
    const query = document.getElementById("global-search").value.trim().toLocaleLowerCase("ko-KR");
    const visible = rows.filter((row) => String(row.name || "").toLocaleLowerCase("ko-KR").includes(query));
    document.getElementById("global-table-caption").textContent = `원본 기준 ${number.format(rows.length)}개 캐릭터 · 현재 ${number.format(visible.length)}개 표시`;
    document.getElementById("global-ranking-body").innerHTML = visible.map((row) => {
      const kr = asNumber(row.kr_chats);
      const foreign = foreignTotal(row);
      const foreignPct = kr && foreign.value !== null ? (foreign.value / kr) * 100 : null;
      return `<tr>
        <td class="name-cell">${escapeHtml(row.name)}</td>
        <td>${fmt(kr)}</td>
        ${countryCell(row, "global")}
        ${countryCell(row, "jp")}
        ${countryCell(row, "tw")}
        <td>${fmt(foreign.value)}${foreignPct === null ? "" : `<small class="global-pct">${foreign.incomplete ? "확인 지역 합계 · " : ""}한국 대비 ${fmtPct(foreignPct)}</small>`}</td>
      </tr>`;
    }).join("") || '<tr><td colspan="6" class="empty-chart">검색 결과가 없습니다.</td></tr>';
  }

  function renderGlobal(payload) {
    const { perSite } = validateGlobalPayload(payload);
    renderGlobalMetrics(payload);
    renderSiteBars(payload);
    renderTraction(payload);
    document.getElementById("global-source-date").textContent = `원본 데이터 기준 ${sourceDateLabel(payload.source_latest_date)} · 마지막 데이터 갱신 ${payload.captured_kst || "시간 미확인"}`;
    document.getElementById("global-source-note").textContent = payload.source?.note || "Global(EN)은 영어권 글로벌 사이트 기준입니다.";
    document.getElementById("global-status").textContent = `한국 ${fmt(asNumber(perSite.kr.chats))} · Global(EN) ${fmt(asNumber(perSite.global.chats))} · 일본 ${fmt(asNumber(perSite.jp.chats))} · 대만 ${fmt(asNumber(perSite.tw.chats))}`;
    document.getElementById("global-status").classList.remove("error");
    globalPayload = payload;
    renderGlobalTable();
  }

  async function refreshGlobalData() {
    if (globalRefreshing) return;
    globalRefreshing = true;
    try {
      const response = await fetch(GLOBAL_DATA_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      renderGlobal(await response.json());
    } catch (error) {
      const status = document.getElementById("global-status");
      status.textContent = `${globalPayload ? "기존 글로벌 데이터 표시 중. " : ""}글로벌 데이터 갱신 실패: ${error.message}`;
      status.classList.add("error");
    } finally {
      globalRefreshing = false;
    }
  }

  function restoreMainDashboard(restoreHeader = false, returnFocus = false) {
    document.getElementById("main-dashboard").hidden = false;
    document.getElementById("global-dashboard").hidden = true;
    document.querySelectorAll("[data-dashboard-tab]").forEach((button) => {
      button.classList.remove("active");
      button.setAttribute("aria-expanded", "false");
    });
    if (restoreHeader && mainHeaderState) {
      const source = document.getElementById("source-link");
      document.getElementById("market-title").textContent = mainHeaderState.title;
      source.hidden = mainHeaderState.sourceHidden;
      source.href = mainHeaderState.sourceHref;
    }
    if (returnFocus) {
      const globalButton = document.getElementById("global-tab-button");
      if (typeof globalButton.focus === "function") globalButton.focus();
    }
  }

  function activateTab(name) {
    if (name !== "global") return;
    if (document.getElementById("global-dashboard").hidden) {
      const source = document.getElementById("source-link");
      mainHeaderState = {
        title: document.getElementById("market-title").textContent,
        sourceHidden: source.hidden,
        sourceHref: source.href,
      };
    }
    document.querySelectorAll("[data-dashboard-tab]").forEach((button) => {
      const selected = button.dataset.dashboardTab === name;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-expanded", String(selected));
    });
    document.querySelectorAll("[data-dashboard-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.dashboardPanel !== name;
    });
    document.getElementById("market-title").textContent = "탑툰챗 글로벌 진출";
    document.getElementById("source-link").hidden = true;
    refreshGlobalData();
  }

  document.querySelectorAll("[data-dashboard-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.dashboardTab));
  });
  document.getElementById("global-back").addEventListener("click", () => restoreMainDashboard(true, true));
  document.querySelectorAll("[data-market]").forEach((button) => {
    button.addEventListener("click", () => restoreMainDashboard(false));
  });
  document.getElementById("global-search").addEventListener("input", renderGlobalTable);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshGlobalData(); });
  window.addEventListener("focus", refreshGlobalData);
  setInterval(() => { if (!document.hidden) refreshGlobalData(); }, 300_000);
  refreshGlobalData();
})();
