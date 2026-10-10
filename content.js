if (!globalThis.__school21RefreshPanelInstalled) {
  globalThis.__school21RefreshPanelInstalled = true;

  const DEFAULT_CONFIG = {
    intervalSeconds: 60,
    clearMode: "keep",
    selected: { own: true, registered: true, freeAndCount: true }
  };
  const INTERVALS = new Set([
    ...Array.from({ length: 15 }, (_, index) => index + 1),
    30, 60, 120, 180, 240, 300, 600, 1800
  ]);
  const PANEL_ID = "s21-refresh-panel";
  let draft = DEFAULT_CONFIG;
  let run = null;
  let stateRevision = 0;
  let pending = false;
  let uiError = "";
  let cycleKey = "";
  let lastProgress = 0;
  let tickTimer = null;
  let tickKey = "";

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.setAttribute("aria-label", "Автообновление календаря");
  panel.innerHTML = `
    <div class="s21-panel-head">
      <strong>Автообновление календаря</strong>
    </div>
    <div class="s21-options" role="group" aria-label="Что обновлять">
      <label><input type="checkbox" data-s21-option="own"> Мои проверки</label>
      <label><input type="checkbox" data-s21-option="registered"> Проверки, на которые я записан</label>
      <label><input type="checkbox" data-s21-option="freeAndCount"> Свободные слоты и счётчик</label>
    </div>
    <div class="s21-controls">
      <label class="s21-interval-label">Интервал
        <select data-s21="interval">
          ${Array.from({ length: 15 }, (_, index) =>
            `<option value="${index + 1}">${index + 1} сек</option>`).join("")}
          <option value="30">30 сек</option>
          <option value="60">1 мин</option>
          <option value="120">2 мин</option>
          <option value="180">3 мин</option>
          <option value="240">4 мин</option>
          <option value="300">5 мин</option>
          <option value="600">10 мин</option>
          <option value="1800">30 мин</option>
        </select>
      </label>
      <label class="s21-cache-label">Старые данные
        <select data-s21="cache-mode">
          <option value="keep">Оставлять</option>
          <option value="selected">Очищать</option>
          <option value="all">Очищать все</option>
        </select>
      </label>
      <div class="s21-actions">
        <span class="s21-status" data-s21="status" aria-live="off">Остановлено</span>
        <button type="button" class="s21-once" data-s21="once"
          aria-label="Обновить один раз" title="Обновить один раз">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 6.7M20 4v7h-7"
              stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
              stroke-linejoin="round"/>
          </svg>
        </button>
        <button type="button" class="s21-stop" data-s21="stop"
          title="Остановить обновление">Стоп</button>
        <button type="button" class="s21-start" data-s21="start"
          title="Запустить автообновление">Старт</button>
      </div>
    </div>
    <div class="s21-progress" data-s21="progress" role="progressbar"
      aria-label="Ожидание обновления" aria-valuemin="0" aria-valuemax="100" hidden>
      <div class="s21-progress-fill" data-s21="fill"></div>
    </div>
  `;

  const options = Object.fromEntries(
    [...panel.querySelectorAll("[data-s21-option]")]
      .map((input) => [input.dataset.s21Option, input])
  );
  const interval = panel.querySelector('[data-s21="interval"]');
  const cacheMode = panel.querySelector('[data-s21="cache-mode"]');
  const startButton = panel.querySelector('[data-s21="start"]');
  const onceButton = panel.querySelector('[data-s21="once"]');
  const stopButton = panel.querySelector('[data-s21="stop"]');
  const statusLabel = panel.querySelector('[data-s21="status"]');
  const progress = panel.querySelector('[data-s21="progress"]');
  const fill = panel.querySelector('[data-s21="fill"]');

  function normalizeConfig(value) {
    const selected = value?.selected ?? DEFAULT_CONFIG.selected;
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

  function readConfig() {
    return {
      intervalSeconds: Number(interval.value),
      clearMode: cacheMode.value,
      selected: Object.fromEntries(
        Object.entries(options).map(([key, input]) => [key, input.checked])
      )
    };
  }

  function showConfig(config) {
    interval.value = String(config.intervalSeconds);
    cacheMode.value = config.clearMode;
    for (const [key, input] of Object.entries(options)) {
      input.checked = config.selected[key];
    }
  }

  function formatCountdown(seconds) {
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function isReviewPage() {
    return location.origin === "https://platform.21-school.ru" &&
      /^\/calendar\/review\/[^/]+\/?$/.test(location.pathname);
  }

  function syncPlacement() {
    if (!isReviewPage()) {
      panel.remove();
      return;
    }
    if (!document.body) return;
    const anchor = document.querySelector('[data-testid="Calendar.Header.root"]');
    if (anchor?.parentElement &&
        (panel.parentElement !== anchor.parentElement || panel.nextElementSibling !== anchor)) {
      anchor.parentElement.insertBefore(panel, anchor);
    }
    const background = getComputedStyle(document.body).backgroundColor;
    const channels = background.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
    const luminance = channels
      ? channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
      : 255;
    panel.classList.toggle("s21-dark", luminance < 130);
  }

  function renderStatus() {
    let mode = "stopped";
    if (uiError) {
      statusLabel.textContent = uiError;
      mode = "error";
    } else if (pending) {
      statusLabel.textContent = "Подожди…";
    } else if (!run) {
      statusLabel.textContent = "Остановлено";
    } else if (run.phase === "loading") {
      const total = run.loadingTotal ?? Object.values(run.config.selected).filter(Boolean).length;
      const completed = Math.min(total, run.loadingCompleted ?? 0);
      statusLabel.textContent = `Загрузка (${completed}/${total})`;
      mode = "loading";
    } else {
      const remaining = Math.max(0, Math.ceil((run.nextAt - Date.now()) / 1000));
      statusLabel.textContent = `До обновления ${formatCountdown(remaining)}`;
      mode = run.lastResult && (run.lastResult.status !== "ok" ||
        (run.config.clearMode !== "keep" && !run.lastResult.cacheCleared))
        ? "error" : "waiting";
    }
    statusLabel.dataset.mode = mode;
    if (uiError) {
      statusLabel.title = uiError;
    } else if (run?.lastResult) {
      const result = run.lastResult;
      statusLabel.title = `Предыдущее обновление: ${result.completed}/${result.requested}, ошибок ${result.failed + result.missing}` +
        (run.config.clearMode !== "keep" && !result.cacheCleared ? "; старые данные не очищены" : "");
    } else {
      statusLabel.title = "";
    }
  }

  function renderProgress() {
    renderStatus();
    if (!run) {
      progress.hidden = true;
      progress.classList.remove("s21-loading");
      progress.removeAttribute("aria-valuenow");
      cycleKey = "";
      lastProgress = 0;
      return;
    }

    progress.hidden = false;
    if (run.phase === "loading") {
      progress.classList.add("s21-loading");
      progress.setAttribute("aria-label", "Загрузка данных календаря");
      progress.removeAttribute("aria-valuenow");
      return;
    }

    progress.classList.remove("s21-loading");
    progress.setAttribute("aria-label", "Ожидание обновления");
    const key = `${run.runId}:${run.nextAt}`;
    if (key !== cycleKey) {
      cycleKey = key;
      lastProgress = 0;
    }
    const duration = Math.max(1, run.nextAt - run.waitingStartedAt);
    const progressNow = Math.min(100,
      Math.max(0, (Date.now() - run.waitingStartedAt) / duration * 100));
    lastProgress = Math.max(lastProgress, progressNow);
    fill.style.width = `${lastProgress}%`;
    progress.setAttribute("aria-valuenow", String(Math.round(lastProgress)));
  }

  function syncShortIntervalTimer() {
    const shouldTick = isReviewPage() && run?.phase === "waiting" &&
      run.config.intervalSeconds < 30;
    const key = shouldTick ? `${run.runId}:${run.nextAt}` : "";
    if (key === tickKey) return;
    if (tickTimer !== null) clearTimeout(tickTimer);
    tickTimer = null;
    tickKey = key;
    if (!shouldTick) return;
    const runId = run.runId;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      void chrome.runtime.sendMessage({ type: "S21_TICK", runId })
        .catch(() => {});
    }, Math.max(0, run.nextAt - Date.now()));
  }

  function render() {
    const running = Boolean(run);
    showConfig(running ? run.config : draft);
    for (const input of Object.values(options)) input.disabled = running || pending;
    interval.disabled = running || pending;
    cacheMode.disabled = running || pending;
    startButton.disabled = running || pending ||
      !Object.values(draft.selected).some(Boolean);
    onceButton.disabled = startButton.disabled;
    stopButton.disabled = !running || pending;
    renderProgress();
    syncShortIntervalTimer();
  }

  async function saveDraft() {
    draft = normalizeConfig(readConfig());
    uiError = "";
    render();
    await chrome.storage.local.set({ draft });
  }

  for (const input of Object.values(options)) {
    input.addEventListener("change", () => { void saveDraft(); });
  }
  interval.addEventListener("change", () => { void saveDraft(); });
  cacheMode.addEventListener("change", () => { void saveDraft(); });

  async function beginRun(type) {
    if (pending || run) return;
    pending = true;
    uiError = "";
    render();
    try {
      const response = await chrome.runtime.sendMessage({
        type, config: draft
      });
      if (!response?.ok) {
        uiError = response?.error ?? "Не удалось запустить";
      }
      // S21_STATE carries the latest state, including an already stopped run.
    } catch {
      uiError = "Не удалось связаться с расширением";
    }
    pending = false;
    render();
  }

  startButton.addEventListener("click", () => { void beginRun("S21_START"); });
  onceButton.addEventListener("click", () => { void beginRun("S21_RUN_ONCE"); });

  stopButton.addEventListener("click", async () => {
    if (pending || !run) return;
    pending = true;
    uiError = "";
    render();
    try {
      const response = await chrome.runtime.sendMessage({ type: "S21_STOP" });
      if (response?.ok) run = null;
      else uiError = response?.error ?? "Не удалось остановить";
    } catch {
      uiError = "Не удалось связаться с расширением";
    }
    pending = false;
    render();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "S21_STATE") return;
    stateRevision++;
    run = message.state;
    uiError = "";
    render();
  });

  window.addEventListener("s21-refresh-progress", (event) => {
    let update;
    try { update = JSON.parse(event.detail); } catch { return; }
    if (!run || run.phase !== "loading" || update.runId !== run.runId ||
        update.cycleId !== run.cycleId) return;
    if (!Number.isInteger(update.completed) || !Number.isInteger(update.total)) return;
    if (update.total !== run.loadingTotal || update.completed < 0 ||
        update.completed > update.total) return;
    run.loadingCompleted = Math.max(run.loadingCompleted ?? 0, update.completed);
    renderStatus();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.draft || run) return;
    draft = normalizeConfig(changes.draft.newValue);
    render();
  });

  void (async () => {
    const saved = await chrome.storage.local.get("draft");
    draft = normalizeConfig(saved.draft);
    const revisionBeforeRequest = stateRevision;
    try {
      const response = await chrome.runtime.sendMessage({ type: "S21_GET_STATE" });
      if (response?.ok && stateRevision === revisionBeforeRequest) {
        run = response.state;
      }
    } catch {
      uiError = "Не удалось связаться с расширением";
    }
    render();
    syncPlacement();
    syncShortIntervalTimer();
  })();

  let placementQueued = false;
  function queuePlacement() {
    if (placementQueued) return;
    placementQueued = true;
    requestAnimationFrame(() => {
      placementQueued = false;
      if (document.body !== observedBody) observePlacement();
      syncPlacement();
    });
  }

  const placementObserver = new MutationObserver((mutations) => {
    if (mutations.every((mutation) =>
      mutation.type === "childList" && panel.contains(mutation.target))) return;
    if (!isReviewPage()) {
      if (panel.isConnected) queuePlacement();
      return;
    }
    const anchor = document.querySelector('[data-testid="Calendar.Header.root"]');
    if (!anchor || panel.parentElement !== anchor.parentElement ||
        panel.nextElementSibling !== anchor ||
        mutations.some((mutation) => mutation.type === "attributes")) {
      queuePlacement();
    }
  });
  let observedBody;
  function observePlacement() {
    placementObserver.disconnect();
    placementObserver.observe(document.documentElement, { childList: true, subtree: true });
    observedBody = document.body;
    if (observedBody) {
      placementObserver.observe(observedBody, {
        attributes: true, attributeFilter: ["class", "style"]
      });
    }
  }
  observePlacement();
  window.addEventListener("popstate", queuePlacement);
  window.addEventListener("hashchange", queuePlacement);
  setInterval(renderProgress, 200);
}
