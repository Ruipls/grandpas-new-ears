const LANGUAGES = [
  { id: "zh_CN", label: "普通话" },
  { id: "en_US", label: "English" },
  { id: "zh_HK", label: "粤语" }
];

const FONT_SCALES = [
  { id: "large", label: "大" },
  { id: "xlarge", label: "超大" },
  { id: "huge", label: "巨大" }
];

function isLanguage(id) {
  return LANGUAGES.some((item) => item.id === id);
}

function isFontScale(id) {
  return FONT_SCALES.some((item) => item.id === id);
}

function languageLabel(id) {
  const match = LANGUAGES.find((item) => item.id === id);
  return match ? match.label : "普通话";
}

function pad(value) {
  return value < 10 ? "0" + value : String(value);
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function formatStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function formatDuration(ms) {
  const safe = Number(ms);
  const seconds = Number.isFinite(safe) ? Math.max(1, Math.round(safe / 1000)) : 1;
  if (seconds < 60) return seconds + " 秒";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!rest) return minutes + " 分";
  return minutes + " 分 " + rest + " 秒";
}

function createId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function normalizeCaption(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

module.exports = {
  LANGUAGES,
  FONT_SCALES,
  isLanguage,
  isFontScale,
  languageLabel,
  formatClock,
  formatStamp,
  formatDuration,
  createId,
  normalizeCaption
};
