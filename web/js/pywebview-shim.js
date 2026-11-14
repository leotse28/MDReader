/*!
 * pywebview 兼容垫片（Rust 宿主专用）。
 * 在 wry 注入的 window.ipc.postMessage 之上模拟 pywebview 的
 * window.pywebview.api.<method>(...)（Promise 语义）与 pywebviewready 事件，
 * 使 app.js 无需任何改动即可运行。宿主经 evaluate_script 回注
 * window.__pywebview.resolve(id, ok, value) 完成承诺。
 */
(function () {
  "use strict";
  var seq = 0;
  var pending = new Map();
  var METHODS = [
    "get_config", "set_config", "get_version",
    "take_startup_file", "take_dropped",
    "pick_file", "pick_folder",
    "open_path", "reload_doc", "list_folder", "list_subfolder",
    "read_asset", "save_file", "save_file_as",
    "print_to_pdf", "quit_app", "open_external", "show_in_explorer",
    "handle_drop", "report_selftest"
  ];
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      window.ipc.postMessage(JSON.stringify({ id: id, method: method, args: args }));
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("桥接调用超时: " + method));
        }
      }, 120000);
    });
  }
  window.__pywebview = {
    resolve: function (id, ok, value) {
      var p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(value === undefined ? null : value);
      else p.reject(new Error(String(value)));
    }
  };
  var api = {};
  METHODS.forEach(function (m) {
    api[m] = function () {
      return call(m, Array.prototype.slice.call(arguments));
    };
  });
  window.pywebview = { api: api };
  function ready() { window.dispatchEvent(new Event("pywebviewready")); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }
})();
