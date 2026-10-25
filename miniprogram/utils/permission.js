function ensurePrivacyAuthorize() {
  return new Promise((resolve, reject) => {
    if (!wx.getPrivacySetting) {
      resolve();
      return;
    }

    wx.getPrivacySetting({
      success(res) {
        if (!res || !res.needAuthorization) {
          resolve();
          return;
        }
        if (!wx.requirePrivacyAuthorize) {
          reject({ code: "privacy" });
          return;
        }
        wx.requirePrivacyAuthorize({
          success() {
            resolve();
          },
          fail() {
            reject({ code: "privacy" });
          }
        });
      },
      fail() {
        resolve();
      }
    });
  });
}

function ensureRecordPermission() {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success(res) {
        const auth = res && res.authSetting ? res.authSetting["scope.record"] : undefined;
        if (auth === true) {
          resolve();
          return;
        }
        if (auth === false) {
          reject({ code: "mic-denied" });
          return;
        }
        wx.authorize({
          scope: "scope.record",
          success() {
            resolve();
          },
          fail() {
            reject({ code: "mic-denied" });
          }
        });
      },
      fail() {
        reject({ code: "mic-denied" });
      }
    });
  });
}

module.exports = {
  ensurePrivacyAuthorize,
  ensureRecordPermission
};
