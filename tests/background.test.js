const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const config = {
  intervalSeconds: 5,
  clearMode: "all",
  selected: { own: true, registered: false, freeAndCount: false }
};
const stateKey = "s21-review-run:1";
const pause = () => new Promise((resolve) => setImmediate(resolve));

function createHarness() {
  const states = new Map();
  const alarms = new Map();
  const messages = [];
  const injections = [];
  const listener = { addListener() {} };
  const chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: states.get(key) }; },
        async set(entries) {
          for (const [key, value] of Object.entries(entries)) states.set(key, value);
        },
        async remove(key) { states.delete(key); }
      },
      local: { async get() { return {}; }, async set() {} }
    },
    alarms: {
      async create(name, details) { alarms.set(name, details); },
      async clear(name) { alarms.delete(name); },
      onAlarm: listener
    },
    tabs: {
      async get() {
        return { url: "https://platform.21-school.ru/calendar/review/69046", status: "complete" };
      },
      async sendMessage(_tabId, message) { messages.push(message); },
      async query() { return []; },
      onRemoved: listener,
      onUpdated: listener
    },
    scripting: {
      executeScript() {
        return new Promise((resolve) => injections.push(resolve));
      },
      async insertCSS() {}
    },
    runtime: { onMessage: listener, onInstalled: listener }
  };
  const sandbox = {
    chrome,
    crypto: { randomUUID },
    URL,
    Date,
    Set,
    Map,
    Promise,
    Object,
    Array,
    Number
  };
  vm.runInNewContext(source, sandbox);
  return {
    sandbox, chrome, states, alarms, messages, injections,
    async waitForInjection() {
      for (let attempt = 0; attempt < 100 && !injections.length; attempt++) await pause();
      assert.ok(injections.length, "the GraphQL refresh was started");
    },
    finishInjection() {
      const resolve = injections.shift();
      assert.ok(resolve);
      resolve([{ result: {
        status: "ok", requested: 1, completed: 1,
        missing: 0, failed: 0, cacheCleared: true
      } }]);
    }
  };
}

test("one-shot run finishes and clears its watchdog alarm", async () => {
  const h = createHarness();
  const response = await h.sandbox.startRun(1, config, true);
  assert.equal(response.state.phase, "loading");
  assert.equal(response.state.loadingTotal, 1);
  assert.equal(h.alarms.size, 1);
  await h.waitForInjection();
  h.finishInjection();
  for (let attempt = 0; attempt < 100 && h.states.has(stateKey); attempt++) await pause();
  assert.equal(h.states.has(stateKey), false);
  assert.equal(h.alarms.size, 0);
  assert.equal(h.messages.at(-1).state, null);
});

test("a stopped run cannot clear a newer run when its request finishes", async () => {
  const h = createHarness();
  await h.sandbox.startRun(1, config, true);
  await h.waitForInjection();
  await h.sandbox.stopRun(1);
  const next = await h.sandbox.startRun(1, config);
  h.finishInjection();
  await pause();
  assert.equal(h.states.get(stateKey).runId, next.state.runId);
  assert.equal(h.states.get(stateKey).phase, "waiting");
});

test("timer cycle returns to waiting and schedules its next alarm", async () => {
  const h = createHarness();
  await h.sandbox.startRun(1, config);
  h.states.get(stateKey).nextAt = Date.now() - 1;
  const cycle = h.sandbox.runCycle(1);
  await h.waitForInjection();
  assert.equal(h.states.get(stateKey).phase, "loading");
  h.finishInjection();
  await cycle;
  assert.equal(h.states.get(stateKey).phase, "waiting");
  assert.equal(h.alarms.size, 1);
});

test("start and stop are serialized when clicked together", async () => {
  const h = createHarness();
  const starting = h.sandbox.startRun(1, config, true);
  const stopping = h.sandbox.stopRun(1);
  await Promise.all([starting, stopping]);
  assert.equal(h.states.has(stateKey), false);
  assert.equal(h.alarms.size, 0);
});

test("a failed start leaves no stored run", async () => {
  const h = createHarness();
  h.chrome.alarms.create = async () => { throw new Error("alarm unavailable"); };
  await assert.rejects(h.sandbox.startRun(1, config), /alarm unavailable/);
  assert.equal(h.states.has(stateKey), false);
});

test("a stale one-shot loading state recovers after its watchdog fires", async () => {
  const h = createHarness();
  await h.sandbox.startRun(1, config, true);
  await h.waitForInjection();
  h.states.get(stateKey).loadingStartedAt = Date.now() - 100_000;
  await h.sandbox.handleAlarm(1);
  assert.equal(h.states.has(stateKey), false);
  assert.equal(h.alarms.size, 0);
  h.finishInjection();
  await pause();
  assert.equal(h.states.has(stateKey), false);
});

test("a stale timer loading state resumes waiting", async () => {
  const h = createHarness();
  await h.sandbox.startRun(1, config);
  h.states.get(stateKey).nextAt = Date.now() - 1;
  const cycle = h.sandbox.runCycle(1);
  await h.waitForInjection();
  h.states.get(stateKey).loadingStartedAt = Date.now() - 100_000;
  await h.sandbox.handleAlarm(1);
  assert.equal(h.states.get(stateKey).phase, "waiting");
  assert.equal(h.states.get(stateKey).lastResult.status, "timeout");
  h.finishInjection();
  await cycle;
  assert.equal(h.states.get(stateKey).phase, "waiting");
});

test("a late response cannot finish a newer loading cycle", async () => {
  const h = createHarness();
  await h.sandbox.startRun(1, config);
  h.states.get(stateKey).nextAt = Date.now() - 1;
  const firstCycle = h.sandbox.runCycle(1);
  await h.waitForInjection();
  const firstId = h.states.get(stateKey).cycleId;

  h.states.get(stateKey).loadingStartedAt = Date.now() - 100_000;
  await h.sandbox.handleAlarm(1);
  h.states.get(stateKey).nextAt = Date.now() - 1;
  const secondCycle = h.sandbox.runCycle(1);
  for (let attempt = 0; attempt < 100 && h.injections.length < 2; attempt++) await pause();
  assert.equal(h.injections.length, 2);
  const secondId = h.states.get(stateKey).cycleId;
  assert.notEqual(firstId, secondId);

  h.finishInjection();
  await firstCycle;
  assert.equal(h.states.get(stateKey).phase, "loading");
  assert.equal(h.states.get(stateKey).cycleId, secondId);

  h.finishInjection();
  await secondCycle;
  assert.equal(h.states.get(stateKey).phase, "waiting");
});

test("clearing all resets all results but refetches only selected queries", async () => {
  const h = createHarness();
  const names = [
    "calendarGetEvents",
    "calendarGetMyBookings",
    "calendarGetNameLessStudentTimeslotsForReview"
  ];
  const data = [
    { calendarEventS21: { getMyCalendarEvents: [{ id: "old" }] } },
    { student: { getMyCalendarBookings: [{ id: "old" }] } },
    { student: { getNameLessStudentTimeslotsForReview: {
      timeSlots: [{ id: "old" }],
      projectReviewsInfo: {
        reviewByStudentCount: 2,
        relevantReviewByStudentsCount: 3,
        reviewByInspectionStaffCount: 4,
        relevantReviewByInspectionStaffCount: 5
      }
    } } }
  ];
  const queries = names.map((queryName, index) => ({
    queryName,
    data: data[index],
    calls: 0,
    updateQuery(mapFn) { this.data = mapFn(this.data); },
    async refetch() { this.calls++; }
  }));
  h.sandbox.window = {
    __APOLLO_CLIENT__: {
      getObservableQueries: () => new Map(queries.map((query, index) => [index, query]))
    },
    dispatchEvent() {}
  };
  h.sandbox.CustomEvent = class {};

  const result = await h.sandbox.refetchInPage(config.selected, "all", "test");
  assert.equal(result.cacheCleared, true);
  assert.equal(result.completed, 1);
  assert.deepEqual(queries.map((query) => query.calls), [1, 0, 0]);
  assert.equal(queries[0].data.calendarEventS21.getMyCalendarEvents.length, 0);
  assert.equal(queries[1].data.student.getMyCalendarBookings.length, 0);
  const review = queries[2].data.student.getNameLessStudentTimeslotsForReview;
  assert.equal(review.timeSlots.length, 0);
  assert.equal(review.projectReviewsInfo.reviewByStudentCount, 0);
});

test("keep and selected clearing preserve unselected results", async () => {
  for (const mode of ["keep", "selected"]) {
    const h = createHarness();
    const queries = [
      {
        queryName: "calendarGetEvents",
        data: { calendarEventS21: { getMyCalendarEvents: [{ id: "old" }] } },
        calls: 0,
        updateQuery(mapFn) { this.data = mapFn(this.data); },
        async refetch() { this.calls++; }
      },
      {
        queryName: "calendarGetMyBookings",
        data: { student: { getMyCalendarBookings: [{ id: "old" }] } },
        calls: 0,
        updateQuery(mapFn) { this.data = mapFn(this.data); },
        async refetch() { this.calls++; }
      }
    ];
    h.sandbox.window = {
      __APOLLO_CLIENT__: {
        getObservableQueries: () => new Map(queries.map((query, index) => [index, query]))
      },
      dispatchEvent() {}
    };
    h.sandbox.CustomEvent = class {};
    const result = await h.sandbox.refetchInPage(config.selected, mode, "test");
    assert.equal(result.cacheCleared, mode === "selected");
    assert.deepEqual(queries.map((query) => query.calls), [1, 0]);
    assert.equal(queries[0].data.calendarEventS21.getMyCalendarEvents.length,
      mode === "selected" ? 0 : 1);
    assert.equal(queries[1].data.student.getMyCalendarBookings.length, 1);
  }
});

test("legacy clear configuration is migrated", () => {
  const h = createHarness();
  assert.equal(h.sandbox.normalizeConfig({ clearBeforeRefresh: true }).clearMode,
    "selected");
  assert.equal(h.sandbox.normalizeConfig({ clearMode: "all" }).clearMode, "all");
});
