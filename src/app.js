const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const STORAGE_KEYS = {
  settings: "gne:settings",
  history: "gne:history"
};

const DEFAULT_SETTINGS = {
  sourceLanguage: "zh-CN",
  targetLanguage: "",
  fontScale: "large",
  contrast: "soft",
  saveByDefault: false
};

const LANGUAGE_NAMES = {
  "zh-CN": "中文",
  "en-US": "English",
  "yue-Hant-HK": "粤语",
  "ja-JP": "日本語",
  "ko-KR": "한국어"
};

const app = document.querySelector(".app-shell");
const transcriptList = document.querySelector("#transcriptList");
const emptyState = document.querySelector("#emptyState");
const statusText = document.querySelector("#statusText");
const statusPill = document.querySelector("#statusPill");
const statusLabel = document.querySelector("#statusLabel");
const startButton = document.querySelector("#startButton");
const pauseButton = document.querySelector("#pauseButton");
const stopButton = document.querySelector("#stopButton");
const sourceLanguage = document.querySelector("#sourceLanguage");
const targetLanguage = document.querySelector("#targetLanguage");
const settingsPanel = document.querySelector("#settingsPanel");
const contrastToggle = document.querySelector("#contrastToggle");
const saveToggle = document.querySelector("#saveToggle");
const sessionDialog = document.querySelector("#sessionDialog");
const sessionSummary = document.querySelector("#sessionSummary");
const historyCount = document.querySelector("#historyCount");
const historyList = document.querySelector("#historyList");
const clearHistoryButton = document.querySelector("#clearHistoryButton");
const exportMetricsButton = document.querySelector("#exportMetricsButton");
const fontButtons = Array.from(document.querySelectorAll("[data-font]"));

const state = {
  recognition: null,
  listening: false,
  paused: false,
  sessionStartedAt: null,
  segments: [],
  partialText: "",
  render: {
    segmentCount: 0,
    liveElement: null
  },
  diagnostics: createDiagnosticSession(null),
  history: loadJson(STORAGE_KEYS.history, []),
  settings: { ...DEFAULT_SETTINGS, ...loadJson(STORAGE_KEYS.settings, {}) }
};

applySettings();
applyResponsiveDefaults();
renderHistory();
updateSupportState();
syncCaptionState();
bindEvents();
registerServiceWorker();

window.gneDiagnostics = {
  getReport: buildEvaluationReport
};

function bindEvents() {
  startButton.addEventListener("click", startSession);
  pauseButton.addEventListener("click", togglePause);
  stopButton.addEventListener("click", stopSession);

  sourceLanguage.addEventListener("change", () => {
    state.settings.sourceLanguage = sourceLanguage.value;
    saveSettings();
    if (state.listening) restartRecognition();
  });

  targetLanguage.addEventListener("change", () => {
    state.settings.targetLanguage = targetLanguage.value;
    saveSettings();
    renderTranscript({ full: true });
    if (targetLanguage.value) {
      setStatus("paused", "原文", "翻译接口下一步接入");
    }
  });

  contrastToggle.addEventListener("change", () => {
    state.settings.contrast = contrastToggle.checked ? "high" : "soft";
    saveSettings();
    applySettings();
  });

  saveToggle.addEventListener("change", () => {
    state.settings.saveByDefault = saveToggle.checked;
    saveSettings();
  });

  fontButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.settings.fontScale = button.dataset.font;
      saveSettings();
      applySettings();
    });
  });

  sessionDialog.addEventListener("close", () => {
    if (sessionDialog.returnValue === "save") {
      saveCurrentSession();
    }
    resetSession();
  });

  clearHistoryButton.addEventListener("click", () => {
    state.history = [];
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.history));
    renderHistory();
  });

  exportMetricsButton?.addEventListener("click", exportEvaluationReport);
}

async function startSession() {
  if (!SpeechRecognition) {
    setStatus("error", "不可用", "当前浏览器不支持实时识别");
    return;
  }

  try {
    await ensureMicrophonePermission();
    if (!state.sessionStartedAt) {
      state.sessionStartedAt = new Date();
      state.segments = [];
      state.partialText = "";
      state.render.segmentCount = 0;
      state.render.liveElement = null;
      state.diagnostics = createDiagnosticSession(state.sessionStartedAt);
      renderTranscript({ full: true });
    }
    state.listening = true;
    state.paused = false;
    startRecognition();
    updateControls();
  } catch (error) {
    setStatus("error", "麦克风", getMicrophoneErrorMessage(error));
  }
}

function startRecognition() {
  stopRecognition();

  const recognition = new SpeechRecognition();
  recognition.lang = state.settings.sourceLanguage;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    recordRecognitionStart();
    setStatus("listening", "正在听", getLanguageLabel(state.settings.sourceLanguage));
    updateControls();
  };

  recognition.onresult = (event) => {
    const eventStartedAt = getDiagnosticElapsedMs();
    let interim = "";
    let interimCount = 0;
    let interimChars = 0;
    let finalCount = 0;
    let finalChars = 0;
    let confidenceTotal = 0;
    let confidenceCount = 0;

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript?.trim();

      if (!text) continue;

      if (result.isFinal) {
        finalCount += 1;
        finalChars += text.length;
        if (typeof result[0]?.confidence === "number") {
          confidenceTotal += result[0].confidence;
          confidenceCount += 1;
        }
        appendSegment(text, result[0]?.confidence);
      } else {
        interimCount += 1;
        interimChars += text.length;
        interim += `${text} `;
      }
    }

    recordResultEvent({
      elapsedMs: eventStartedAt,
      resultIndex: event.resultIndex,
      resultTotal: event.results.length,
      interimCount,
      interimChars,
      finalCount,
      finalChars,
      averageConfidence: confidenceCount ? confidenceTotal / confidenceCount : null
    });
    state.partialText = interim.trim();
    renderTranscript();
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech") {
      setStatus("listening", "正在听", "等待说话");
      return;
    }

    recordRecognitionError(event.error);
    setStatus("error", "出错", getRecognitionErrorMessage(event.error));
    state.listening = false;
    state.paused = false;
    state.recognition = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      // Ignore abort errors because the visible error state is already set.
    }
    updateControls();
  };

  recognition.onend = () => {
    recordRecognitionEnd("ended");
    state.recognition = null;
    if (state.listening && !state.paused) {
      window.setTimeout(() => {
        if (state.listening && !state.paused) startRecognition();
      }, 240);
    } else if (state.paused) {
      setStatus("paused", "已暂停", "暂停收音");
    } else {
      setStatus("idle", "待机", "准备开始");
    }
  };

  state.recognition = recognition;

  try {
    recognition.start();
  } catch {
    state.recognition = null;
    state.listening = false;
    state.paused = false;
    setStatus("error", "出错", "识别启动失败");
    updateControls();
  }
}

function restartRecognition() {
  if (!state.listening || state.paused) return;
  setStatus("paused", "切换中", getLanguageLabel(state.settings.sourceLanguage));
  startRecognition();
}

function stopRecognition() {
  if (!state.recognition) return;
  const recognition = state.recognition;
  state.recognition = null;
  recognition.onend = null;
  recordRecognitionEnd("stopped");
  try {
    recognition.stop();
  } catch {
    recognition.abort();
  }
}

function togglePause() {
  if (!state.listening) return;

  if (state.paused) {
    state.paused = false;
    startRecognition();
  } else {
    state.paused = true;
    stopRecognition();
    setStatus("paused", "已暂停", "暂停收音");
  }

  updateControls();
}

function stopSession() {
  if (!state.sessionStartedAt) return;

  if (state.partialText) {
    appendSegment(state.partialText);
  }

  state.listening = false;
  state.paused = false;
  stopRecognition();
  updateControls();

  if (!state.segments.length) {
    resetSession();
    return;
  }

  const duration = getSessionDurationText();
  sessionSummary.textContent = `共 ${state.segments.length} 条字幕，时长 ${duration}。`;

  if (state.settings.saveByDefault) {
    sessionDialog.returnValue = "save";
  }

  if (typeof sessionDialog.showModal === "function") {
    sessionDialog.showModal();
  } else if (window.confirm("保存本次对话？")) {
    saveCurrentSession();
    resetSession();
  } else {
    resetSession();
  }
}

function appendSegment(text, confidence = null) {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText) return;

  const previous = state.segments[state.segments.length - 1];
  if (previous?.text === cleanText) return;

  state.segments.push({
    id: createId(),
    text: cleanText,
    translatedText: "",
    confidence,
    sourceLanguage: state.settings.sourceLanguage,
    targetLanguage: state.settings.targetLanguage,
    createdAt: new Date().toISOString()
  });

  state.partialText = "";
  renderTranscript();
}

function saveCurrentSession() {
  if (!state.segments.length || !state.sessionStartedAt) return;

  const session = {
    id: createId(),
    startedAt: state.sessionStartedAt.toISOString(),
    endedAt: new Date().toISOString(),
    sourceLanguage: state.settings.sourceLanguage,
    targetLanguage: state.settings.targetLanguage,
    segments: state.segments
  };

  state.history = [session, ...state.history].slice(0, 30);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.history));
  renderHistory();
}

function resetSession() {
  state.listening = false;
  state.paused = false;
  state.sessionStartedAt = null;
  state.segments = [];
  state.partialText = "";
  state.render.segmentCount = 0;
  state.render.liveElement = null;
  renderTranscript({ full: true });
  updateControls();
  setStatus("idle", "待机", "准备开始");
}

function renderTranscript(options = {}) {
  const renderStartedAt = performance.now();
  const fullRender = options.full || state.render.segmentCount > state.segments.length;

  if (fullRender) {
    transcriptList.replaceChildren();
    state.render.segmentCount = 0;
    state.render.liveElement = null;
  }

  const fragment = document.createDocumentFragment();

  for (let index = state.render.segmentCount; index < state.segments.length; index += 1) {
    fragment.append(createSegmentElement(state.segments[index], index));
  }

  if (fragment.childNodes.length) {
    transcriptList.append(fragment);
    state.render.segmentCount = state.segments.length;
  }

  syncLiveSegment();
  transcriptList.scrollTop = transcriptList.scrollHeight;
  syncCaptionState();
  recordRenderSample(performance.now() - renderStartedAt, fullRender);
}

function syncLiveSegment() {
  if (!state.partialText) {
    state.render.liveElement?.remove();
    state.render.liveElement = null;
    return;
  }

  if (!state.render.liveElement || !transcriptList.contains(state.render.liveElement)) {
    state.render.liveElement = createSegmentElement(
      {
        text: state.partialText,
        sourceLanguage: state.settings.sourceLanguage,
        targetLanguage: state.settings.targetLanguage
      },
      state.segments.length,
      { live: true }
    );
    transcriptList.append(state.render.liveElement);
    return;
  }

  const liveText = state.render.liveElement.querySelector(".segment-text");
  if (liveText.textContent !== state.partialText) {
    liveText.textContent = state.partialText;
  }
}

function createSegmentElement(segment, index, options = {}) {
  const item = document.createElement("article");
  item.className = options.live ? "segment segment-live" : "segment";

  const meta = document.createElement("div");
  meta.className = "segment-meta";
  meta.textContent = options.live ? "正在说话" : `${index + 1} · ${formatTime(segment.createdAt)}`;

  const text = document.createElement("div");
  text.className = "segment-text";
  text.textContent = segment.text;

  item.append(meta, text);

  if (
    !options.live &&
    state.settings.targetLanguage &&
    state.settings.targetLanguage !== segment.sourceLanguage
  ) {
    const translation = document.createElement("div");
    translation.className = "segment-translation";
    translation.textContent = "译文服务待接入";
    item.append(translation);
  }

  return item;
}

function syncCaptionState() {
  const hasCaption = state.segments.length > 0 || Boolean(state.partialText);
  const sessionActive = Boolean(state.sessionStartedAt) || state.listening || state.paused;
  const showEmptyState = !hasCaption && !sessionActive;

  emptyState.hidden = !showEmptyState;
  emptyState.setAttribute("aria-hidden", String(!showEmptyState));
  app.dataset.captionState = showEmptyState ? "empty" : "active";
}

function renderHistory() {
  historyCount.textContent = String(state.history.length);
  historyList.replaceChildren();
  clearHistoryButton.disabled = state.history.length === 0;

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.textContent = "暂无保存记录";
    historyList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  state.history.forEach((session) => {
    const item = document.createElement("article");
    item.className = "history-item";

    const time = document.createElement("time");
    time.dateTime = session.startedAt;
    time.textContent = `${formatDate(session.startedAt)} · ${getSessionLanguageText(session)}`;

    const preview = document.createElement("p");
    preview.textContent = session.segments.map((segment) => segment.text).join(" ").slice(0, 120);

    item.append(time, preview);
    fragment.append(item);
  });

  historyList.append(fragment);
}

function createDiagnosticSession(startedAt) {
  return {
    schemaVersion: "gne-eval-v1",
    sessionId: createId(),
    startedAt: startedAt ? startedAt.toISOString() : null,
    startedAtMs: startedAt ? performance.now() : null,
    appVersion: app.dataset.appVersion || "",
    sourceLanguage: sourceLanguage?.value || DEFAULT_SETTINGS.sourceLanguage,
    targetLanguage: targetLanguage?.value || DEFAULT_SETTINGS.targetLanguage,
    userAgent: navigator.userAgent,
    recognitionStarts: [],
    recognitionEnds: [],
    resultEvents: [],
    renderSamples: [],
    errors: []
  };
}

function recordRecognitionStart() {
  if (!state.diagnostics.startedAt) return;
  state.diagnostics.recognitionStarts.push({
    elapsedMs: getDiagnosticElapsedMs(),
    language: state.settings.sourceLanguage
  });
}

function recordRecognitionEnd(reason) {
  if (!state.diagnostics.startedAt) return;
  state.diagnostics.recognitionEnds.push({
    elapsedMs: getDiagnosticElapsedMs(),
    reason,
    listening: state.listening,
    paused: state.paused
  });
}

function recordRecognitionError(error) {
  if (!state.diagnostics.startedAt) return;
  state.diagnostics.errors.push({
    elapsedMs: getDiagnosticElapsedMs(),
    error
  });
}

function recordResultEvent(event) {
  if (!state.diagnostics.startedAt) return;
  pushCapped(state.diagnostics.resultEvents, event, 2000);
}

function recordRenderSample(durationMs, fullRender) {
  if (!state.diagnostics.startedAt) return;
  pushCapped(
    state.diagnostics.renderSamples,
    {
      elapsedMs: getDiagnosticElapsedMs(),
      durationMs: roundMetric(durationMs),
      fullRender,
      segmentCount: state.segments.length,
      partialChars: state.partialText.length
    },
    2000
  );
}

function exportEvaluationReport() {
  const report = buildEvaluationReport();
  downloadJson(report, `grandpas-new-ears-eval-${formatFileDate(new Date())}.json`);

  if (!exportMetricsButton) return;
  exportMetricsButton.textContent = "已导出";
  window.setTimeout(() => {
    exportMetricsButton.textContent = "导出评测数据";
  }, 1400);
}

function buildEvaluationReport() {
  const exportedAt = new Date();
  const startedAt = state.sessionStartedAt;
  const durationMs = startedAt ? exportedAt.getTime() - startedAt.getTime() : 0;
  const transcriptText = state.segments.map((segment) => segment.text).join("\n");

  return {
    schemaVersion: "gne-eval-v1",
    exportedAt: exportedAt.toISOString(),
    appVersion: app.dataset.appVersion || "",
    sourceLanguage: state.settings.sourceLanguage,
    targetLanguage: state.settings.targetLanguage,
    session: {
      id: state.diagnostics.sessionId,
      startedAt: startedAt?.toISOString() || null,
      durationMs,
      durationText: startedAt ? getSessionDurationText() : "0 秒",
      segmentCount: state.segments.length,
      finalChars: transcriptText.length,
      partialChars: state.partialText.length
    },
    summary: summarizeDiagnostics(durationMs),
    transcriptText,
    partialText: state.partialText,
    segments: state.segments.map((segment, index) => ({
      index: index + 1,
      text: segment.text,
      confidence: segment.confidence,
      createdAt: segment.createdAt,
      sourceLanguage: segment.sourceLanguage
    })),
    diagnostics: {
      recognitionStarts: state.diagnostics.recognitionStarts,
      recognitionEnds: state.diagnostics.recognitionEnds,
      resultEvents: state.diagnostics.resultEvents,
      renderSamples: state.diagnostics.renderSamples,
      errors: state.diagnostics.errors
    }
  };
}

function summarizeDiagnostics(durationMs) {
  const resultEvents = state.diagnostics.resultEvents;
  const renderSamples = state.diagnostics.renderSamples;
  const confidenceValues = resultEvents
    .map((event) => event.averageConfidence)
    .filter((value) => typeof value === "number");
  const renderDurations = renderSamples.map((sample) => sample.durationMs);
  const finalResultCount = sum(resultEvents.map((event) => event.finalCount));
  const interimEventCount = resultEvents.filter((event) => event.interimCount > 0).length;
  const firstResult = resultEvents.find((event) => event.interimCount > 0 || event.finalCount > 0);
  const firstFinal = resultEvents.find((event) => event.finalCount > 0);

  return {
    durationMs,
    recognitionStartCount: state.diagnostics.recognitionStarts.length,
    recognitionRestartCount: Math.max(0, state.diagnostics.recognitionStarts.length - 1),
    recognitionEndCount: state.diagnostics.recognitionEnds.length,
    errorCount: state.diagnostics.errors.length,
    resultEventCount: resultEvents.length,
    interimEventCount,
    finalResultCount,
    timeToFirstResultMs: firstResult ? roundMetric(firstResult.elapsedMs) : null,
    timeToFirstFinalMs: firstFinal ? roundMetric(firstFinal.elapsedMs) : null,
    averageConfidence: average(confidenceValues),
    renderAverageMs: average(renderDurations),
    renderP95Ms: percentile(renderDurations, 95),
    renderMaxMs: renderDurations.length ? Math.max(...renderDurations) : null,
    windows: buildDiagnosticWindows(60000)
  };
}

function buildDiagnosticWindows(windowSizeMs) {
  const durationMs = state.sessionStartedAt ? Date.now() - state.sessionStartedAt.getTime() : 0;
  const windowCount = Math.max(1, Math.ceil(durationMs / windowSizeMs));
  const windows = Array.from({ length: windowCount }, (_, index) => ({
    index,
    startMs: index * windowSizeMs,
    endMs: (index + 1) * windowSizeMs,
    resultEventCount: 0,
    interimEventCount: 0,
    finalResultCount: 0,
    confidenceValues: [],
    renderDurations: []
  }));

  state.diagnostics.resultEvents.forEach((event) => {
    const bucket = windows[Math.min(windows.length - 1, Math.floor(event.elapsedMs / windowSizeMs))];
    bucket.resultEventCount += 1;
    if (event.interimCount > 0) bucket.interimEventCount += 1;
    bucket.finalResultCount += event.finalCount;
    if (typeof event.averageConfidence === "number") bucket.confidenceValues.push(event.averageConfidence);
  });

  state.diagnostics.renderSamples.forEach((sample) => {
    const bucket = windows[Math.min(windows.length - 1, Math.floor(sample.elapsedMs / windowSizeMs))];
    bucket.renderDurations.push(sample.durationMs);
  });

  return windows.map((window) => ({
    index: window.index,
    startMs: window.startMs,
    endMs: window.endMs,
    resultEventCount: window.resultEventCount,
    interimEventCount: window.interimEventCount,
    finalResultCount: window.finalResultCount,
    averageConfidence: average(window.confidenceValues),
    renderAverageMs: average(window.renderDurations),
    renderP95Ms: percentile(window.renderDurations, 95),
    renderMaxMs: window.renderDurations.length ? Math.max(...window.renderDurations) : null
  }));
}

function applySettings() {
  sourceLanguage.value = state.settings.sourceLanguage;
  targetLanguage.value = state.settings.targetLanguage;
  contrastToggle.checked = state.settings.contrast === "high";
  saveToggle.checked = state.settings.saveByDefault;

  app.dataset.contrast = state.settings.contrast;
  app.dataset.fontScale = state.settings.fontScale;

  fontButtons.forEach((button) => {
    const pressed = button.dataset.font === state.settings.fontScale;
    button.setAttribute("aria-pressed", String(pressed));
  });
}

function applyResponsiveDefaults() {
  if (window.matchMedia("(max-width: 540px)").matches) {
    settingsPanel.open = false;
  }
}

function updateControls() {
  startButton.disabled = state.listening && !state.paused;
  pauseButton.disabled = !state.listening;
  stopButton.disabled = !state.sessionStartedAt;

  if (state.paused) {
    pauseButton.setAttribute("aria-label", "继续");
    pauseButton.querySelector("span").textContent = "▶";
  } else {
    pauseButton.setAttribute("aria-label", "暂停");
    pauseButton.querySelector("span").textContent = "Ⅱ";
  }

  startButton.querySelector("span:last-child").textContent =
    state.sessionStartedAt && state.paused ? "继续" : "开始";
}

function updateSupportState() {
  if (SpeechRecognition) {
    setStatus("idle", "待机", "准备开始");
    return;
  }

  startButton.disabled = true;
  setStatus("error", "不可用", "当前浏览器不支持实时识别");
}

async function ensureMicrophonePermission() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

function setStatus(stateName, label, text) {
  statusPill.dataset.state = stateName;
  statusLabel.textContent = label;
  statusText.textContent = text;
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getLanguageLabel(code) {
  return LANGUAGE_NAMES[code] || code;
}

function getSessionLanguageText(session) {
  const source = getLanguageLabel(session.sourceLanguage);
  const target = getLanguageLabel(session.targetLanguage);
  return session.targetLanguage ? `${source} 到 ${target}` : source;
}

function getSessionDurationText() {
  if (!state.sessionStartedAt) return "0 秒";
  const seconds = Math.max(1, Math.round((Date.now() - state.sessionStartedAt.getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function getMicrophoneErrorMessage(error) {
  if (error?.name === "NotAllowedError") return "麦克风未授权";
  if (error?.name === "NotFoundError") return "未找到麦克风";
  return "无法打开麦克风";
}

function getRecognitionErrorMessage(error) {
  const messages = {
    "audio-capture": "无法读取麦克风",
    "not-allowed": "麦克风未授权",
    network: "网络连接异常",
    "service-not-allowed": "识别服务不可用",
    aborted: "识别已中断",
    language: "语言暂不支持"
  };

  return messages[error] || "识别失败";
}

function getDiagnosticElapsedMs() {
  if (!state.diagnostics.startedAtMs) return 0;
  return performance.now() - state.diagnostics.startedAtMs;
}

function pushCapped(list, item, limit) {
  list.push(item);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values) {
  if (!values.length) return null;
  return roundMetric(sum(values) / values.length);
}

function percentile(values, target) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((target / 100) * sorted.length) - 1);
  return roundMetric(sorted[index]);
}

function roundMetric(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.round(value * 10) / 10;
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatFileDate(date) {
  return date.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
