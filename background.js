const REVIEW_URL = "https://platform.21-school.ru/calendar/review/*";
const ALARM_PREFIX = "s21-review-refresh:";
const STATE_PREFIX = "s21-review-run:";
const LOADING_TIMEOUT_MS = 90_000;
const MAX_BOOKING_ATTEMPTS_PER_CYCLE = 20;
const BOOKING_SUCCESS_COOLDOWN_MS = 600_000;
const BOOKING_FAILURE_COOLDOWN_MS = 60_000;
const INTERVALS = new Set([
  ...Array.from({ length: 15 }, (_, index) => index + 1),
  30, 60, 120, 180, 240, 300, 600, 1800
]);
const BOOKING_HOURS = new Set([
  ...Array.from({ length: 24 }, (_, index) => index + 1),
  ...Array.from({ length: 6 }, (_, index) => (index + 2) * 24)
]);
const activeCycles = new Map();
const tabLocks = new Map();
const panelInjections = new Map();

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
  const freeAndCount = selected.freeAndCount === true;
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
      freeAndCount
    },
    autoBooking: {
      enabled: freeAndCount && value?.autoBooking?.enabled === true,
      type: value?.autoBooking?.type === "offline" ? "offline" : "online",
      horizonHours: BOOKING_HOURS.has(value?.autoBooking?.horizonHours)
        ? value.autoBooking.horizonHours : 24,
      startHour: Number.isInteger(value?.autoBooking?.startHour) &&
        value.autoBooking.startHour >= 0 && value.autoBooking.startHour < 24
        ? value.autoBooking.startHour : 0,
      endHour: Number.isInteger(value?.autoBooking?.endHour) &&
        value.autoBooking.endHour >= 0 && value.autoBooking.endHour <= 24
        ? value.autoBooking.endHour : 24
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

async function sendState(tabId, state, final) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "S21_STATE", state, ...(final ? { final } : {})
    });
  } catch {
    // The tab may be navigating or already closed.
  }
}

async function stopRunUnlocked(tabId, expectedRunId, finalResult) {
  const current = await getState(tabId);
  if (expectedRunId && current?.runId !== expectedRunId) return;
  activeCycles.delete(tabId);
  await chrome.alarms.clear(alarmName(tabId));
  await chrome.storage.session.remove(stateKey(tabId));
  await sendState(tabId, null, current && {
    runId: current.runId,
    config: current.config,
    lastBooking: current.lastBooking,
    lastResult: finalResult
      ? { ...finalResult, at: Date.now() }
      : current.lastResult
  });
}

function stopRun(tabId, expectedRunId, finalResult) {
  return withTabLock(tabId, () => stopRunUnlocked(tabId, expectedRunId, finalResult));
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
  const foundEntries = wanted.map((name) => [name, active.get(name)])
    .filter(([, query]) => Boolean(query));
  const found = foundEntries.map(([, query]) => query);
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
  const freeIndex = foundEntries.findIndex(([name]) => name === operations.freeAndCount);
  return {
    status: completed === wanted.length ? "ok" : "partial",
    requested: wanted.length,
    completed,
    missing,
    failed,
    cacheCleared,
    freeUpdated: freeIndex >= 0 && results[freeIndex].status === "fulfilled"
  };
}

// Runs in the site's MAIN world after a successful free-slot refetch. The
// mutation and variables mirror the site's SignUpCard; Apollo supplies its
// existing authentication and handles the server's normal validation.
async function bookOneInPage(horizonHours, bookingType, excludedKeys, prpChecked,
  startHour = 0, endHour = 24) {
  const client = window.__APOLLO_CLIENT__;
  if (!client || typeof client.mutate !== "function" ||
      typeof client.getObservableQueries !== "function") {
    return { status: "unavailable" };
  }
  const queries = [...client.getObservableQueries("active").values()];
  const findQuery = (name) => queries.find((query) =>
    (query.queryName ?? query.options?.query?.definitions
      ?.find((part) => part.kind === "OperationDefinition")?.name?.value) === name);
  const freeQuery = findQuery("calendarGetNameLessStudentTimeslotsForReview");
  const moduleQuery = findQuery("calendarGetModule");
  const review = freeQuery?.getCurrentResult()?.data?.student
    ?.getNameLessStudentTimeslotsForReview;
  const module = moduleQuery?.getCurrentResult()?.data?.student?.getModuleById;
  const task = module?.currentTask;
  const answerId = task?.lastAnswer?.id;
  const moduleId = moduleQuery?.variables?.moduleId ??
    moduleQuery?.options?.variables?.moduleId ?? module?.id;
  const taskId = freeQuery?.variables?.taskId ??
    freeQuery?.options?.variables?.taskId;
  if (!answerId || !task?.taskId || String(task.taskId) !== String(taskId) ||
      String(moduleId) !== window.location.pathname.split("/").filter(Boolean).at(-1) ||
      !Array.isArray(review?.timeSlots)) {
    return { status: "missing_context", reason: "Нет данных модуля или свободных слотов" };
  }

  const info = review.projectReviewsInfo;
  const counts = [info?.relevantReviewByStudentsCount, info?.reviewByStudentCount];
  if (!counts.every((count) => Number.isInteger(count) && count >= 0)) {
    return { status: "missing_context", reason: "Не найден счётчик проверок" };
  }
  const [studentCurrent, studentTarget] = counts;
  const quota = { current: studentCurrent, target: studentTarget };
  const needStudent = studentCurrent < studentTarget;
  if (!needStudent) return { status: "complete", ...quota };
  const durationMinutes = review.checkDuration;
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return { status: "missing_context", reason: "Неизвестна длительность проверки",
      ...quota };
  }

  const now = Date.now();
  const until = now + horizonHours * 3_600_000;
  const durationMs = durationMinutes * 60_000;
  // A full-day window does not exclude reviews that cross midnight.
  const allDay = startHour === endHour || (startHour === 0 && endHour === 24);
  const excluded = new Set(excludedKeys);
  const candidates = review.timeSlots.flatMap((slot) => {
    if (slot?.staffSlot !== false) return [];
    if (!Array.isArray(slot?.validStartTimes)) return [];
    return slot.validStartTimes.flatMap((value) => {
      const at = Date.parse(value);
      if (!Number.isFinite(at) || at <= now || at + durationMs > until) return [];
      const localStart = new Date(at);
      if (!allDay) {
        const windowStart = new Date(localStart);
        const windowEnd = new Date(localStart);
        windowStart.setHours(startHour, 0, 0, 0);
        windowEnd.setHours(endHour, 0, 0, 0);
        if (startHour > endHour) {
          if (at < windowEnd.getTime()) windowStart.setDate(windowStart.getDate() - 1);
          else windowEnd.setDate(windowEnd.getDate() + 1);
        }
        if (at < windowStart.getTime() || at + durationMs > windowEnd.getTime()) {
          return [];
        }
      }
      const startTime = localStart.toISOString();
      const key = `student:${startTime}`;
      return excluded.has(key) ? [] : [{ key, startTime, at }];
    });
  }).sort((a, b) => a.at - b.at);
  const candidate = candidates[0];
  if (!candidate) return { status: "no_slots", ...quota };

  const name = (value) => ({ kind: "Name", value });
  const variable = (value) => ({ kind: "Variable", name: name(value) });
  const type = (value, required) => required
    ? { kind: "NonNullType", type: { kind: "NamedType", name: name(value) } }
    : { kind: "NamedType", name: name(value) };
  const field = (value, args = [], children = null) => ({
    kind: "Field", name: name(value), arguments: args,
    ...(children ? { selectionSet: { kind: "SelectionSet", selections: children } } : {})
  });
  const args = ["answerId", "startTime", "wasStaffSlotChosen", "isOnline"]
    .map((value) => ({ kind: "Argument", name: name(value), value: variable(value) }));
  if (!prpChecked) {
    // SignUpCard requires this task's PRP cost from every team member.
    const cost = task.task?.studentTaskAdditionalAttributes?.cookiesCount ?? 0;
    if (!Number.isFinite(cost) || cost < 0) {
      return { status: "prp_unavailable", reason: "Неизвестна стоимость проверки в PRP",
        ...quota };
    }
    if (cost > 0) {
      if (typeof client.query !== "function") {
        return { status: "prp_unavailable", reason: "Не удалось проверить баланс PRP",
          ...quota };
      }
      const experienceQuery = {
        kind: "Document",
        definitions: [{
          kind: "OperationDefinition", operation: "query",
          name: name("calendarGetStudentExperience"),
          selectionSet: { kind: "SelectionSet", selections: [field("student", [], [
            field("getExperience", [], [field("id"), field("cookiesCount")])
          ])] }
        }]
      };
      let balance;
      try {
        const experience = await client.query({ query: experienceQuery,
          fetchPolicy: "network-only" });
        balance = experience?.data?.student?.getExperience?.cookiesCount;
      } catch {
        return { status: "prp_unavailable", reason: "Не удалось проверить баланс PRP",
          ...quota };
      }
      if (!Number.isFinite(balance)) {
        return { status: "prp_unavailable", reason: "Неизвестен баланс PRP",
          ...quota };
      }
      if (balance < cost) {
        return { status: "insufficient_prp",
          reason: `Недостаточно PRP: есть ${balance}, нужно ${cost}`, ...quota };
      }
      if (task.task?.assignmentType === "GROUP") {
        const teamQuery = findQuery("getProjectTeamMembers");
        let members;
        try {
          const teamResult = await teamQuery?.refetch();
          members = teamResult?.data?.student?.getProjectTeamMembers?.members;
        } catch {
          // A missing team balance must never be treated as sufficient PRP.
        }
        if (!Array.isArray(members) || members.some((member) =>
          !Number.isFinite(member?.userExperience?.cookiesCount))) {
          return { status: "prp_unavailable",
            reason: "Не удалось проверить PRP участников команды", ...quota };
        }
        if (members.some((member) => member.userExperience.cookiesCount < cost)) {
          return { status: "insufficient_prp",
            reason: `У участника команды меньше ${cost} PRP`, ...quota };
        }
      }
    }
  }
  const mutation = {
    kind: "Document",
    definitions: [{
      kind: "OperationDefinition",
      operation: "mutation",
      name: name("calendarAddBookingToEventSlot"),
      variableDefinitions: [
        ["answerId", "ID", true],
        ["startTime", "DateTime", true],
        ["wasStaffSlotChosen", "Boolean", true],
        ["isOnline", "Boolean", false]
      ].map(([value, named, required]) => ({
        kind: "VariableDefinition", variable: variable(value), type: type(named, required)
      })),
      selectionSet: { kind: "SelectionSet", selections: [field("student", [], [
        field("addBookingP2PToEventSlot", args, [field("id")])
      ])] }
    }]
  };
  try {
    const response = await client.mutate({
      mutation,
      variables: {
        answerId,
        startTime: candidate.startTime,
        wasStaffSlotChosen: false,
        isOnline: bookingType === "online"
      }
    });
    if (!response?.data?.student?.addBookingP2PToEventSlot?.id) {
      return { status: "failed", key: candidate.key,
        startTime: candidate.startTime, reason: "Сервер не подтвердил запись",
        prpChecked: true, ...quota };
    }
    const bookingsQuery = findQuery("calendarGetMyBookings");
    if (typeof bookingsQuery?.refetch === "function") {
      try { await bookingsQuery.refetch(); } catch {
        // The booking succeeded; the next regular refresh can update this list.
      }
    }
    return { status: "booked", key: candidate.key,
      startTime: candidate.startTime, prpChecked: true, ...quota };
  } catch (error) {
    return { status: "failed", key: candidate.key,
      startTime: candidate.startTime,
      reason: String(error?.message ?? "Ошибка записи").slice(0, 200),
      prpChecked: true, ...quota };
  }
}

function isCurrentCycle(state, initial) {
  return state?.runId === initial.runId && state.phase === "loading" &&
    state.cycleId === initial.cycleId;
}

async function refreshCycleData(tabId, initial, requested) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: refetchInPage,
      args: [initial.config.selected, initial.config.clearMode,
        initial.runId, initial.cycleId]
    });
    if (injection?.result) return injection.result;
  } catch {
    // Navigating or a missing Apollo client makes this cycle unavailable.
  }
  return { status: "unavailable", requested, completed: 0,
    missing: requested, failed: 0, freeUpdated: false };
}

async function recordBookingResult(tabId, initial, booking) {
  return withTabLock(tabId, async () => {
    const current = await getState(tabId);
    if (!isCurrentCycle(current, initial)) return false;
    const now = Date.now();
    const cooldowns = Object.fromEntries(Object.entries(current.bookingCooldowns ?? {})
      .filter(([, until]) => Number.isFinite(until) && until > now)
      .slice(-100));
    if (booking.key && ["booked", "failed"].includes(booking.status)) {
      cooldowns[booking.key] = now + (booking.status === "booked"
        ? BOOKING_SUCCESS_COOLDOWN_MS : BOOKING_FAILURE_COOLDOWN_MS);
    }
    const attempted = booking.status === "booked" || booking.status === "failed";
    const next = {
      ...current,
      bookingCooldowns: cooldowns,
      lastBooking: {
        status: booking.status,
        startTime: booking.startTime ?? null,
        current: booking.current ?? null,
        target: booking.target ?? null,
        reason: booking.reason ?? null,
        at: now
      },
      ...(attempted ? { loadingStartedAt: now, loadingCompleted: 0 } : {})
    };
    await putState(tabId, next);
    if (attempted) await scheduleAlarm(tabId, now + LOADING_TIMEOUT_MS);
    await sendState(tabId, next);
    return true;
  });
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

    const requested = Object.values(initial.config.selected).filter(Boolean).length;
    let result;
    if (tab.status === "loading") {
      result = { status: "unavailable", requested, completed: 0,
        missing: requested, failed: 0, freeUpdated: false };
    } else {
      result = await refreshCycleData(tabId, initial, requested);
      if (initial.config.autoBooking.enabled && result.freeUpdated) {
        let prpChecked = false;
        for (let attempts = 0; attempts < MAX_BOOKING_ATTEMPTS_PER_CYCLE; attempts++) {
          const current = await getState(tabId);
          if (!isCurrentCycle(current, initial)) break;
          const excluded = Object.entries(current.bookingCooldowns ?? {})
            .filter(([, until]) => until > Date.now())
            .map(([key]) => key);
          let booking;
          try {
            const [injection] = await chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: bookOneInPage,
              args: [initial.config.autoBooking.horizonHours,
                initial.config.autoBooking.type, excluded, prpChecked,
                initial.config.autoBooking.startHour, initial.config.autoBooking.endHour]
            });
            booking = injection?.result ?? { status: "unavailable" };
          } catch {
            booking = { status: "unavailable" };
          }
          if (!await recordBookingResult(tabId, initial, booking)) break;
          if (booking.status !== "booked" && booking.status !== "failed") break;
          prpChecked = booking.prpChecked === true;
          if (booking.status === "failed") continue;
          result = await refreshCycleData(tabId, initial, requested);
          if (!result.freeUpdated) break;
          prpChecked = false;
        }
      }
    }

    await withTabLock(tabId, async () => {
      const current = await getState(tabId);
      if (!isCurrentCycle(current, initial)) return;
      if (current.oneShot) {
        await stopRunUnlocked(tabId, initial.runId, result);
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
    const requested = Object.values(initial.config.selected).filter(Boolean).length;
    await stopRun(tabId, initial.runId, {
      status: "unavailable", requested, completed: 0,
      missing: requested, failed: 0, cacheCleared: false
    });
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
      const requested = Object.values(state.config.selected).filter(Boolean).length;
      await stopRunUnlocked(tabId, state.runId, {
        status: "timeout", requested, completed: 0,
        missing: 0, failed: requested, cacheCleared: false
      });
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

async function ensurePanelInjected(tabId, url) {
  if (!isReviewUrl(url)) return;
  if (panelInjections.has(tabId)) return panelInjections.get(tabId);
  const injection = (async () => {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(globalThis.__school21RefreshPanelInstalled)
    });
    if (probe?.result) {
      await chrome.tabs.sendMessage(tabId, { type: "S21_ROUTE_CHANGED" });
      return;
    }
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["panel.css"] });
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["content.js"]
    });
  })();
  panelInjections.set(tabId, injection);
  try { await injection; } finally {
    if (panelInjections.get(tabId) === injection) panelInjections.delete(tabId);
  }
}

function handlePlatformNavigation(details) {
  if (details.frameId !== 0) return;
  if (!isReviewUrl(details.url)) {
    void stopRun(details.tabId);
    void chrome.tabs.sendMessage(details.tabId, { type: "S21_ROUTE_CHANGED" })
      .catch(() => {});
    return;
  }
  void ensurePanelInjected(details.tabId, details.url).catch(() => {
    // The tab may have moved to another route before injection finishes.
  });
}

const platformNavigationFilter = {
  url: [{ schemes: ["https"], hostEquals: "platform.21-school.ru" }]
};
chrome.webNavigation.onCompleted.addListener(handlePlatformNavigation,
  platformNavigationFilter);
chrome.webNavigation.onHistoryStateUpdated.addListener(handlePlatformNavigation,
  platformNavigationFilter);

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
      await ensurePanelInjected(tab.id, tab.url);
    } catch {
      // A tab may navigate while the extension is being installed.
    }
  }
});
