const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const pause = () => new Promise((resolve) => setImmediate(resolve));

function createElement() {
  let text = "";
  return {
    dataset: {}, style: {}, hidden: false, textWrites: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    get textContent() { return text; },
    set textContent(value) { text = String(value); this.textWrites++; },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    remove() {}, contains() { return false; }
  };
}

function createHarness({ storageFails = false } = {}) {
  const elements = new Map();
  const getElement = (name) => {
    if (!elements.has(name)) elements.set(name, createElement());
    return elements.get(name);
  };
  const panel = createElement();
  panel.querySelector = (selector) => getElement(selector.match(/data-s21="([^"]+)"/)[1]);
  panel.querySelectorAll = () => ["own", "registered", "freeAndCount"].map((name) => {
    const option = getElement(`option:${name}`);
    option.dataset.s21Option = name;
    return option;
  });
  const parent = {
    insertBefore(node, next) {
      node.parentElement = this;
      node.nextElementSibling = next;
    }
  };
  const anchor = { parentElement: parent };
  const listeners = [];
  const intervals = [];
  const clearedIntervals = [];
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } },
        async sendMessage() { return { ok: true, state: null }; }
      },
      storage: {
        local: {
          async get() {
            if (storageFails) throw new Error("storage unavailable");
            return {};
          },
          async set() {}
        },
        onChanged: { addListener() {} }
      }
    },
    document: {
      body: {}, documentElement: {},
      createElement() { return panel; },
      querySelector() { return anchor; }
    },
    location: { origin: "https://platform.21-school.ru", pathname: "/calendar/review/69046" },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle() { return { backgroundColor: "rgb(30, 40, 50)" }; },
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    clearInterval(id) { clearedIntervals.push(id); },
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback) { callback(); },
    Date, Number, Set, Map
  };
  vm.runInNewContext(source, sandbox);
  return {
    sandbox, panel, parent, intervals, clearedIntervals,
    element: (name) => getElement(name),
    send: (message) => listeners[0](message)
  };
}

test("health starts healthy and only changes when an error arrives", async () => {
  const h = createHarness();
  const label = h.element("health-label");
  const time = h.element("health-time");
  assert.equal(h.panel.parentElement, h.parent);
  assert.equal(h.element("health").hidden, false);
  assert.equal(label.textContent, "Проблем нет");
  assert.equal(h.element("start").disabled, true);
  await pause();
  assert.equal(h.element("start").disabled, false);
  const initialTime = time.dateTime;
  assert.equal(h.intervals.length, 0);
  const config = { clearMode: "keep", autoBooking: { enabled: true } };
  const result = (status, at) => ({ status, at, failed: 0, missing: 0 });
  const send = (lastResult, lastBooking) => h.send({
    type: "S21_STATE", state: null,
    final: { config, lastResult, lastBooking }
  });

  send(result("ok", Date.now() + 1000));
  assert.equal(time.dateTime, initialTime);
  h.send({ type: "S21_STATE", state: {
    runId: "run-1", phase: "waiting", nextAt: Date.now() + 60_000,
    waitingStartedAt: Date.now(), lastResult: null,
    config: {
      intervalSeconds: 60, clearMode: "keep",
      selected: { own: true, registered: true, freeAndCount: true },
      autoBooking: { enabled: true, type: "online", horizonHours: 24,
        startHour: 0, endHour: 24 }
    }
  } });
  assert.equal(h.intervals.length, 1);
  const writes = label.textWrites;
  h.intervals[0]();
  assert.equal(label.textWrites, writes);
  h.sandbox.location.pathname = "/calendar";
  h.send({ type: "S21_ROUTE_CHANGED" });
  assert.deepEqual(h.clearedIntervals, [1]);
  h.send({ type: "S21_STATE", state: null });
  assert.deepEqual(h.clearedIntervals, [1]);

  const warningAt = Date.now() + 2000;
  send(result("ok", warningAt), {
    status: "insufficient_prp", reason: "Есть 1 PRP, нужно 2", at: warningAt
  });
  assert.equal(label.textContent, "Недостаточно PRP");
  assert.equal(time.dateTime, new Date(warningAt).toISOString());

  send(result("ok", warningAt + 1000), { status: "booked", at: warningAt + 1000 });
  assert.equal(label.textContent, "Недостаточно PRP");
  assert.equal(time.dateTime, new Date(warningAt).toISOString());

  const nextWarningAt = warningAt + 2000;
  send(result("timeout", nextWarningAt));
  assert.equal(label.textContent, "Превышено время загрузки");
  assert.equal(time.dateTime, new Date(nextWarningAt).toISOString());
});

test("the panel still initializes when saved settings cannot be read", async () => {
  const h = createHarness({ storageFails: true });
  await pause();
  assert.equal(h.sandbox.__school21RefreshPanelInstalled, true);
  assert.equal(h.panel.parentElement, h.parent);
  assert.equal(h.element("health-label").textContent, "Не удалось загрузить настройки");
  assert.equal(h.element("health").hidden, false);
});
