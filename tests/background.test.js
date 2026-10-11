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
  const insertedCSS = [];
  let historyStateListener;
  let completedListener;
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
      executeScript(details) {
        return new Promise((resolve) => injections.push({ resolve, details }));
      },
      async insertCSS(details) { insertedCSS.push(details); }
    },
    webNavigation: {
      onCompleted: {
        addListener(callback) { completedListener = callback; }
      },
      onHistoryStateUpdated: {
        addListener(callback) { historyStateListener = callback; }
      }
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
    sandbox, chrome, states, alarms, messages, injections, insertedCSS,
    navigationCompleted(details) { completedListener(details); },
    historyStateUpdated(details) { historyStateListener(details); },
    async waitForInjection() {
      for (let attempt = 0; attempt < 100 && !injections.length; attempt++) await pause();
      assert.ok(injections.length, "the GraphQL refresh was started");
    },
    finishInjection(result = {
        status: "ok", requested: 1, completed: 1,
        missing: 0, failed: 0, cacheCleared: true
    }) {
      const injection = injections.shift();
      assert.ok(injection);
      injection.resolve([{ result }]);
    }
  };
}

test("history navigation into a review page injects the panel once", async () => {
  const h = createHarness();
  const details = { tabId: 1, frameId: 0,
    url: "https://platform.21-school.ru/calendar/review/69046" };
  h.historyStateUpdated({ ...details, frameId: 1 });
  h.historyStateUpdated(details);
  h.historyStateUpdated(details);
  await h.waitForInjection();
  assert.equal(h.injections.length, 1);
  assert.equal(typeof h.injections[0].details.func, "function");
  h.finishInjection(false);
  await h.waitForInjection();
  assert.equal(h.insertedCSS.length, 1);
  assert.equal(h.injections[0].details.files[0], "content.js");
  h.finishInjection();
  await pause();
  h.historyStateUpdated(details);
  await h.waitForInjection();
  h.finishInjection(true);
  await pause();
  assert.equal(h.insertedCSS.length, 1);
  assert.equal(h.injections.length, 0);
  assert.equal(h.messages.at(-1).type, "S21_ROUTE_CHANGED");
  h.historyStateUpdated({ ...details, url: "https://platform.21-school.ru/calendar" });
  await pause();
  assert.equal(h.messages.filter((message) => message.type === "S21_ROUTE_CHANGED")
    .length, 2);
});

test("direct load and history navigation share the panel injection path", async () => {
  const h = createHarness();
  const details = { tabId: 1, frameId: 0,
    url: "https://platform.21-school.ru/calendar/review/69046" };
  h.navigationCompleted(details);
  h.historyStateUpdated(details);
  await h.waitForInjection();
  assert.equal(h.injections.length, 1);
  h.finishInjection(false);
  await h.waitForInjection();
  assert.equal(h.insertedCSS.length, 1);
  assert.equal(h.injections[0].details.files[0], "content.js");
  h.finishInjection();
  await pause();
  assert.equal(h.injections.length, 0);
  assert.equal(h.insertedCSS.length, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json")));
  assert.equal(manifest.content_scripts, undefined);
});

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

test("auto booking needs free slots and a supported time horizon", () => {
  const h = createHarness();
  const selected = { own: false, registered: false, freeAndCount: true };
  const normalize = h.sandbox.normalizeConfig;
  assert.equal(normalize({ selected }).autoBooking.enabled, false);
  assert.equal(normalize({ selected }).autoBooking.type, "online");
  assert.equal(normalize({ selected, autoBooking: { type: "offline" } })
    .autoBooking.type, "offline");
  assert.equal(normalize({ selected, autoBooking: { type: "other" } })
    .autoBooking.type, "online");
  assert.equal(normalize({ selected, autoBooking: {
    enabled: true, horizonHours: 168
  } }).autoBooking.horizonHours, 168);
  assert.equal(normalize({ selected, autoBooking: {
    enabled: true, horizonHours: 25
  } }).autoBooking.horizonHours, 24);
  assert.equal(normalize({ selected: { ...selected, freeAndCount: false },
    autoBooking: { enabled: true, horizonHours: 24 } }).autoBooking.enabled, false);
});

test("booking uses the site's mutation for the earliest valid start time", async () => {
  const h = createHarness();
  const staffSooner = new Date(Date.now() + 15 * 60_000).toISOString();
  const sooner = new Date(Date.now() + 30 * 60_000).toISOString();
  const later = new Date(Date.now() + 90 * 60_000).toISOString();
  let mutation;
  const queries = [{
    queryName: "calendarGetModule",
    variables: { moduleId: "69046" },
    getCurrentResult: () => ({ data: { student: { getModuleById: {
      currentTask: { taskId: "task-1", lastAnswer: { id: "answer-1" } }
    } } } })
  }, {
    queryName: "calendarGetNameLessStudentTimeslotsForReview",
    variables: { taskId: "task-1" },
    getCurrentResult: () => ({ data: { student: {
      getNameLessStudentTimeslotsForReview: {
        projectReviewsInfo: {
          relevantReviewByStudentsCount: 2, reviewByStudentCount: 3,
          relevantReviewByInspectionStaffCount: 0, reviewByInspectionStaffCount: 1
        },
        timeSlots: [
          { staffSlot: true, validStartTimes: [staffSooner] },
          { staffSlot: false, validStartTimes: [later, sooner] }
        ]
      }
    } } })
  }];
  h.sandbox.window = {
    location: { pathname: "/calendar/review/69046" },
    __APOLLO_CLIENT__: {
      getObservableQueries: () => new Map(queries.map((query, index) => [index, query])),
      async mutate(options) {
        mutation = options;
        return { data: { student: { addBookingP2PToEventSlot: { id: "booking-1" } } } };
      }
    }
  };

  const result = await h.sandbox.bookOneInPage(1, "online", []);
  assert.equal(result.status, "booked");
  assert.equal(result.startTime, sooner);
  assert.equal(mutation.variables.answerId, "answer-1");
  assert.equal(mutation.variables.startTime, sooner);
  assert.equal(mutation.variables.wasStaffSlotChosen, false);
  assert.equal(mutation.variables.isOnline, true);
  assert.equal(mutation.mutation.definitions[0].name.value,
    "calendarAddBookingToEventSlot");

  assert.equal((await h.sandbox.bookOneInPage(1, "online", [result.key])).status,
    "no_slots");
  assert.equal((await h.sandbox.bookOneInPage(2, "online", [result.key]))
    .startTime, later);
  await h.sandbox.bookOneInPage(1, "offline", []);
  assert.equal(mutation.variables.isOnline, false);
  assert.equal(mutation.variables.wasStaffSlotChosen, false);
  assert.equal(mutation.variables.startTime, sooner);
  mutation = null;
  h.sandbox.window.location.pathname = "/calendar/review/another-project";
  assert.equal((await h.sandbox.bookOneInPage(2, "online", [])).status,
    "missing_context");
  assert.equal(mutation, null);
});

test("booking stops when the required review count is reached", async () => {
  const h = createHarness();
  const start = new Date(Date.now() + 30 * 60_000).toISOString();
  h.sandbox.window = {
    location: { pathname: "/calendar/review/69046" },
    __APOLLO_CLIENT__: {
      getObservableQueries: () => new Map([
        [1, { queryName: "calendarGetModule", variables: { moduleId: "69046" },
          getCurrentResult: () => ({ data: { student: { getModuleById: {
            currentTask: { taskId: "task-1", lastAnswer: { id: "answer-1" } }
          } } } }) }],
        [2, { queryName: "calendarGetNameLessStudentTimeslotsForReview",
          variables: { taskId: "task-1" },
          getCurrentResult: () => ({ data: { student: {
            getNameLessStudentTimeslotsForReview: {
              projectReviewsInfo: {
                relevantReviewByStudentsCount: 3, reviewByStudentCount: 3,
                relevantReviewByInspectionStaffCount: 0, reviewByInspectionStaffCount: 1
              },
              timeSlots: [{ staffSlot: false, validStartTimes: [start] }]
            }
          } } }) }]
      ]),
      mutate() { throw new Error("must not book beyond quota"); }
    }
  };
  const result = await h.sandbox.bookOneInPage(1, "online", []);
  assert.equal(result.status, "complete");
  assert.equal(result.current, 3);
  assert.equal(result.target, 3);
});

test("booking checks PRP for the student and teammates before mutation", async () => {
  const h = createHarness();
  const start = new Date(Date.now() + 30 * 60_000).toISOString();
  let balance = 1;
  let teammateBalance = 1;
  let mutations = 0;
  let experienceQueries = 0;
  const queries = [{
    queryName: "calendarGetModule", variables: { moduleId: "69046" },
    getCurrentResult: () => ({ data: { student: { getModuleById: {
      currentTask: { taskId: "task-1", lastAnswer: { id: "answer-1" },
        task: { assignmentType: "GROUP",
          studentTaskAdditionalAttributes: { cookiesCount: 2 } } }
    } } } })
  }, {
    queryName: "calendarGetNameLessStudentTimeslotsForReview",
    variables: { taskId: "task-1" },
    getCurrentResult: () => ({ data: { student: {
      getNameLessStudentTimeslotsForReview: {
        projectReviewsInfo: {
          relevantReviewByStudentsCount: 0, reviewByStudentCount: 1
        },
        timeSlots: [{ staffSlot: false, validStartTimes: [start] }]
      }
    } } })
  }, {
    queryName: "getProjectTeamMembers",
    refetch: async () => ({ data: { student: { getProjectTeamMembers: {
      members: [{ userExperience: { cookiesCount: teammateBalance } }]
    } } } })
  }];
  h.sandbox.window = {
    location: { pathname: "/calendar/review/69046" },
    __APOLLO_CLIENT__: {
      getObservableQueries: () => new Map(queries.map((query, index) => [index, query])),
      async query(options) {
        experienceQueries++;
        assert.equal(options.fetchPolicy, "network-only");
        assert.equal(options.query.definitions[0].name.value,
          "calendarGetStudentExperience");
        return { data: { student: { getExperience: { cookiesCount: balance } } } };
      },
      async mutate() {
        mutations++;
        return { data: { student: { addBookingP2PToEventSlot: { id: "booking-1" } } } };
      }
    }
  };
  assert.equal((await h.sandbox.bookOneInPage(1, "online", [], false)).status,
    "insufficient_prp");
  assert.equal(mutations, 0);
  balance = 2;
  assert.equal((await h.sandbox.bookOneInPage(1, "online", [], false)).status,
    "insufficient_prp");
  assert.equal(mutations, 0);
  teammateBalance = 2;
  assert.equal((await h.sandbox.bookOneInPage(1, "online", [], false)).status,
    "booked");
  assert.equal(mutations, 1);
  assert.equal(experienceQueries, 3);
});

test("auto booking refreshes between signups and finishes its one-shot run", async () => {
  const h = createHarness();
  const bookingConfig = {
    intervalSeconds: 5,
    clearMode: "keep",
    selected: { own: false, registered: false, freeAndCount: true },
    autoBooking: { enabled: true, horizonHours: 24 }
  };
  await h.sandbox.startRun(1, bookingConfig, true);
  await h.waitForInjection();
  assert.equal(h.injections[0].details.func.name, "refetchInPage");
  h.finishInjection({ status: "ok", requested: 1, completed: 1,
    missing: 0, failed: 0, freeUpdated: true });
  await h.waitForInjection();
  assert.equal(h.injections[0].details.func.name, "bookOneInPage");
  assert.equal(h.injections[0].details.args[3], false);
  assert.equal(h.injections[0].details.args[1], "online");
  h.finishInjection({ status: "booked", key: "student:slot-1",
    startTime: "slot-1", current: 2, target: 3, prpChecked: true });
  await h.waitForInjection();
  assert.equal(h.injections[0].details.func.name, "refetchInPage");
  h.finishInjection({ status: "ok", requested: 1, completed: 1,
    missing: 0, failed: 0, freeUpdated: true });
  await h.waitForInjection();
  assert.equal(h.injections[0].details.func.name, "bookOneInPage");
  assert.equal(h.injections[0].details.args[3], false);
  h.finishInjection({ status: "complete", current: 3, target: 3 });
  for (let attempt = 0; attempt < 100 && h.states.has(stateKey); attempt++) await pause();
  assert.equal(h.states.has(stateKey), false);
  assert.equal(h.alarms.size, 0);
});

test("stop during a booking prevents another refresh or booking", async () => {
  const h = createHarness();
  await h.sandbox.startRun(1, {
    intervalSeconds: 5,
    clearMode: "keep",
    selected: { own: false, registered: false, freeAndCount: true },
    autoBooking: { enabled: true, horizonHours: 24 }
  }, true);
  await h.waitForInjection();
  h.finishInjection({ status: "ok", requested: 1, completed: 1,
    missing: 0, failed: 0, freeUpdated: true });
  await h.waitForInjection();
  assert.equal(h.injections[0].details.func.name, "bookOneInPage");
  await h.sandbox.stopRun(1);
  h.finishInjection({ status: "booked", key: "student:slot-1",
    startTime: "slot-1", current: 2, target: 3 });
  for (let attempt = 0; attempt < 10; attempt++) await pause();
  assert.equal(h.injections.length, 0);
  assert.equal(h.states.has(stateKey), false);
});

test("timer keeps running after the review quota is full", async () => {
  const h = createHarness();
  await h.sandbox.startRun(1, {
    intervalSeconds: 5,
    clearMode: "keep",
    selected: { own: false, registered: false, freeAndCount: true },
    autoBooking: { enabled: true, horizonHours: 24 }
  });
  h.states.get(stateKey).nextAt = Date.now() - 1;
  const cycle = h.sandbox.runCycle(1);
  await h.waitForInjection();
  h.finishInjection({ status: "ok", requested: 1, completed: 1,
    missing: 0, failed: 0, freeUpdated: true });
  await h.waitForInjection();
  h.finishInjection({ status: "complete", current: 3, target: 3 });
  await cycle;
  assert.equal(h.states.get(stateKey).phase, "waiting");
  assert.equal(h.states.get(stateKey).lastBooking.status, "complete");
  assert.equal(h.alarms.size, 1);
});

test("a failed slot is skipped without refreshing before the next attempt", async () => {
  const h = createHarness();
  await h.sandbox.startRun(1, {
    intervalSeconds: 5,
    clearMode: "keep",
    selected: { own: false, registered: false, freeAndCount: true },
    autoBooking: { enabled: true, horizonHours: 24 }
  }, true);
  await h.waitForInjection();
  h.finishInjection({ status: "ok", requested: 1, completed: 1,
    missing: 0, failed: 0, freeUpdated: true });
  await h.waitForInjection();
  h.finishInjection({ status: "failed", key: "student:slot-1",
    startTime: "slot-1", current: 2, target: 3, prpChecked: true });
  await h.waitForInjection();
  assert.equal(h.injections[0].details.func.name, "bookOneInPage");
  assert.ok(h.injections[0].details.args[2].includes("student:slot-1"));
  assert.equal(h.injections[0].details.args[3], true);
  h.finishInjection({ status: "booked", key: "student:slot-2",
    startTime: "slot-2", current: 2, target: 3 });
  await h.waitForInjection();
  assert.equal(h.injections[0].details.func.name, "refetchInPage");
  h.finishInjection({ status: "ok", requested: 1, completed: 1,
    missing: 0, failed: 0, freeUpdated: true });
  await h.waitForInjection();
  h.finishInjection({ status: "complete", current: 3, target: 3 });
  for (let attempt = 0; attempt < 100 && h.states.has(stateKey); attempt++) await pause();
  assert.equal(h.states.has(stateKey), false);
});
