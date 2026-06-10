const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DASHBOARD_URL = "http://127.0.0.1:8778/";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT_DIR = path.join(ROOT, "outputs", "dashboard");
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

async function runChecks(cdp, label) {
  const baseChecks = await evaluate(
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
        kpiCount: document.querySelectorAll('.kpi').length,
        levelPointCount: document.querySelectorAll('#levelChart [data-chart-point]').length,
        growthPointCount: document.querySelectorAll('#growthChart [data-chart-point]').length,
        tableRows: document.querySelectorAll('#dataTableBody tr').length,
        sourceItems: document.querySelectorAll('.source-item').length,
        sortControls: document.querySelectorAll('.table-controls select').length,
        bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
        clippedPanels: rects.filter((rect) => rect.left < -2 || rect.right > window.innerWidth + 2).length,
        chartSvgCount: document.querySelectorAll('.chart svg').length,
      };
    })()`,
  );

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

  return { label, baseChecks, clickDetail, keyboardDetail, countryView };
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    throw new Error(`Microsoft Edge not found at ${EDGE}`);
  }
  const port = await findFreePort();
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const edge = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--window-size=1440,1200",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const version = await waitForDebugger(port);
    const target = await waitForPageTarget(port);
    const cdp = createCdpClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await loadPage(cdp, DASHBOARD_URL);
    const desktop = await runChecks(cdp, "desktop-1440x1200");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 1600,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await loadPage(cdp, DASHBOARD_URL);
    const mobile = await runChecks(cdp, "mobile-390x1600");

    cdp.close();
    const results = {
      url: DASHBOARD_URL,
      checkedAtUtc: new Date().toISOString(),
      edge: version.Browser,
      desktop,
      mobile,
    };
    fs.writeFileSync(path.join(OUT_DIR, "qa-results.json"), JSON.stringify(results, null, 2), "utf8");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    edge.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
