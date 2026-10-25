const { loadHistory, saveHistory, loadSettings } = require("../../utils/storage");
const { languageLabel, formatStamp, formatDuration } = require("../../utils/format");
const { applyNavigationTheme } = require("../../utils/theme");

Page({
  data: {
    contrast: "soft",
    items: []
  },

  onShow() {
    const settings = loadSettings();
    this.setData({ contrast: settings.contrast });
    applyNavigationTheme(settings.contrast);
    this.reload();
  },

  reload() {
    const history = loadHistory();
    this.records = history;
    this.setData({
      items: history.map((session) => ({
        id: session.id,
        when: formatStamp(session.startedAt),
        languageLabel: languageLabel(session.sourceLanguage),
        durationText: Number.isFinite(Number(session.durationMs)) ? formatDuration(session.durationMs) : "",
        preview: session.segments.map((segment) => segment.text).join(" ")
      }))
    });
  },

  onDelete(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: "删除这条记录",
      content: "删掉后找不回来。",
      confirmText: "删除",
      cancelText: "取消",
      confirmColor: "#9f1239",
      success: (res) => {
        if (!res.confirm) return;
        const next = (this.records || []).filter((item) => item.id !== id);
        saveHistory(next);
        this.reload();
      }
    });
  },

  onClear() {
    if (!this.data.items.length) return;
    wx.showModal({
      title: "清空全部记录",
      content: "这些字幕会从这台手机上删掉，删掉后找不回来。",
      confirmText: "清空",
      cancelText: "取消",
      confirmColor: "#9f1239",
      success: (res) => {
        if (!res.confirm) return;
        saveHistory([]);
        this.reload();
      }
    });
  }
});
