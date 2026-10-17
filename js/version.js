/* 产品版本：单一来源。界面显示、打包默认版本、zip 命名都取自这里；
 * 与存档格式版本（game.js 的 version:3）是两回事。
 * file:// 下直接读取常量，不需要网络请求。
 */
(function () {
  const root = typeof window !== "undefined" ? window : self;
  const GD = (root.GD = root.GD || {});
  GD.VERSION = "1.13.1";
})();
