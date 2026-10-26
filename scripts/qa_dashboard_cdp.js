const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:8778/";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const RESULTS_PATH = path.resolve(process.env.QA_RESULTS_OUT || path.join(ROOT, "qa-results.json"));
const SCREENSHOT_DIR = path.resolve(process.env.QA_SCREENSHOT_DIR || path.join(ROOT, "work", "qa-local"));
const EXPECTED_LATEST_PERIOD = process.env.EXPECTED_LATEST_PERIOD;
const PROFILE_DIR = path.join(ROOT, "work", "edge-cdp-profile");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort(start = 9230) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once("error", () => tryPort(port + 1));
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    };
    try {
      tryPort(start);
    } catch (error) {
      reject(error);
    }
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${body}`));
            return;
          }
          resolve(JSON.parse(body));
        });
      })
      .on("error", reject);
  });
}

async function waitForDebugger(port) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error("Timed out waiting for Edge remote debugger.");
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error("Timed out waiting for Edge page target.");
}

function createCdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const eventResolvers = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result || {});
      return;
    }
    const resolvers = eventResolvers.get(message.method);
    if (resolvers && resolvers.length) {
      resolvers.shift()(message.params || {});
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  function send(method, params = {}) {
    const messageId = ++id;
    const payload = JSON.stringify({ id: messageId, method, params });
    return new Promise((resolve, reject) => {
      pending.set(messageId, { resolve, reject });
      socket.send(payload);
    });
  }

  function waitEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const wrappedResolve = (params) => {
        clearTimeout(timeout);
        resolve(params);
      };
      const resolvers = eventResolvers.get(method) || [];
      resolvers.push(wrappedResolve);
      eventResolvers.set(method, resolvers);
    });
  }

  return {
    ready,
    send,
    waitEvent,
    close: () => socket.close(),
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function loadPage(cdp, url) {
  const loaded = cdp.waitEvent("Page.loadEventFired", 15000);
  await cdp.send("Page.navigate", { url });
  await loaded;
  await evaluate(cdp, "new Promise((resolve) => setTimeout(resolve, 700))");
}

async function readLayout(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const rects = [...document.querySelectorAll('.control-band, .panel, .kpi, .source-panel')]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        });
      return {
        title: document.title,
        h1: document.querySelector('h1')?.textContent || '',
        coverage: document.querySelector('#coverageText')?.textContent || '',
        latestPeriod: window.MOC_EXPORT_DATA?.metadata.latestPeriod || '',
        expectedMonthlyPoints: window.MOC_EXPORT_DATA?.totals.length || 0,
        latestSelectedPeriod: document.querySelector('#levelChart .chart-point.selected')?.dataset.periodKey || '',
        kpiCount: document.querySelectorAll('.kpi').length,
        levelPointCount: document.querySelectorAll('#levelChart [data-chart-point]').length,
        growthPointCount: document.querySelectorAll('#growthChart [data-chart-point]').length,
        tableRows: document.querySelectorAll('#dataTableBody tr').length,
        sourceItems: document.querySelectorAll('.source-item').length,
        sortControls: document.querySelectorAll('.table-controls select').length,
        bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
        clippedPanels: rects.filter((rect) => rect.left < -2 || rect.right > window.innerWidth + 2).length,
        chartSvgCount: document.querySelectorAll('.chart svg').length,
        xAxisLabelOverlapCount: (() => {
          const charts = ['#levelChart', '#growthChart'];
          return charts.reduce((total, chartSelector) => {
            const labels = [...document.querySelectorAll(chartSelector + ' .x-axis-label')]
              .map((node) => node.getBoundingClientRect())
              .sort((a, b) => a.left - b.left);
            return total + labels.slice(1).filter((rect, index) => rect.left < labels[index].right + 2).length;
          }, 0);
        })(),
      };
    })()`,
  );
}

function assertLayout(checks, label) {
  if (!checks.h1.includes("20089930") || checks.kpiCount !== 6 || checks.chartSvgCount !== 2 ||
      checks.levelPointCount === 0 || checks.growthPointCount === 0 || checks.tableRows === 0) {
    throw new Error(`${label}: Expected dashboard content is missing.`);
  }
  if (EXPECTED_LATEST_PERIOD && checks.latestPeriod !== EXPECTED_LATEST_PERIOD) {
    throw new Error(`${label}: Expected ${EXPECTED_LATEST_PERIOD}, received ${checks.latestPeriod}.`);
  }
  if (checks.bodyOverflowX || checks.clippedPanels !== 0 || checks.xAxisLabelOverlapCount !== 0) {
    throw new Error(`${label}: Layout overflow, clipping, or overlapping X-axis labels.`);
  }
}

async function runChecks(cdp, label) {
  const baseChecks = await readLayout(cdp);
  assertLayout(baseChecks, label);
  if (baseChecks.levelPointCount !== baseChecks.expectedMonthlyPoints ||
      baseChecks.latestSelectedPeriod !== baseChecks.latestPeriod) {
    throw new Error(`${label}: The latest month is not rendered and selected.`);
  }
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(SCREENSHOT_DIR, `${label}.png`), Buffer.from(screenshot.data, "base64"));

  const clickDetail = await evaluate(
    cdp,
    `(() => {
      const point = document.querySelector('#levelChart [data-chart-point]');
      if (!point) return { clicked: false, detail: '' };
      point.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return {
        clicked: true,
        selectedCount: document.querySelectorAll('#levelChart .chart-point.selected').length,
        detail: document.querySelector('#levelPointDetail')?.innerText || '',
      };
    })()`,
  );

  const keyboardDetail = await evaluate(
    cdp,
    `(() => {
      const point = document.querySelector('#growthChart [data-chart-point]');
      if (!point) return { activated: false, detail: '' };
      point.focus();
      point.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return {
        activated: true,
        selectedCount: document.querySelectorAll('#growthChart .chart-point.selected').length,
        detail: document.querySelector('#growthPointDetail')?.innerText || '',
      };
    })()`,
  );

  const countryView = await evaluate(
    cdp,
    `(() => {
      const select = document.querySelector('#dimensionSelect');
      select.value = 'country';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          labels: document.querySelectorAll('#entityList label').length,
          checked: document.querySelectorAll('#entityList input:checked').length,
          levelPoints: document.querySelectorAll('#levelChart [data-chart-point]').length,
          tableRows: document.querySelectorAll('#dataTableBody tr').length,
        }), 250);
      });
    })()`,
  );

  if (!clickDetail.clicked || clickDetail.selectedCount !== 1 ||
      !keyboardDetail.activated || keyboardDetail.selectedCount !== 1 || countryView.checked !== 10) {
    throw new Error(`${label}: Chart interaction or country selection failed.`);
  }
  const views = [];
  for (const view of [
    { dimension: "country", period: "month", metric: "value" },
    { dimension: "continent", period: "month", metric: "value" },
    { dimension: "total", period: "quarter", metric: "value" },
    { dimension: "total", period: "year", metric: "value" },
    { dimension: "total", period: "month", metric: "quantity" },
  ]) {
    await evaluate(cdp, `(() => {
      const view = ${JSON.stringify(view)};
      const dimension = document.querySelector('#dimensionSelect');
      dimension.value = view.dimension;
      dimension.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-period="' + view.period + '"]').click();
      const metric = document.querySelector('#metricSelect');
      metric.value = view.metric;
      metric.dispatchEvent(new Event('change', { bubbles: true }));
      return new Promise((resolve) => setTimeout(resolve, 80));
    })()`);
    const layout = await readLayout(cdp);
    assertLayout(layout, `${label}/${view.dimension}/${view.period}/${view.metric}`);
    views.push({ ...view, levelPoints: layout.levelPointCount, growthPoints: layout.growthPointCount,
      bodyOverflowX: layout.bodyOverflowX, clippedPanels: layout.clippedPanels,
      xAxisLabelOverlapCount: layout.xAxisLabelOverlapCount });
  }
  return { label, baseChecks, clickDetail, keyboardDetail, countryView, views };
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    throw new Error(`Microsoft Edge not found at ${EDGE}`);
  }
  const port = await findFreePort();
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const edge = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--window-size=1440,1200",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  try {
    const version = await waitForDebugger(port);
    const target = await waitForPageTarget(port);
    const cdp = createCdpClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const checks = {};
    for (const viewport of [
      { key: "desktop", width: 1440, height: 1200, mobile: false },
      { key: "tablet", width: 826, height: 1200, mobile: false },
      { key: "mobile", width: 390, height: 1600, mobile: true },
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
      });
      await loadPage(cdp, DASHBOARD_URL);
      checks[viewport.key] = await runChecks(cdp, `${viewport.key}-${viewport.width}x${viewport.height}`);
    }

    cdp.close();
    const results = {
      url: DASHBOARD_URL,
      checkedAtUtc: new Date().toISOString(),
      edge: version.Browser,
      ...checks,
    };
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), "utf8");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    edge.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
