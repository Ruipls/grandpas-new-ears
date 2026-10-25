const { isLanguage, isFontScale } = require("./format");

const SETTINGS_KEY = "gne:settings";
const HISTORY_KEY = "gne:history";
const HISTORY_LIMIT = 30;

const DEFAULT_SETTINGS = {
  sourceLanguage: "zh_CN",
  fontScale: "large",
  contrast: "soft"
};

function read(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    if (value === "" || value === undefined || value === null) return fallback;
    return value;
  } catch (error) {
    return fallback;
  }
}

function write(key, value) {
  wx.setStorageSync(key, value);
}

function loadSettings() {
  const stored = read(SETTINGS_KEY, {});
  const source = stored && isLanguage(stored.sourceLanguage)
    ? stored.sourceLanguage
    : DEFAULT_SETTINGS.sourceLanguage;
  const fontScale = stored && isFontScale(stored.fontScale)
    ? stored.fontScale
    : DEFAULT_SETTINGS.fontScale;
  const contrast = stored && stored.contrast === "high" ? "high" : "soft";
  return {
    sourceLanguage: source,
    fontScale: fontScale,
    contrast: contrast
  };
}

function saveSettings(settings) {
  const next = {
    sourceLanguage: isLanguage(settings.sourceLanguage) ? settings.sourceLanguage : DEFAULT_SETTINGS.sourceLanguage,
    fontScale: isFontScale(settings.fontScale) ? settings.fontScale : DEFAULT_SETTINGS.fontScale,
    contrast: settings.contrast === "high" ? "high" : "soft"
  };
  write(SETTINGS_KEY, next);
  return next;
}

function loadHistory() {
  const stored = read(HISTORY_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((item) => item && Array.isArray(item.segments)).slice(0, HISTORY_LIMIT);
}

function saveHistory(list) {
  const next = (Array.isArray(list) ? list : []).slice(0, HISTORY_LIMIT);
  write(HISTORY_KEY, next);
  return next;
}

function appendHistory(session) {
  const history = loadHistory();
  history.unshift(session);
  return saveHistory(history);
}

module.exports = {
  HISTORY_LIMIT,
  loadSettings,
  saveSettings,
  loadHistory,
  saveHistory,
  appendHistory
};
