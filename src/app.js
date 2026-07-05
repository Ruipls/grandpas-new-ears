const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const NO_RESULT_TIMEOUT_MS = 8000;
const FAST_RESTART_LIMIT = 4;
const FAST_RESTART_WINDOW_MS = 12000;
const MICROPHONE_PROBE_MS = 1800;

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
const copyDiagnosticsButton = document.querySelector("#copyDiagnosticsButton");
const testMicrophoneButton = document.querySelector("#testMicrophoneButton");
const supportAlert = document.querySelector("#supportAlert");
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
  support: getRuntimeSupport(),
  lastMicrophoneProbe: null,
  recognitionWatchdog: null,
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
  getReport: buildEvaluationReport,
  getSupport: buildSupportReport
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
  copyDiagnosticsButton?.addEventListener("click", copyDiagnosticsReport);
  testMicrophoneButton?.addEventListener("click", testMicrophoneInput);
}

async function startSession() {
  state.support = getRuntimeSupport();
  renderSupportAlert(state.support);

  if (!state.support.hasSpeechRecognition) {
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
    renderSupportAlert(state.support, {
      kind: "microphone-error",
      title: "无法打开麦克风",
      body: getMicrophoneRecoveryMessage()
    });
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
    startRecognitionWatchdog();
    setStatus("listening", "正在听", getLanguageLabel(state.settings.sourceLanguage));
    updateControls();
  };

  recognition.onaudiostart = () => {
    recordAudioEvent("audiostart");
  };

  recognition.onsoundstart = () => {
    recordAudioEvent("soundstart");
    setStatus("listening", "有声音", "正在判断语音");
  };

  recognition.onspeechstart = () => {
    recordAudioEvent("speechstart");
    setStatus("listening", "检测到说话", "正在识别");
  };

  recognition.onresult = (event) => {
    clearRecognitionWatchdog();
    hideNoResultAlert();
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

    clearRecognitionWatchdog();
    recordRecognitionError(event.error);
    renderSupportAlert(state.support, {
      title: "识别服务没有启动",
      body: getRecognitionRecoveryMessage(event.error)
    });
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
    clearRecognitionWatchdog();
    recordRecognitionEnd("ended");
    state.recognition = null;
    if (shouldStopFastRestartLoop()) {
      state.listening = false;
      state.paused = false;
      renderSupportAlert(state.support, {
        title: "没有收到识别结果",
        body: getNoResultRecoveryMessage()
      });
      setStatus("error", "无结果", "请换浏览器测试");
      updateControls();
      return;
    }
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
    startRecognitionWatchdog();
  } catch {
    clearRecognitionWatchdog();
    recordRecognitionError("start-failed");
    state.recognition = null;
    state.listening = false;
    state.paused = false;
    renderSupportAlert(state.support, {
      title: "识别启动失败",
      body: getNoResultRecoveryMessage()
    });
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
  clearRecognitionWatchdog();
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

function getRuntimeSupport() {
  const userAgent = navigator.userAgent || "";
  const brands = navigator.userAgentData?.brands?.map((brand) => brand.brand).join(", ") || "";
  const isHuaweiBrowser = /HuaweiBrowser|HUAWEIBrowser|Huawei/i.test(userAgent) || /Huawei/i.test(brands);
  const isHarmonyOS = /HarmonyOS|OpenHarmony|ArkWeb|ArkWebView/i.test(userAgent);
  const isHuaweiDevice = /HUAWEI|HONOR|Huawei|HarmonyOS|OpenHarmony|ArkWeb/i.test(userAgent);

  return {
    appVersion: app?.dataset?.appVersion || "",
    pageUrl: window.location.href,
    isSecureContext: window.isSecureContext,
    isWeChat: /MicroMessenger/i.test(userAgent),
    isHuaweiBrowser,
    isHarmonyOS,
    isHuaweiDevice,
    shouldPreferServerAsr: isHuaweiBrowser || isHarmonyOS,
    hasSpeechRecognition: Boolean(SpeechRecognition),
    hasNativeSpeechRecognition: "SpeechRecognition" in window,
    hasWebkitSpeechRecognition: "webkitSpeechRecognition" in window,
    hasMediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    hasAudioContext: Boolean(window.AudioContext || window.webkitAudioContext),
    hasClipboard: Boolean(navigator.clipboard?.writeText),
    platform: navigator.platform || "",
    language: navigator.language || "",
    brands,
    userAgent
  };
}

function renderSupportAlert(support, override = null) {
  if (!supportAlert) return;

  const message = override || getSupportMessage(support);
  if (!message) {
    supportAlert.hidden = true;
    supportAlert.replaceChildren();
    delete supportAlert.dataset.kind;
    return;
  }

  supportAlert.dataset.kind = message.kind || "support";
  supportAlert.hidden = false;
  supportAlert.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = message.title;

  const body = document.createElement("span");
  body.textContent = message.body;

  supportAlert.append(title, body);
}

function getSupportMessage(support) {
  if (!support.hasSpeechRecognition) {
    return {
      kind: "unsupported",
      title: "当前浏览器不支持语音识别",
      body: getUnsupportedBrowserMessage(support)
    };
  }

  if (support.isHuaweiBrowser || support.isHarmonyOS) {
    return {
      kind: "huawei",
      title: "华为/鸿蒙浏览器可能无法识别",
      body: "当前版本依赖浏览器内置语音识别。华为自带浏览器可能能打开麦克风，但不返回文字。请先点“测试麦克风”；若有声音但没有字幕，需要换浏览器或接入后端识别。"
    };
  }

  if (support.isWeChat) {
    return {
      kind: "wechat",
      title: "微信内打开可能无法识别",
      body: "页面能打开不代表语音识别可用。如果点击开始后没有字幕，请点右上角菜单，选择在浏览器打开。"
    };
  }

  if (!support.isSecureContext) {
    return {
      kind: "insecure",
      title: "当前连接不安全",
      body: "麦克风和语音识别通常需要 HTTPS 或 localhost。请使用线上 HTTPS 链接测试。"
    };
  }

  if (!support.hasMediaDevices) {
    return {
      kind: "microphone",
      title: "无法检测麦克风接口",
      body: "当前浏览器可能无法授权麦克风。如果开始后没有字幕，请换系统浏览器测试。"
    };
  }

  return null;
}

function startRecognitionWatchdog() {
  clearRecognitionWatchdog();
  state.recognitionWatchdog = window.setTimeout(() => {
    if (!state.listening || state.paused || state.partialText || state.segments.length > 0) return;
    renderSupportAlert(state.support, {
      kind: "no-result",
      title: "还没有收到识别结果",
      body: getNoResultRecoveryMessage()
    });
  }, NO_RESULT_TIMEOUT_MS);
}

function clearRecognitionWatchdog() {
  if (!state.recognitionWatchdog) return;
  window.clearTimeout(state.recognitionWatchdog);
  state.recognitionWatchdog = null;
}

function hideNoResultAlert() {
  if (supportAlert?.dataset.kind === "no-result") {
    renderSupportAlert(state.support);
  }
}

function shouldStopFastRestartLoop() {
  if (state.diagnostics.resultEvents.some((event) => event.interimCount > 0 || event.finalCount > 0)) {
    return false;
  }

  const starts = state.diagnostics.recognitionStarts;
  if (starts.length < FAST_RESTART_LIMIT) return false;

  const first = starts[starts.length - FAST_RESTART_LIMIT];
  const last = starts[starts.length - 1];
  return last.elapsedMs - first.elapsedMs <= FAST_RESTART_WINDOW_MS;
}

function getNoResultRecoveryMessage() {
  if (state.support.isWeChat) {
    return "如果你已经在说话但没有字幕，基本可以判定微信内置浏览器不支持当前网页识别。请点右上角菜单，选择在浏览器打开。";
  }

  if (state.support.isHuaweiBrowser || state.support.isHarmonyOS) {
    return "如果“测试麦克风”能检测到声音但没有字幕，说明华为/鸿蒙浏览器没有返回网页语音识别结果。当前静态网页无法强制修复，需要换浏览器或接入后端识别服务。";
  }

  return "如果你已经在说话但没有字幕，请确认麦克风授权、调高音量，并优先用 Chrome、Edge 或 Safari 打开。";
}

function getRecognitionRecoveryMessage(error) {
  if (error === "not-allowed" || error === "service-not-allowed") {
    if (state.support.isWeChat) {
      return "微信内置浏览器可能禁止网页语音识别。请在系统浏览器打开，并允许麦克风。";
    }
    if (state.support.isHuaweiBrowser || state.support.isHarmonyOS) {
      return "华为/鸿蒙浏览器可能禁止网页语音识别。请先测试麦克风；若麦克风正常但无文字，需要换浏览器或后端识别。";
    }
    return "请在浏览器地址栏或系统设置里允许麦克风，然后重新开始。";
  }

  if (error === "network") {
    return "语音识别服务可能需要稳定网络。请切换网络后重试，或改用系统浏览器测试。";
  }

  if (error === "audio-capture") {
    return "当前浏览器没有读到麦克风。请检查麦克风权限，或换系统浏览器测试。";
  }

  return getNoResultRecoveryMessage();
}

function getUnsupportedBrowserMessage(support) {
  if (support.isWeChat) {
    return "微信内置浏览器通常不能稳定使用网页语音识别。请点右上角菜单，选择在浏览器打开；安卓优先用 Chrome 或 Edge。";
  }

  if (support.isHuaweiBrowser || support.isHarmonyOS || support.isHuaweiDevice) {
    return "华为/鸿蒙环境可能没有网页语音识别能力。页面能打开不代表能转文字。请换 Chrome/Edge 测试；若仍不行，需要接入后端识别服务。";
  }

  return "请改用支持网页语音识别的浏览器测试；安卓优先 Chrome 或 Edge，iPhone 优先 Safari。";
}

function getMicrophoneRecoveryMessage() {
  if (state.support.isWeChat) {
    return "微信内置浏览器可能没有给网页麦克风权限。请在系统浏览器打开，并允许麦克风。";
  }

  if (state.support.isHuaweiBrowser || state.support.isHarmonyOS) {
    return "请在华为浏览器和系统设置里允许麦克风。如果“测试麦克风”仍失败，说明网页没有拿到录音权限。";
  }

  return "请允许麦克风权限；如果仍失败，请检查系统权限或换浏览器测试。";
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
    audioEvents: [],
    microphoneProbes: [],
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

function recordAudioEvent(type) {
  if (!state.diagnostics.startedAt) return;
  pushCapped(
    state.diagnostics.audioEvents,
    {
      elapsedMs: getDiagnosticElapsedMs(),
      type
    },
    500
  );
}

async function testMicrophoneInput() {
  state.support = getRuntimeSupport();
  setTemporaryButtonText(testMicrophoneButton, "请说话");

  try {
    const probe = await probeMicrophoneLevel(MICROPHONE_PROBE_MS);
    state.lastMicrophoneProbe = probe;
    state.diagnostics.microphoneProbes.push(probe);
    showMicrophoneProbeResult(probe);
  } catch (error) {
    const probe = {
      elapsedMs: getDiagnosticElapsedMs(),
      ok: false,
      error: error?.name || "microphone-probe-failed",
      message: error?.message || ""
    };
    state.lastMicrophoneProbe = probe;
    state.diagnostics.microphoneProbes.push(probe);
    renderSupportAlert(state.support, {
      kind: "microphone-error",
      title: "麦克风测试失败",
      body: getMicrophoneRecoveryMessage()
    });
    setStatus("error", "麦克风", getMicrophoneErrorMessage(error));
  }
}

async function probeMicrophoneLevel(durationMs) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia unavailable");
  }

  const startedAt = performance.now();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("AudioContext unavailable");
  }

  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const buffer = new Uint8Array(analyser.fftSize);
  let peak = 0;
  let total = 0;
  let sampleCount = 0;

  await new Promise((resolve) => {
    const sample = () => {
      analyser.getByteTimeDomainData(buffer);
      let framePeak = 0;
      let frameTotal = 0;

      for (const value of buffer) {
        const level = Math.abs(value - 128) / 128;
        framePeak = Math.max(framePeak, level);
        frameTotal += level;
      }

      peak = Math.max(peak, framePeak);
      total += frameTotal / buffer.length;
      sampleCount += 1;

      if (performance.now() - startedAt >= durationMs) {
        resolve();
        return;
      }

      window.requestAnimationFrame(sample);
    };

    sample();
  });

  source.disconnect();
  await audioContext.close();
  stream.getTracks().forEach((track) => track.stop());

  return {
    elapsedMs: getDiagnosticElapsedMs(),
    ok: true,
    durationMs: roundMetric(performance.now() - startedAt),
    peak: roundMetric(peak),
    average: roundMetric(sampleCount ? total / sampleCount : 0),
    detectedSound: peak >= 0.04
  };
}

function showMicrophoneProbeResult(probe) {
  if (!probe.detectedSound) {
    renderSupportAlert(state.support, {
      kind: "microphone-low",
      title: "没有检测到明显声音",
      body: "麦克风权限可能已打开，但刚才没有检测到说话声。请靠近手机再试一次，或检查系统麦克风权限。"
    });
    setStatus("paused", "麦克风", "未检测到声音");
    setTemporaryButtonText(testMicrophoneButton, "再测一次");
    return;
  }

  renderSupportAlert(state.support, {
    kind: "microphone-ok",
    title: "麦克风可以收到声音",
    body:
      state.support.isHuaweiBrowser || state.support.isHarmonyOS
        ? "这说明录音权限大概率正常；仍然没有字幕时，问题在浏览器语音识别能力，不在麦克风。下一步需要换浏览器或接入后端识别。"
        : "麦克风有声音。如果点击开始仍没有字幕，请复制诊断信息回传。"
  });
  setStatus("idle", "麦克风正常", "请再点开始");
  setTemporaryButtonText(testMicrophoneButton, "已检测到声音");
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

async function copyDiagnosticsReport() {
  const report = buildSupportReport();
  const text = JSON.stringify(report, null, 2);

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      copyTextWithFallback(text);
    }
    setTemporaryButtonText(copyDiagnosticsButton, "已复制");
  } catch {
    downloadJson(report, `grandpas-new-ears-diagnostics-${formatFileDate(new Date())}.json`);
    setTemporaryButtonText(copyDiagnosticsButton, "已下载");
  }
}

function buildSupportReport() {
  const durationMs = state.sessionStartedAt ? Date.now() - state.sessionStartedAt.getTime() : 0;
  return {
    schemaVersion: "gne-support-v1",
    exportedAt: new Date().toISOString(),
    support: getRuntimeSupport(),
    status: {
      label: statusLabel.textContent,
      text: statusText.textContent,
      state: statusPill.dataset.state
    },
    session: {
      startedAt: state.sessionStartedAt?.toISOString() || null,
      listening: state.listening,
      paused: state.paused,
      segmentCount: state.segments.length,
      partialTextLength: state.partialText.length
    },
    summary: summarizeDiagnostics(durationMs),
    errors: state.diagnostics.errors,
    audioEvents: state.diagnostics.audioEvents,
    microphoneProbes: state.diagnostics.microphoneProbes,
    lastMicrophoneProbe: state.lastMicrophoneProbe,
    recognitionStarts: state.diagnostics.recognitionStarts,
    recognitionEnds: state.diagnostics.recognitionEnds
  };
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
    support: getRuntimeSupport(),
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
      audioEvents: state.diagnostics.audioEvents,
      microphoneProbes: state.diagnostics.microphoneProbes,
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
    audioEventCount: state.diagnostics.audioEvents.length,
    microphoneProbeCount: state.diagnostics.microphoneProbes.length,
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
  startButton.disabled = !state.support.hasSpeechRecognition || (state.listening && !state.paused);
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
  state.support = getRuntimeSupport();
  renderSupportAlert(state.support);
  startButton.disabled = !state.support.hasSpeechRecognition;

  if (state.support.hasSpeechRecognition) {
    setStatus("idle", "待机", state.support.isWeChat ? "建议用浏览器打开" : "准备开始");
    return;
  }

  setStatus("error", "不可用", state.support.isWeChat ? "请用浏览器打开" : "当前浏览器不支持实时识别");
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
  if (error?.name === "NotReadableError") return "麦克风被占用";
  if (error?.name === "SecurityError") return "当前环境禁止麦克风";
  return "无法打开麦克风";
}

function getRecognitionErrorMessage(error) {
  const messages = {
    "audio-capture": "无法读取麦克风",
    "not-allowed": "麦克风未授权",
    network: "网络连接异常",
    "service-not-allowed": "识别服务不可用",
    "start-failed": "识别启动失败",
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

function copyTextWithFallback(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function setTemporaryButtonText(button, text) {
  if (!button) return;
  const original = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

function formatFileDate(date) {
  return date.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function createId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
