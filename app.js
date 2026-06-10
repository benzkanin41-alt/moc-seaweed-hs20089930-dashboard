(function () {
  "use strict";

  const DATA = window.MOC_EXPORT_DATA;
  const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const COLORS = ["#0f766e", "#2563eb", "#b45309", "#be123c", "#15803d", "#7c3aed", "#0891b2", "#c2410c", "#4f46e5", "#047857"];
  const METRIC_LABEL = { value: "มูลค่า", quantity: "ปริมาณ" };
  const UNIT_LABEL = { value: "บาท", quantity: "หน่วย" };

  const state = {
    periodType: "month",
    dimension: "total",
    metric: "value",
    growth: "mom",
    rowLimit: 100,
    sortKey: "period",
    sortDir: "desc",
    entitySearch: "",
    selectedIds: new Set(["TOTAL"]),
    selectedChartPoints: {
      level: null,
      growth: null,
    },
  };

  const els = {
    coverageText: document.getElementById("coverageText"),
    sourceLink: document.getElementById("sourceLink"),
    kpiGrid: document.getElementById("kpiGrid"),
    periodControls: document.getElementById("periodControls"),
    dimensionSelect: document.getElementById("dimensionSelect"),
    metricSelect: document.getElementById("metricSelect"),
    growthSelect: document.getElementById("growthSelect"),
    entityBand: document.getElementById("entityBand"),
    entitySearch: document.getElementById("entitySearch"),
    entityList: document.getElementById("entityList"),
    selectTopBtn: document.getElementById("selectTopBtn"),
    selectAllBtn: document.getElementById("selectAllBtn"),
    clearSelectionBtn: document.getElementById("clearSelectionBtn"),
    levelSubtitle: document.getElementById("levelSubtitle"),
    growthSubtitle: document.getElementById("growthSubtitle"),
    levelUnit: document.getElementById("levelUnit"),
    levelChart: document.getElementById("levelChart"),
    growthChart: document.getElementById("growthChart"),
    levelPointDetail: document.getElementById("levelPointDetail"),
    growthPointDetail: document.getElementById("growthPointDetail"),
    tableSubtitle: document.getElementById("tableSubtitle"),
    tableBody: document.getElementById("dataTableBody"),
    sortKeySelect: document.getElementById("sortKeySelect"),
    sortDirSelect: document.getElementById("sortDirSelect"),
    rowLimitSelect: document.getElementById("rowLimitSelect"),
    growthValueHeader: document.getElementById("growthValueHeader"),
    growthQuantityHeader: document.getElementById("growthQuantityHeader"),
    downloadCsvBtn: document.getElementById("downloadCsvBtn"),
    sourceDetails: document.getElementById("sourceDetails"),
  };

  const nf0 = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat("th-TH", { notation: "compact", maximumFractionDigits: 1 });

  let currentRows = [];
  let currentEntityOptions = [];
  let currentTableRows = [];

  function toThaiYear(year) {
    return year + 543;
  }

  function monthIndex(year, month) {
    return year * 12 + month;
  }

  function parseMonthKey(key) {
    const parts = key.split("-");
    return { year: Number(parts[0]), month: Number(parts[1]) };
  }

  function monthKeyFromIndex(index) {
    const year = Math.floor((index - 1) / 12);
    const month = index - year * 12;
    return `${year}-${String(month).padStart(2, "0")}`;
  }

  function getPeriodMeta(periodType, row) {
    if (periodType === "month") {
      return {
        key: row.period,
        label: `${THAI_MONTHS[row.month - 1]} ${toThaiYear(row.year)}`,
        sortIndex: monthIndex(row.year, row.month),
        expectedMonths: 1,
      };
    }
    if (periodType === "quarter") {
      const quarter = Math.floor((row.month - 1) / 3) + 1;
      return {
        key: `${row.year}-Q${quarter}`,
        label: `Q${quarter} ${toThaiYear(row.year)}`,
        sortIndex: monthIndex(row.year, (quarter - 1) * 3 + 1),
        expectedMonths: 3,
      };
    }
    return {
      key: String(row.year),
      label: String(toThaiYear(row.year)),
      sortIndex: monthIndex(row.year, 1),
      expectedMonths: 12,
    };
  }

  function compareKey(periodType, periodKey, growthType) {
    if (periodType === "month") {
      const parsed = parseMonthKey(periodKey);
      const index = monthIndex(parsed.year, parsed.month);
      if (growthType === "mom") return monthKeyFromIndex(index - 1);
      if (growthType === "yoy") return monthKeyFromIndex(index - 12);
    }
    if (periodType === "quarter") {
      const match = periodKey.match(/^(\d+)-Q(\d)$/);
      if (!match) return null;
      let year = Number(match[1]);
      let quarter = Number(match[2]);
      if (growthType === "qoq") {
        quarter -= 1;
        if (quarter === 0) {
          quarter = 4;
          year -= 1;
        }
        return `${year}-Q${quarter}`;
      }
      if (growthType === "yoy") return `${year - 1}-Q${quarter}`;
    }
    if (periodType === "year" && growthType === "yoy") {
      return String(Number(periodKey) - 1);
    }
    return null;
  }

  function growthOptions() {
    if (state.periodType === "month") {
      return [
        { id: "mom", label: "MoM" },
        { id: "yoy", label: "YoY" },
      ];
    }
    if (state.periodType === "quarter") {
      return [
        { id: "qoq", label: "QoQ" },
        { id: "yoy", label: "YoY" },
      ];
    }
    return [{ id: "yoy", label: "YoY" }];
  }

  function ensureGrowthOption() {
    const options = growthOptions();
    if (!options.some((option) => option.id === state.growth)) {
      state.growth = options[0].id;
    }
    els.growthSelect.innerHTML = options.map((option) => `<option value="${option.id}">${option.label}</option>`).join("");
    els.growthSelect.value = state.growth;
  }

  function syncSortOptions() {
    const availableGrowth = new Set(growthOptions().map((option) => option.id));
    const growthBySortKey = {
      momValue: "mom",
      momQuantity: "mom",
      qoqValue: "qoq",
      qoqQuantity: "qoq",
      yoyValue: "yoy",
      yoyQuantity: "yoy",
    };
    let currentAvailable = true;
    Array.from(els.sortKeySelect.options).forEach((option) => {
      const requiredGrowth = growthBySortKey[option.value];
      const disabled = Boolean(requiredGrowth) && !availableGrowth.has(requiredGrowth);
      option.disabled = disabled;
      if (option.value === state.sortKey && disabled) currentAvailable = false;
    });
    if (!currentAvailable) state.sortKey = "period";
    els.sortKeySelect.value = state.sortKey;
    els.sortDirSelect.value = state.sortDir;
  }

  function entityFromRow(row, dimension) {
    if (dimension === "total") {
      return { entityId: "TOTAL", entityName: "รวมทุกประเทศ" };
    }
    if (dimension === "continent") {
      return { entityId: row.continentId, entityName: row.continentName };
    }
    const code = row.countryCode ? `${row.countryCode} : ` : "";
    return { entityId: row.countryId, entityName: `${code}${row.countryName}` };
  }

  function aggregateBase(periodType, dimension) {
    const source = dimension === "total" ? DATA.totals : DATA.monthly;
    const map = new Map();
    for (const row of source) {
      const periodMeta = getPeriodMeta(periodType, row);
      const entity = entityFromRow(row, dimension);
      const key = `${periodMeta.key}|${entity.entityId}`;
      if (!map.has(key)) {
        map.set(key, {
          periodKey: periodMeta.key,
          periodLabel: periodMeta.label,
          periodSort: periodMeta.sortIndex,
          expectedMonths: periodMeta.expectedMonths,
          months: new Set(),
          entityId: entity.entityId,
          entityName: entity.entityName,
          value: 0,
          quantity: 0,
        });
      }
      const entry = map.get(key);
      entry.value += Number(row.value || 0);
      entry.quantity += Number(row.quantity || 0);
      entry.months.add(row.period);
    }
    return Array.from(map.values()).map((row) => ({
      ...row,
      monthCount: row.months.size,
      isPartial: row.months.size < row.expectedMonths,
      months: Array.from(row.months).sort(),
    }));
  }

  function addGrowth(rows, periodType) {
    const lookup = new Map(rows.map((row) => [`${row.periodKey}|${row.entityId}`, row]));
    for (const row of rows) {
      for (const growthType of ["mom", "qoq", "yoy"]) {
        const targetKey = compareKey(periodType, row.periodKey, growthType);
        const previous = targetKey ? lookup.get(`${targetKey}|${row.entityId}`) : null;
        const eligible = periodType === "month" || (previous && row.monthCount === row.expectedMonths && previous.monthCount === previous.expectedMonths);
        row[`${growthType}Value`] = eligible && previous ? percentChange(row.value, previous.value) : null;
        row[`${growthType}Quantity`] = eligible && previous ? percentChange(row.quantity, previous.quantity) : null;
      }
    }
    return rows;
  }

  function percentChange(current, previous) {
    if (!Number.isFinite(previous) || previous === 0) return null;
    return ((current - previous) / previous) * 100;
  }

  function aggregate(periodType, dimension) {
    const rows = aggregateBase(periodType, dimension);
    const totals = aggregateBase(periodType, "total");
    const totalByPeriod = new Map(totals.map((row) => [row.periodKey, row]));
    for (const row of rows) {
      const total = totalByPeriod.get(row.periodKey);
      row.share = total && total.value ? (row.value / total.value) * 100 : null;
      row.quantityShare = total && total.quantity ? (row.quantity / total.quantity) * 100 : null;
    }
    return addGrowth(rows, periodType).sort((a, b) => a.periodSort - b.periodSort || b.value - a.value);
  }

  function filteredRows(rows) {
    if (state.dimension === "total") return rows;
    if (state.selectedIds.size === 0) return [];
    return rows.filter((row) => state.selectedIds.has(row.entityId));
  }

  function buildEntityOptions(rows) {
    const latestSort = Math.max(...rows.map((row) => row.periodSort));
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.entityId)) {
        map.set(row.entityId, {
          id: row.entityId,
          name: row.entityName,
          latestValue: 0,
          totalValue: 0,
        });
      }
      const option = map.get(row.entityId);
      option.totalValue += row.value;
      if (row.periodSort === latestSort) option.latestValue = row.value;
    }
    return Array.from(map.values()).sort((a, b) => (b.latestValue || b.totalValue) - (a.latestValue || a.totalValue));
  }

  function resetSelection(rows) {
    currentEntityOptions = buildEntityOptions(rows);
    state.selectedIds.clear();
    if (state.dimension === "total") {
      state.selectedIds.add("TOTAL");
      return;
    }
    const count = state.dimension === "continent" ? currentEntityOptions.length : Math.min(10, currentEntityOptions.length);
    currentEntityOptions.slice(0, count).forEach((option) => state.selectedIds.add(option.id));
  }

  function formatNumber(value, decimals) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
    if (decimals === 2) return nf2.format(value);
    if (decimals === 1) return nf1.format(value);
    return nf0.format(value);
  }

  function formatCompact(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
    return compact.format(value);
  }

  function formatPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
    const cls = value >= 0 ? "positive" : "negative";
    return `<span class="${cls}">${value >= 0 ? "+" : ""}${nf1.format(value)}%</span>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderCoverage() {
    const meta = DATA.metadata;
    els.coverageText.textContent = `${meta.hsName} | ${meta.startPeriod} ถึง ${meta.latestPeriod}\nlatest source month: ${THAI_MONTHS[meta.latestMonth - 1]} ${toThaiYear(meta.latestYear)}`;
    els.sourceLink.href = meta.reportUrl;
  }

  function sumTotals(year, throughMonth) {
    return DATA.totals
      .filter((row) => row.year === year && row.month <= throughMonth)
      .reduce(
        (acc, row) => {
          acc.value += Number(row.value || 0);
          acc.quantity += Number(row.quantity || 0);
          return acc;
        },
        { value: 0, quantity: 0 },
      );
  }

  function renderKpis() {
    const monthlyTotals = addGrowth(aggregateBase("month", "total"), "month");
    const latest = monthlyTotals.find((row) => row.periodKey === DATA.metadata.latestPeriod) || monthlyTotals[monthlyTotals.length - 1];
    const ytd = sumTotals(DATA.metadata.latestYear, DATA.metadata.latestMonth);
    const ytdPrev = sumTotals(DATA.metadata.latestYear - 1, DATA.metadata.latestMonth);
    const ytdValueYoY = percentChange(ytd.value, ytdPrev.value);
    const ytdQuantityYoY = percentChange(ytd.quantity, ytdPrev.quantity);
    const kpis = [
      { label: "มูลค่าเดือนล่าสุด", value: formatCompact(latest.value), note: latest.periodLabel },
      { label: "ปริมาณเดือนล่าสุด", value: formatCompact(latest.quantity), note: latest.periodLabel },
      { label: "MoM มูลค่า", value: formatPercent(latest.momValue), note: "เทียบเดือนก่อน" },
      { label: "YoY มูลค่า", value: formatPercent(latest.yoyValue), note: "เทียบเดือนเดียวกันปีก่อน" },
      { label: "YTD มูลค่า", value: formatCompact(ytd.value), note: `YoY ${stripTags(formatPercent(ytdValueYoY))}` },
      { label: "YTD ปริมาณ", value: formatCompact(ytd.quantity), note: `YoY ${stripTags(formatPercent(ytdQuantityYoY))}` },
    ];
    els.kpiGrid.innerHTML = kpis
      .map(
        (kpi) => `
          <article class="kpi">
            <div class="kpi-label">${escapeHtml(kpi.label)}</div>
            <div class="kpi-value">${kpi.value}</div>
            <div class="kpi-note">${escapeHtml(kpi.note)}</div>
          </article>
        `,
      )
      .join("");
  }

  function stripTags(value) {
    const temp = document.createElement("span");
    temp.innerHTML = value;
    return temp.textContent || "";
  }

  function renderEntities(rows) {
    currentEntityOptions = buildEntityOptions(rows);
    const search = state.entitySearch.trim().toLowerCase();
    const options = currentEntityOptions.filter((option) => option.name.toLowerCase().includes(search));
    els.entityBand.style.display = state.dimension === "total" ? "none" : "block";
    els.entityList.innerHTML = options
      .map(
        (option) => `
          <label title="${escapeHtml(option.name)}">
            <input type="checkbox" value="${escapeHtml(option.id)}" ${state.selectedIds.has(option.id) ? "checked" : ""}>
            <span>${escapeHtml(option.name)}</span>
          </label>
        `,
      )
      .join("");
    els.entityList.querySelectorAll("input").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) state.selectedIds.add(input.value);
        else state.selectedIds.delete(input.value);
        render();
      });
    });
  }

  function chartSeries(rows, valueKey, isGrowth) {
    const allPeriods = Array.from(new Map(currentRows.map((row) => [row.periodKey, row])).values()).sort((a, b) => a.periodSort - b.periodSort);
    const selectedRows = filteredRows(rows);
    const byEntity = new Map();
    for (const row of selectedRows) {
      if (!byEntity.has(row.entityId)) byEntity.set(row.entityId, { id: row.entityId, name: row.entityName, rows: new Map() });
      byEntity.get(row.entityId).rows.set(row.periodKey, row);
    }
    return Array.from(byEntity.values()).map((entity, index) => ({
      id: entity.id,
      name: entity.name,
      color: COLORS[index % COLORS.length],
      points: allPeriods.map((period) => {
        const row = entity.rows.get(period.periodKey);
        const value = row ? row[valueKey] : isGrowth ? null : 0;
        return {
          row: row || null,
          periodKey: period.periodKey,
          periodLabel: period.periodLabel,
          periodSort: period.periodSort,
          value,
          isPartial: row ? row.isPartial : period.isPartial,
        };
      }),
    }));
  }

  function pointIsSelectable(point) {
    return Boolean(point.row) && Number.isFinite(point.value);
  }

  function resolveSelectedPoint(chartId, series) {
    const saved = state.selectedChartPoints[chartId];
    if (saved) {
      for (const one of series) {
        if (one.id !== saved.entityId) continue;
        const point = one.points.find((item) => item.periodKey === saved.periodKey);
        if (point && pointIsSelectable(point)) return saved;
      }
    }
    for (const one of series) {
      for (let index = one.points.length - 1; index >= 0; index -= 1) {
        const point = one.points[index];
        if (pointIsSelectable(point)) {
          const next = { entityId: one.id, periodKey: point.periodKey };
          state.selectedChartPoints[chartId] = next;
          return next;
        }
      }
    }
    state.selectedChartPoints[chartId] = null;
    return null;
  }

  function findCurrentRow(selection) {
    if (!selection) return null;
    return filteredRows(currentRows).find((row) => row.entityId === selection.entityId && row.periodKey === selection.periodKey) || null;
  }

  function renderPointDetail(detailEl, chartId, selection) {
    const row = findCurrentRow(selection);
    if (!row) {
      detailEl.innerHTML = "";
      return;
    }
    const selectedGrowthKey = `${state.growth}${state.metric === "value" ? "Value" : "Quantity"}`;
    const selectedLabel = chartId === "growth" ? `${state.growth.toUpperCase()} ${METRIC_LABEL[state.metric]}` : METRIC_LABEL[state.metric];
    const selectedValue = chartId === "growth" ? formatPercent(row[selectedGrowthKey]) : formatNumber(row[state.metric], 0);
    const partial = row.isPartial ? '<span class="partial-tag">partial</span>' : "";
    const items = [
      ["มูลค่า", formatNumber(row.value, 0)],
      ["ปริมาณ", formatNumber(row.quantity, 0)],
      ["Share มูลค่า", formatPercent(row.share)],
      ["Share ปริมาณ", formatPercent(row.quantityShare)],
      ["MoM มูลค่า", formatPercent(row.momValue)],
      ["MoM ปริมาณ", formatPercent(row.momQuantity)],
      ["YoY มูลค่า", formatPercent(row.yoyValue)],
      ["YoY ปริมาณ", formatPercent(row.yoyQuantity)],
      ["QoQ มูลค่า", formatPercent(row.qoqValue)],
      ["QoQ ปริมาณ", formatPercent(row.qoqQuantity)],
    ];
    detailEl.innerHTML = `
      <div class="point-detail-head">
        <div>
          <strong>${escapeHtml(row.periodLabel)}${partial}</strong>
          <span>${escapeHtml(row.entityName)}</span>
        </div>
        <div class="point-focus">
          <span>${escapeHtml(selectedLabel)}</span>
          <strong>${selectedValue}</strong>
        </div>
      </div>
      <div class="point-detail-grid">
        ${items.map((item) => `<div class="point-stat"><span>${escapeHtml(item[0])}</span><strong>${item[1]}</strong></div>`).join("")}
      </div>
    `;
  }

  function renderLineChart(container, series, options) {
    const values = [];
    for (const one of series) {
      for (const point of one.points) {
        if (Number.isFinite(point.value)) values.push(point.value);
      }
    }
    if (!series.length || !values.length) {
      container.innerHTML = '<div class="empty-chart">ไม่มีข้อมูลตาม filter ที่เลือก</div>';
      if (options.detailEl) options.detailEl.innerHTML = "";
      return;
    }

    const selectedPoint = resolveSelectedPoint(options.chartId, series);
    const width = 920;
    const height = 360;
    const legendRows = Math.ceil(Math.min(series.length, 10) / 2);
    const pad = { top: 34 + legendRows * 16, right: 22, bottom: 64, left: 74 };
    const xMin = Math.min(...series.flatMap((one) => one.points.map((point) => point.periodSort)));
    const xMax = Math.max(...series.flatMap((one) => one.points.map((point) => point.periodSort)));
    let yMin = Math.min(...values);
    let yMax = Math.max(...values);
    if (options.includeZero) {
      yMin = Math.min(0, yMin);
      yMax = Math.max(0, yMax);
    }
    if (yMin === yMax) {
      yMin -= Math.abs(yMin || 1) * 0.1;
      yMax += Math.abs(yMax || 1) * 0.1;
    }
    const yPad = (yMax - yMin) * 0.08;
    yMin -= yPad;
    yMax += yPad;

    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const x = (sort) => pad.left + (xMax === xMin ? plotW / 2 : ((sort - xMin) / (xMax - xMin)) * plotW);
    const y = (value) => pad.top + (1 - (value - yMin) / (yMax - yMin)) * plotH;
    const periodTicks = series[0].points;
    const tickStep = Math.max(1, Math.ceil(periodTicks.length / 8));
    const yTicks = Array.from({ length: 5 }, (_, index) => yMin + ((yMax - yMin) * index) / 4);

    const grid = yTicks
      .map((tick) => `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}"></line>
        <text x="${pad.left - 8}" y="${y(tick) + 4}" text-anchor="end">${options.percent ? nf0.format(tick) + "%" : formatCompact(tick)}</text>`)
      .join("");
    const xTicks = periodTicks
      .filter((_, index) => index % tickStep === 0 || index === periodTicks.length - 1)
      .map((point) => `<text x="${x(point.periodSort)}" y="${height - 28}" text-anchor="middle">${escapeHtml(point.periodLabel)}</text>`)
      .join("");
    const zeroLine = options.percent && yMin < 0 && yMax > 0 ? `<line class="zero-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"></line>` : "";

    const linePaths = series
      .map((one) => {
        const segments = [];
        let segment = [];
        for (const point of one.points) {
          if (!Number.isFinite(point.value)) {
            if (segment.length) segments.push(segment);
            segment = [];
            continue;
          }
          segment.push(`${x(point.periodSort)},${y(point.value)}`);
        }
        if (segment.length) segments.push(segment);
        const paths = segments
          .map((segmentPoints) => `<polyline points="${segmentPoints.join(" ")}" fill="none" stroke="${one.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline>`)
          .join("");
        const circles = one.points
          .filter((point) => Number.isFinite(point.value))
          .map((point) => {
            const label = options.percent ? `${nf1.format(point.value)}%` : formatNumber(point.value, options.decimals);
            const selected = selectedPoint && selectedPoint.entityId === one.id && selectedPoint.periodKey === point.periodKey;
            const selectable = pointIsSelectable(point);
            return `<circle class="chart-point ${selected ? "selected" : ""}" cx="${x(point.periodSort)}" cy="${y(point.value)}" r="${selected ? "4.8" : "3.4"}" fill="${one.color}" ${selectable ? `tabindex="0" role="button" data-chart-point="true" data-chart-id="${escapeHtml(options.chartId)}" data-entity-id="${escapeHtml(one.id)}" data-period-key="${escapeHtml(point.periodKey)}"` : ""}>
              <title>${escapeHtml(one.name)} | ${escapeHtml(point.periodLabel)} | ${label}</title>
            </circle>`;
          })
          .join("");
        return paths + circles;
      })
      .join("");

    const legend = series
      .slice(0, 10)
      .map((one, index) => {
        const row = Math.floor(index / 2);
        const col = index % 2;
        const lx = pad.left + col * 360;
        const ly = 18 + row * 16;
        return `<g class="legend" transform="translate(${lx},${ly})">
          <rect width="10" height="10" rx="2" fill="${one.color}"></rect>
          <text x="16" y="10">${escapeHtml(one.name.slice(0, 38))}</text>
        </g>`;
      })
      .join("");

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}">
        <g class="axis">${grid}${xTicks}</g>
        ${zeroLine}
        ${linePaths}
        ${legend}
      </svg>
    `;
    container.querySelectorAll("[data-chart-point]").forEach((node) => {
      const selectPoint = () => {
        state.selectedChartPoints[node.dataset.chartId] = {
          entityId: node.dataset.entityId,
          periodKey: node.dataset.periodKey,
        };
        renderCharts(currentRows);
      };
      node.addEventListener("click", selectPoint);
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectPoint();
        }
      });
    });
    if (options.detailEl) renderPointDetail(options.detailEl, options.chartId, selectedPoint);
  }

  function renderCharts(rows) {
    const visibleRows = filteredRows(rows);
    const metricKey = state.metric;
    const growthKey = `${state.growth}${state.metric === "value" ? "Value" : "Quantity"}`;
    const periodLabel = { month: "รายเดือน", quarter: "รายไตรมาส", year: "รายปี" }[state.periodType];
    const dimensionLabel = { total: "รวมทุกประเทศ", country: "รายประเทศ", continent: "รายทวีป" }[state.dimension];
    els.levelSubtitle.textContent = `${periodLabel} | ${dimensionLabel}`;
    els.growthSubtitle.textContent = `${state.growth.toUpperCase()} ${METRIC_LABEL[state.metric]} | ${periodLabel}`;
    els.levelUnit.textContent = UNIT_LABEL[state.metric];
    renderLineChart(els.levelChart, chartSeries(visibleRows, metricKey, false), {
      chartId: "level",
      title: "ยอดส่งออก",
      percent: false,
      decimals: state.metric === "value" ? 0 : 0,
      includeZero: true,
      detailEl: els.levelPointDetail,
    });
    renderLineChart(els.growthChart, chartSeries(visibleRows, growthKey, true), {
      chartId: "growth",
      title: "การเติบโต",
      percent: true,
      decimals: 1,
      includeZero: true,
      detailEl: els.growthPointDetail,
    });
  }

  function tableSortValue(row) {
    if (state.sortKey === "period") return row.periodSort;
    return row[state.sortKey];
  }

  function compareTableRows(a, b) {
    const aValue = tableSortValue(a);
    const bValue = tableSortValue(b);
    const aOk = Number.isFinite(Number(aValue));
    const bOk = Number.isFinite(Number(bValue));
    if (!aOk && !bOk) return b.periodSort - a.periodSort || b.value - a.value;
    if (!aOk) return 1;
    if (!bOk) return -1;
    const direction = state.sortDir === "asc" ? 1 : -1;
    if (Number(aValue) !== Number(bValue)) return (Number(aValue) > Number(bValue) ? 1 : -1) * direction;
    return b.periodSort - a.periodSort || b.value - a.value;
  }

  function selectedOptionText(selectEl) {
    const option = selectEl.options[selectEl.selectedIndex];
    return option ? option.textContent : "";
  }

  function tableRows(rows) {
    return filteredRows(rows)
      .slice()
      .sort(compareTableRows)
      .slice(0, state.rowLimit);
  }

  function renderTable(rows) {
    const growthValueKey = `${state.growth}Value`;
    const growthQuantityKey = `${state.growth}Quantity`;
    currentTableRows = tableRows(rows);
    els.growthValueHeader.textContent = `${state.growth.toUpperCase()} มูลค่า`;
    els.growthQuantityHeader.textContent = `${state.growth.toUpperCase()} ปริมาณ`;
    els.tableSubtitle.textContent = `${currentTableRows.length} rows shown | เรียง ${selectedOptionText(els.sortKeySelect)} ${selectedOptionText(els.sortDirSelect)}`;
    els.tableBody.innerHTML = currentTableRows
      .map((row) => {
        const partial = row.isPartial ? '<span class="partial-tag">partial</span>' : "";
        return `
          <tr>
            <td>${escapeHtml(row.periodLabel)}${partial}</td>
            <td>${escapeHtml(row.entityName)}</td>
            <td class="num">${formatNumber(row.value, 0)}</td>
            <td class="num">${formatNumber(row.quantity, 0)}</td>
            <td class="num">${formatPercent(row.share)}</td>
            <td class="num">${formatPercent(row[growthValueKey])}</td>
            <td class="num">${formatPercent(row[growthQuantityKey])}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderSourceDetails() {
    const meta = DATA.metadata;
    const validation = DATA.validation;
    const sourceItems = [
      ["Source", meta.source],
      ["Endpoint", meta.endpoint],
      ["Fetched UTC", meta.fetchedAtUtc],
      ["Coverage", `${meta.startPeriod} ถึง ${meta.latestPeriod}`],
      ["HS Code", `${meta.hsCode} | version ${meta.hsVersion}`],
      ["Rows", `${validation.countryRows} country-month rows`],
      ["Reconciliation", `max value diff ${formatNumber(validation.maxAbsValueDiff, 0)} | max quantity diff ${formatNumber(validation.maxAbsQuantityDiff, 0)}`],
      ["Current partials", `Q${Math.floor((meta.latestMonth - 1) / 3) + 1} ${toThaiYear(meta.latestYear)} และปี ${toThaiYear(meta.latestYear)} ยังไม่ครบปี`],
    ];
    els.sourceDetails.innerHTML = sourceItems
      .map((item) => `<div class="source-item"><span>${escapeHtml(item[0])}</span><strong>${escapeHtml(item[1])}</strong></div>`)
      .join("");
  }

  function downloadCurrentCsv() {
    const growthValueKey = `${state.growth}Value`;
    const growthQuantityKey = `${state.growth}Quantity`;
    const header = ["period", "entity", "value", "quantity", "share_value_pct", `${state.growth}_value_pct`, `${state.growth}_quantity_pct`, "partial"];
    const lines = [header.join(",")];
    for (const row of currentTableRows) {
      const values = [
        row.periodLabel,
        row.entityName,
        row.value,
        row.quantity,
        row.share ?? "",
        row[growthValueKey] ?? "",
        row[growthQuantityKey] ?? "",
        row.isPartial ? "partial" : "",
      ];
      lines.push(values.map(csvCell).join(","));
    }
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `hs${DATA.metadata.hsCode}_${state.periodType}_${state.dimension}_${state.metric}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function csvCell(value) {
    const text = String(value);
    if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  }

  function bindEvents() {
    els.periodControls.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.periodType = button.dataset.period;
        els.periodControls.querySelectorAll("button").forEach((node) => node.classList.toggle("active", node === button));
        ensureGrowthOption();
        render();
      });
    });
    els.dimensionSelect.addEventListener("change", () => {
      state.dimension = els.dimensionSelect.value;
      const rows = aggregate(state.periodType, state.dimension);
      resetSelection(rows);
      render();
    });
    els.metricSelect.addEventListener("change", () => {
      state.metric = els.metricSelect.value;
      render();
    });
    els.growthSelect.addEventListener("change", () => {
      state.growth = els.growthSelect.value;
      render();
    });
    els.entitySearch.addEventListener("input", () => {
      state.entitySearch = els.entitySearch.value;
      renderEntities(currentRows);
    });
    els.selectTopBtn.addEventListener("click", () => {
      state.selectedIds.clear();
      currentEntityOptions.slice(0, Math.min(10, currentEntityOptions.length)).forEach((option) => state.selectedIds.add(option.id));
      render();
    });
    els.selectAllBtn.addEventListener("click", () => {
      state.selectedIds.clear();
      currentEntityOptions.forEach((option) => state.selectedIds.add(option.id));
      render();
    });
    els.clearSelectionBtn.addEventListener("click", () => {
      state.selectedIds.clear();
      render();
    });
    els.sortKeySelect.addEventListener("change", () => {
      state.sortKey = els.sortKeySelect.value;
      render();
    });
    els.sortDirSelect.addEventListener("change", () => {
      state.sortDir = els.sortDirSelect.value;
      render();
    });
    els.rowLimitSelect.addEventListener("change", () => {
      state.rowLimit = Number(els.rowLimitSelect.value);
      render();
    });
    els.downloadCsvBtn.addEventListener("click", downloadCurrentCsv);
  }

  function render() {
    ensureGrowthOption();
    syncSortOptions();
    currentRows = aggregate(state.periodType, state.dimension);
    const validIds = new Set(currentRows.map((row) => row.entityId));
    state.selectedIds = new Set(Array.from(state.selectedIds).filter((id) => validIds.has(id)));
    if (state.dimension === "total" && state.selectedIds.size === 0) state.selectedIds.add("TOTAL");
    renderEntities(currentRows);
    renderCharts(currentRows);
    renderTable(currentRows);
    renderSourceDetails();
  }

  function init() {
    if (!DATA || !DATA.monthly || !DATA.totals) {
      document.body.innerHTML = "<main class=\"shell\"><section class=\"panel\">ไม่พบ data.js</section></main>";
      return;
    }
    renderCoverage();
    renderKpis();
    bindEvents();
    ensureGrowthOption();
    currentRows = aggregate(state.periodType, state.dimension);
    resetSelection(currentRows);
    render();
  }

  init();
})();
