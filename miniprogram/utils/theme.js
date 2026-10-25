function applyNavigationTheme(contrast) {
  const high = contrast === "high";
  const frontColor = high ? "#ffffff" : "#000000";
  const backgroundColor = high ? "#000000" : "#eef4f2";

  if (wx.setNavigationBarColor) {
    wx.setNavigationBarColor({
      frontColor: frontColor,
      backgroundColor: backgroundColor,
      animation: { duration: 0, timingFunc: "linear" },
      fail() {}
    });
  }

  if (wx.setBackgroundColor) {
    wx.setBackgroundColor({
      backgroundColor: backgroundColor,
      fail() {}
    });
  }
}

module.exports = {
  applyNavigationTheme
};
