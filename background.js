const REVIEW_URL = "https://platform.21-school.ru/calendar/review/*";
const ALARM_PREFIX = "s21-review-refresh:";
const STATE_PREFIX = "s21-review-run:";
const LOADING_TIMEOUT_MS = 90_000;
const INTERVALS = new Set([
  ...Array.from({ length: 15 }, (_, index) => index + 1),
  30, 60, 120, 180, 240, 300, 600, 1800
]);
const activeCycles = new Map();
const tabLocks = new Map();

function withTabLock(tabId, action) {
  const previous = tabLocks.get(tabId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(action);
  tabLocks.set(tabId, operation);
  const release = () => {
    if (tabLocks.get(tabId) === operation) tabLocks.delete(tabId);
  };
  void operation.then(release, release);
  return operation;
}

function isReviewUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://platform.21-school.ru" &&
      /^\/calendar\/review\/[^/]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeConfig(value) {
  const selected = value?.selected ?? {};
  const clearMode = ["keep", "selected", "all"].includes(value?.clearMode)
    ? value.clearMode
    : value?.clearBeforeRefresh === true ? "selected" : "keep";
  return {
    intervalSeconds: INTERVALS.has(value?.intervalSeconds)
      ? value.intervalSeconds
      : 60,
    clearMode,
    selected: {
      own: selected.own === true,
      registered: selected.registered === true,
      freeAndCount: selected.freeAndCount === true
    }
  };
}

function stateKey(tabId) { return `${STATE_PREFIX}${tabId}`; }
function alarmName(tabId) { return `${ALARM_PREFIX}${tabId}`; }

async function scheduleAlarm(tabId, nextAt) {
  // Chrome alarms have a 30-second floor. For shorter intervals the content
  // script sends the timely tick; this alarm is a fallback for sleeping tabs.
  await chrome.alarms.create(alarmName(tabId), {
    when: Math.max(nextAt, Date.now() + 30_000)
  });
}

async function getState(tabId) {
  const key = stateKey(tabId);
  const state = (await chrome.storage.session.get(key))[key];
  return state ? { ...state, config: normalizeConfig(state.config) } : null;
}

async function putState(tabId, state) {
  await chrome.storage.session.set({ [stateKey(tabId)]: state });
}

async function sendState(tabId, state) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "S21_STATE", state });
  } catch {
    // The tab may be navigating or already closed.
  }
}

async function stopRunUnlocked(tabId, expectedRunId) {
  if (expectedRunId && (await getState(tabId))?.runId !== expectedRunId) return;
  activeCycles.delete(tabId);
  await chrome.alarms.clear(alarmName(tabId));
  await chrome.storage.session.remove(stateKey(tabId));
  await sendState(tabId, null);
}

function stopRun(tabId, expectedRunId) {
  return withTabLock(tabId, () => stopRunUnlocked(tabId, expectedRunId));
}

async function startRun(tabId, rawConfig, oneShot = false) {
  const config = normalizeConfig(rawConfig);
  if (!Object.values(config.selected).some(Boolean)) {
    return { ok: false, error: "Выбери хотя бы один пункт" };
  }
  let newRunId;
  const response = await withTabLock(tabId, async () => {
    const existing = await getState(tabId);
    if (existing) return { ok: true, state: existing };

    const now = Date.now();
    const state = {
      runId: crypto.randomUUID(),
      config,
      oneShot,
      phase: oneShot ? "loading" : "waiting",
      waitingStartedAt: now,
      nextAt: oneShot ? now : now + config.intervalSeconds * 1000,
      ...(oneShot ? {
        cycleId: crypto.randomUUID(),
        loadingStartedAt: now,
        loadingCompleted: 0,
        loadingTotal: Object.values(config.selected).filter(Boolean).length
      } : {}),
      lastResult: null
    };
    await putState(tabId, state);
    try {
      await scheduleAlarm(tabId, oneShot
        ? state.loadingStartedAt + LOADING_TIMEOUT_MS
        : state.nextAt);
      await sendState(tabId, state);
    } catch (error) {
      await chrome.storage.session.remove(stateKey(tabId)).catch(() => {});
      await chrome.alarms.clear(alarmName(tabId)).catch(() => {});
      throw error;
    }
    newRunId = state.runId;
    return { ok: true, state };
  });
  if (oneShot && newRunId) void runCycle(tabId, newRunId).catch(() => {});
  return response;
}

// Chrome serializes this function and runs it inside the site's MAIN world.
// Apollo's active observable queries update the site's own React UI on refetch.
async function refetchInPage(selected, clearMode, runId, cycleId) {
  const operations = {
    own: "calendarGetEvents",
    registered: "calendarGetMyBookings",
    freeAndCount: "calendarGetNameLessStudentTimeslotsForReview"
  };
  const wanted = Object.entries(operations)
    .filter(([key]) => selected[key])
    .map(([, name]) => name);
  const client = window.__APOLLO_CLIENT__;
  if (!client || typeof client.getObservableQueries !== "function") {
    return { status: "unavailable", requested: wanted.length,
      completed: 0, missing: wanted.length, failed: 0 };
  }

  const active = new Map(
    [...client.getObservableQueries("active").values()].map((query) => [
      query.queryName ?? query.options?.query?.definitions
        ?.find((item) => item.kind === "OperationDefinition")?.name?.value,
      query
    ])
  );
  const found = wanted.map((name) => active.get(name)).filter(Boolean);
  const missing = wanted.length - found.length;
  let processed = missing;
  const emitProgress = () => {
    if (!runId) return;
    try {
      window.dispatchEvent(new CustomEvent("s21-refresh-progress", {
        detail: JSON.stringify({ runId, cycleId, completed: processed, total: wanted.length })
      }));
    } catch {
      // Display progress is optional; it must not interrupt a refetch.
    }
  };
  emitProgress();
  let cacheCleared = false;
  if (clearMode !== "keep") {
    const clearNames = clearMode === "all" ? Object.values(operations) : wanted;
    let cleared = 0;
    for (const name of clearNames) {
      const query = active.get(name);
      if (typeof query?.updateQuery !== "function") continue;
      let didClear = false;
      try {
        query.updateQuery((data) => {
          if (name === operations.own &&
              Array.isArray(data?.calendarEventS21?.getMyCalendarEvents)) {
            didClear = true;
            return {
              ...data,
              calendarEventS21: {
                ...data.calendarEventS21,
                getMyCalendarEvents: []
              }
            };
          }
          if (name === operations.registered &&
              Array.isArray(data?.student?.getMyCalendarBookings)) {
            didClear = true;
            return {
              ...data,
              student: { ...data.student, getMyCalendarBookings: [] }
            };
          }
          const review = data?.student?.getNameLessStudentTimeslotsForReview;
          if (name === operations.freeAndCount &&
              Array.isArray(review?.timeSlots) && review.projectReviewsInfo) {
            const info = review.projectReviewsInfo;
            didClear = true;
            return {
              ...data,
              student: {
                ...data.student,
                getNameLessStudentTimeslotsForReview: {
                  ...review,
                  timeSlots: [],
                  projectReviewsInfo: {
                    ...info,
                    reviewByStudentCount: 0,
                    relevantReviewByStudentsCount: 0,
                    reviewByInspectionStaffCount: 0,
                    relevantReviewByInspectionStaffCount: 0
                  }
                }
              }
            };
          }
          return data;
        });
        if (didClear) cleared++;
      } catch {
        // A changed site schema must not prevent selected queries from refetching.
      }
    }
    cacheCleared = cleared === clearNames.length;
  }
  const results = await Promise.allSettled(
    found.map((query) => Promise.resolve().then(() => query.refetch())
      .finally(() => {
        processed++;
        emitProgress();
      })
    )
  );
  const completed = results.filter((result) => result.status === "fulfilled").length;
  const failed = results.length - completed;
  return {
    status: completed === wanted.length ? "ok" : "partial",
    requested: wanted.length,
    completed,
    missing,
    failed,
    cacheCleared
  };
}

async function runCycle(tabId, runId) {
  let transitionRunId;
  let cycle;
  try {
    cycle = await withTabLock(tabId, async () => {
      const state = await getState(tabId);
      if (!state || (runId && state.runId !== runId) ||
          activeCycles.has(tabId)) return null;
      transitionRunId = state.runId;
      const token = crypto.randomUUID();
      if (state.oneShot) {
        if (state.phase !== "loading" || runId !== state.runId) return null;
        activeCycles.set(tabId, token);
        return { state, token };
      }
      if (state.phase !== "waiting" || Date.now() < state.nextAt) return null;
      const loading = {
        ...state,
        phase: "loading",
        cycleId: crypto.randomUUID(),
        loadingStartedAt: Date.now(),
        loadingCompleted: 0,
        loadingTotal: Object.values(state.config.selected).filter(Boolean).length
      };
      await putState(tabId, loading);
      await scheduleAlarm(tabId, loading.loadingStartedAt + LOADING_TIMEOUT_MS);
      await sendState(tabId, loading);
      activeCycles.set(tabId, token);
      return { state: loading, token };
    });
  } catch {
    if (transitionRunId) await stopRun(tabId, transitionRunId).catch(() => {});
    return;
  }
  if (!cycle) return;
  const { state: initial, token } = cycle;
  try {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { await stopRun(tabId, initial.runId); return; }
    if (!isReviewUrl(tab.url)) { await stopRun(tabId, initial.runId); return; }

    let result;
    const requested = Object.values(initial.config.selected).filter(Boolean).length;
    if (tab.status === "loading") {
      result = { status: "unavailable", requested, completed: 0,
        missing: requested, failed: 0 };
    } else {
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: refetchInPage,
          args: [initial.config.selected, initial.config.clearMode,
            initial.runId, initial.cycleId]
        });
        result = injection?.result ?? { status: "unavailable", requested,
          completed: 0, missing: requested, failed: 0 };
      } catch {
        result = { status: "unavailable", requested, completed: 0,
          missing: requested, failed: 0 };
      }
    }

    await withTabLock(tabId, async () => {
      const current = await getState(tabId);
      if (!current || current.runId !== initial.runId ||
          current.phase !== "loading" ||
          current.cycleId !== initial.cycleId) return;
      if (current.oneShot) {
        await stopRunUnlocked(tabId, initial.runId);
        return;
      }

      const now = Date.now();
      const next = {
        ...current,
        phase: "waiting",
        cycleId: null,
        waitingStartedAt: now,
        nextAt: now + current.config.intervalSeconds * 1000,
        lastResult: { ...result, at: now }
      };
      await putState(tabId, next);
      await scheduleAlarm(tabId, next.nextAt);
      await sendState(tabId, next);
    });
  } catch {
    await stopRun(tabId, initial.runId);
  } finally {
    if (activeCycles.get(tabId) === token) activeCycles.delete(tabId);
  }
}

async function handleAlarm(tabId) {
  const recovered = await withTabLock(tabId, async () => {
    const state = await getState(tabId);
    if (state?.phase !== "loading") return false;
    const deadline = state.loadingStartedAt + LOADING_TIMEOUT_MS;
    if (Date.now() < deadline) {
      await scheduleAlarm(tabId, deadline);
      return true;
    }
    activeCycles.delete(tabId);
    if (state.oneShot) {
      await stopRunUnlocked(tabId, state.runId);
      return true;
    }
    const now = Date.now();
    const requested = Object.values(state.config.selected).filter(Boolean).length;
    const next = {
      ...state,
      phase: "waiting",
      cycleId: null,
      waitingStartedAt: now,
      nextAt: now + state.config.intervalSeconds * 1000,
      lastResult: {
        status: "timeout", requested, completed: 0,
        missing: 0, failed: requested, cacheCleared: false, at: now
      }
    };
    await putState(tabId, next);
    await scheduleAlarm(tabId, next.nextAt);
    await sendState(tabId, next);
    return true;
  });
  if (!recovered) await runCycle(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["S21_GET_STATE", "S21_START", "S21_RUN_ONCE", "S21_STOP", "S21_TICK"].includes(message?.type)) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    sendResponse({ ok: false, error: "Нет вкладки календаря" });
    return;
  }

  (async () => {
    if (message.type === "S21_GET_STATE") {
      return { ok: true, state: await getState(tabId) };
    }
    if (message.type === "S21_STOP") {
      await stopRun(tabId);
      return { ok: true, state: null };
    }
    if (!isReviewUrl(sender.tab.url)) {
      return { ok: false, error: "Открой страницу ревью" };
    }
    if (message.type === "S21_TICK") {
      await runCycle(tabId, message.runId);
      return { ok: true };
    }
    return startRun(tabId, message.config, message.type === "S21_RUN_ONCE");
  })().then(sendResponse, () => sendResponse({ ok: false, error: "Ошибка расширения" }));
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
  if (Number.isInteger(tabId)) await handleAlarm(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => { void stopRun(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && !isReviewUrl(change.url)) void stopRun(tabId);
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.clear("refresh-review-calendar");
  const saved = await chrome.storage.local.get(["draft", "intervalSeconds"]);
  if (!saved.draft) {
    await chrome.storage.local.set({ draft: {
      intervalSeconds: INTERVALS.has(saved.intervalSeconds) ? saved.intervalSeconds : 60,
      selected: { own: true, registered: true, freeAndCount: true }
    } });
  }
  // Show the panel on review tabs that were already open during installation.
  const tabs = await chrome.tabs.query({ url: REVIEW_URL });
  for (const tab of tabs) {
    if (tab.id === undefined || tab.status === "loading") continue;
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => Boolean(document.getElementById("s21-refresh-panel"))
      });
      if (probe?.result) continue;
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id }, files: ["panel.css"]
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: ["content.js"]
      });
    } catch {
      // A tab may navigate while the extension is being installed.
    }
  }
});
