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
const fontButtons = Array.from(document.querySelectorAll("[data-font]"));

const state = {
  recognition: null,
  listening: false,
  paused: false,
  sessionStartedAt: null,
  segments: [],
  partialText: "",
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
    renderTranscript();
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
      renderTranscript();
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
    setStatus("listening", "正在听", getLanguageLabel(state.settings.sourceLanguage));
    updateControls();
  };

  recognition.onresult = (event) => {
    let interim = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript?.trim();

      if (!text) continue;

      if (result.isFinal) {
        appendSegment(text, result[0]?.confidence);
      } else {
        interim += `${text} `;
      }
    }

    state.partialText = interim.trim();
    renderTranscript();
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech") {
      setStatus("listening", "正在听", "等待说话");
      return;
    }

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
  renderTranscript();
  updateControls();
  setStatus("idle", "待机", "准备开始");
}

function renderTranscript() {
  transcriptList.replaceChildren();

  const fragment = document.createDocumentFragment();

  state.segments.forEach((segment, index) => {
    fragment.append(createSegmentElement(segment, index));
  });

  if (state.partialText) {
    fragment.append(
      createSegmentElement(
        {
          text: state.partialText,
          sourceLanguage: state.settings.sourceLanguage,
          targetLanguage: state.settings.targetLanguage
        },
        state.segments.length,
        { live: true }
      )
    );
  }

  transcriptList.append(fragment);
  transcriptList.scrollTop = transcriptList.scrollHeight;
  syncCaptionState();
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
