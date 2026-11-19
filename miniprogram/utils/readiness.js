// Runtime checks before any caption session can say it is listening.
// touristappid is this repo's placeholder and the string WeChat DevTools writes
// for tourist mode. wx.getAccountInfoSync's own document only says appId is a
// string; it does not list touristappid as an enum. An unknown or throwing
// account API does not by itself block startup.

const TOURIST_APPID = "touristappid";
const PLUGIN_NAME = "WechatSI";

function readMiniProgramAppId(wxApi) {
  if (!wxApi || typeof wxApi.getAccountInfoSync !== "function") {
    return { known: false, appId: "" };
  }
  try {
    const info = wxApi.getAccountInfoSync();
    const appId = info && info.miniProgram ? info.miniProgram.appId : undefined;
    if (typeof appId !== "string") return { known: false, appId: "" };
    return { known: true, appId: appId };
  } catch (error) {
    return { known: false, appId: "" };
  }
}

function appIdBlock() {
  return {
    ok: false,
    code: "appid",
    state: "error",
    label: "还没有 AppID",
    detail: "开发者工具里还是游客 AppID。请在详情里手选你的小程序，不要把真实 AppID 写进仓库。现在没有在听。"
  };
}

function pluginBlock() {
  return {
    ok: false,
    code: "plugin",
    state: "error",
    label: "插件不可用",
    detail: "同声传译插件还不能用。请确认公众平台已添加该插件，并且版本与 miniprogram/app.json 里写的一致。现在没有在听。"
  };
}

function assessRuntime(wxApi) {
  const requirePluginFn = typeof requirePlugin === "function" ? requirePlugin : null;
  const account = readMiniProgramAppId(wxApi);
  if (account.known && (account.appId === "" || account.appId === TOURIST_APPID)) {
    return appIdBlock();
  }
  if (typeof requirePluginFn !== "function") return pluginBlock();
  try {
    const plugin = requirePluginFn(PLUGIN_NAME);
    if (!plugin || typeof plugin.getRecordRecognitionManager !== "function") return pluginBlock();
  } catch (error) {
    return pluginBlock();
  }
  return { ok: true, code: "ready" };
}

module.exports = {
  TOURIST_APPID,
  PLUGIN_NAME,
  readMiniProgramAppId,
  assessRuntime
};
