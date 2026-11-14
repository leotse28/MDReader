/* ==========================================================
   MD Reader — application controller
   ========================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const api = () => window.pywebview && window.pywebview.api;
  const isSelfTest = () => /[#&?]selftest=1/.test(location.hash + location.search);

  const state = {
    doc: null,            // 当前激活标签的文档 { path, name, dir, content }
    folder: null,         // { folder, name, items }
    cfg: {},
    zoom: 1,
    tabs: [],             // [{ id, doc, scroll }]
    activeTabId: null,
    nextTabId: 1,
    editMode: false,
    find: { visible: false, replaceVisible: false, q: "", matches: [], idx: -1 },
  };
  let WELCOME_HTML = "";

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1900);
  }

  /* ---------------- config ---------------- */
  async function loadConfig() {
    if (!api()) return {};
    try { state.cfg = (await api().get_config()) || {}; } catch (e) { state.cfg = {}; }
    return state.cfg;
  }
  function saveConfig(patch) {
    Object.assign(state.cfg, patch);
    if (api()) { try { api().set_config(patch); } catch (e) {} }
  }

  /* ---------------- theme / zoom ---------------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    state.cfg.theme = theme;
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    saveConfig({ theme: next });
    if (MDRender.rerenderMermaid) {
      MDRender.rerenderMermaid($("content"));
      applyMermaidZoom($("content"));
    }
    toast(next === "dark" ? "深色模式" : "浅色模式");
  }

  function applyZoom() {
    const base = Number(state.cfg.fontSize || 16);
    const size = Math.round(base * state.zoom);
    const root = document.documentElement.style;
    root.setProperty("--content-size", size + "px");
    root.setProperty("--content-lh", String(state.cfg.lineHeight || 1.75));
    root.setProperty("--content-max", (state.cfg.maxWidth || 1280) + "px");
    const label = $("zoomLabel");
    if (label) {
      label.textContent = Math.round(state.zoom * 100) + "%";
      label.title = "点击恢复 100%";
    }
  }
  function setZoom(z) {
    state.zoom = Math.min(2.5, Math.max(0.6, z));
    applyZoom();
  }

  /* ---------------- rendering ---------------- */
  // 兼容入口：selftest / 外部钩子调用。语义 = 在标签页中打开。
  function renderDoc(doc) { openInTab(doc); }

  function renderDocIntoPage(doc, opts) {
    state.doc = doc;
    $("docTitle").textContent = doc.name || "未命名";
    $("docTitle").title = doc.path || "";

    const html = MDRender.parse(doc.content || "");
    const content = $("content");
    content.className = "markdown-body";
    content.innerHTML = html;

    resolveImages(content, doc.dir);
    buildToc(content);
    updateMeta(doc);
    if (MDRender.enhanceMermaid) MDRender.enhanceMermaid(content);
    bindMermaidControls(content);
    applyMermaidZoom(content);
    // 查找栏打开时，正文变化后自动重查（替换/切标签/重载）
    if (state.find.visible && state.find.q && $("findInput").value) {
      doFind($("findInput").value.trim());
    }

    $("reader").scrollTop = opts && opts.resetScroll === false ? (opts.scroll || 0) : 0;
    updateProgress();
    makeCodeCopyable(content);
    bindContentLinks(content);
    bindImageLightbox(content);
  }

  /* ---------------- tabs ---------------- */
  function currentTab() {
    return state.tabs.find((t) => t.id === state.activeTabId) || null;
  }

  function isDirty(tab) {
    return !!(tab && tab.doc && tab.doc.content !== tab.savedContent);
  }

  function openInTab(doc) {
    if (doc && doc.path) {
      const existing = state.tabs.find((t) => t.doc && t.doc.path === doc.path);
      if (existing) { activateTab(existing.id, doc); return; }
    }
    const tab = { id: state.nextTabId++, doc, scroll: 0, savedContent: doc ? doc.content : "", confirmClose: false };
    state.tabs.push(tab);
    activateTab(tab.id);
    saveSessionDebounced();
  }

  function activateTab(id, newDoc) {
    const old = currentTab();
    if (old && old.id !== id) old.scroll = $("reader").scrollTop;
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (newDoc) tab.doc = newDoc;
    state.activeTabId = id;
    state.doc = tab.doc;
    if (tab.doc) {
      renderDocIntoPage(tab.doc, { resetScroll: false, scroll: tab.scroll });
      updateProgress();
    }
    if (state.editMode) syncEditorFromTab();
    renderTabs();
    markActiveTree();
    saveSessionDebounced();
  }

  function closeTab(id) {
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (isDirty(tab) && !tab.confirmClose) {
      tab.confirmClose = true;
      renderTabs();
      toast("有未保存的修改，再点一次关闭将放弃修改");
      setTimeout(() => { tab.confirmClose = false; renderTabs(); }, 3000);
      return;
    }
    const i = state.tabs.findIndex((t) => t.id === id);
    state.tabs.splice(i, 1);
    if (state.activeTabId === id) {
      const next = state.tabs[Math.min(i, state.tabs.length - 1)];
      if (next) {
        activateTab(next.id);
      } else {
        state.activeTabId = null;
        state.doc = null;
        showWelcome();
        exitEditMode();
      }
    }
    renderTabs();
    markActiveTree();
    saveSessionDebounced();
  }

  function cycleTab(dir) {
    if (state.tabs.length < 2) return;
    const i = state.tabs.findIndex((t) => t.id === state.activeTabId);
    const j = (i + dir + state.tabs.length) % state.tabs.length;
    activateTab(state.tabs[j].id);
  }

  function renderTabs() {
    const bar = $("tabbar"), box = $("tabs");
    if (!bar || !box) return;
    if (!state.tabs.length) { bar.hidden = true; box.innerHTML = ""; return; }
    bar.hidden = false;
    box.innerHTML = "";
    state.tabs.forEach((t) => {
      const el = document.createElement("div");
      el.className = "tab" + (t.id === state.activeTabId ? " active" : "");
      el.title = (t.doc && t.doc.path) || "";
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = (isDirty(t) ? "● " : "") + ((t.doc && t.doc.name) || "无标题");
      const x = document.createElement("button");
      x.className = "tab-close";
      x.textContent = "×";
      x.title = "关闭 (Ctrl+W)";
      x.setAttribute("aria-label", "关闭标签页");
      x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
      el.addEventListener("click", () => activateTab(t.id));
      el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
      el.appendChild(label);
      el.appendChild(x);
      box.appendChild(el);
    });
  }

  function showWelcome() {
    const content = $("content");
    content.className = "markdown-body";
    content.innerHTML = WELCOME_HTML;
    $("docTitle").textContent = "未打开文档";
    $("docTitle").title = "";
    $("docMeta").textContent = "—";
    $("tocList").innerHTML = '<div class="empty-hint">本文档暂无标题</div>';
    $("readProgress").style.width = "0%";
    bindWelcome();
  }

  /* ---------------- editor & save ---------------- */
  function editorWrap() { return $("editorWrap"); }

  function syncEditorFromTab() {
    const tab = currentTab();
    $("editor").value = (tab && tab.doc && tab.doc.content) || "";
  }

  function enterEditMode() {
    const tab = currentTab();
    if (!tab || !tab.doc) { toast("先打开或新建一个文件"); return; }
    state.editMode = true;
    syncEditorFromTab();
    editorWrap().hidden = false;
    $("layout").classList.add("editing"); // 方案 B：预览侧预留等宽空间
    // 恢复上次的分栏宽度（配置持久化，单一来源 = .layout 上的 --split-w）。
    // 必须无条件用 px：CSS 回退值 50% 在编辑窗格（基准 .editor-wrap）与
    // 预览 margin（基准 .layout）两处解析基准不同，会产生死空间；
    // 同时按当前窗口钳制（镜像拖拽时的 [300, 编辑区-160] 约束），
    // 防止宽窗口时代持久化的过大值在窄窗口下把预览挤出屏幕。
    const savedW = parseInt(state.cfg.splitWidth, 10);
    const raw = savedW >= 300 ? savedW : Math.round(editorWrap().clientWidth * 0.5);
    const w = Math.max(300, Math.min(raw, editorWrap().clientWidth - 160));
    $("layout").style.setProperty("--split-w", w + "px");
    $("btnEdit").classList.add("editing");
    updateEditorGutter();
    $("editor").focus();
    renderTabs();
  }

  function exitEditMode() {
    state.editMode = false;
    if (editorWrap()) editorWrap().hidden = true;
    $("layout").classList.remove("editing");
    const btn = $("btnEdit");
    if (btn) btn.classList.remove("editing");
    const tab = currentTab();
    if (tab && tab.doc) renderDocIntoPage(tab.doc, { resetScroll: false });
  }

  function toggleEditor() {
    if (state.editMode) exitEditMode();
    else enterEditMode();
  }

  async function saveActive() {
    const tab = currentTab();
    if (!tab || !tab.doc) { toast("没有可保存的文档"); return; }
    const A = api();
    if (!A) { toast("Python 后端未就绪"); return; }
    if (!tab.doc.path) return saveActiveAs();
    try {
      const res = await A.save_file(tab.doc.path, tab.doc.content);
      tab.doc.path = res.path; tab.doc.name = res.name; tab.doc.dir = res.dir;
      tab.savedContent = res.content;
      $("docTitle").textContent = res.name;
      renderTabs();
      await loadConfig();
      renderRecent();
      toast("已保存 " + res.name);
    } catch (e) {
      toast("保存失败：" + (e && e.message ? e.message : e));
    }
  }

  async function saveActiveAs() {
    const tab = currentTab();
    if (!tab || !tab.doc) { toast("没有可保存的文档"); return; }
    const A = api();
    if (!A) { toast("Python 后端未就绪"); return; }
    try {
      const res = await A.save_file_as(tab.doc.content || "", tab.doc.name || "未命名.md");
      if (!res) { toast("已取消另存为"); return; }
      tab.doc.path = res.path; tab.doc.name = res.name; tab.doc.dir = res.dir;
      tab.savedContent = res.content;
      renderDocIntoPage(tab.doc, { resetScroll: false });
      renderTabs();
      markActiveTree();
      await loadConfig();
      renderRecent();
      toast("已保存到 " + res.path);
    } catch (e) {
      toast("另存为失败：" + (e && e.message ? e.message : e));
    }
  }

  function newFile() {
    openInTab({ path: "", name: "未命名.md", dir: "", content: "" });
    enterEditMode();
  }

  // ---- 编辑器行号栏 ----
  // 行号与代码行一一对齐的前提是 textarea 不软换行（wrap="off"），
  // 否则长逻辑行占多个可视行会导致行号错位。
  let lastGutterLines = -1;
  function updateEditorGutter() {
    const ed = $("editor"), g = $("editorGutter");
    if (!ed || !g) return;
    const v = ed.value;
    let n = 1;
    for (let i = v.indexOf("\n"); i !== -1; i = v.indexOf("\n", i + 1)) n++;
    if (n !== lastGutterLines) {
      const parts = new Array(n);
      for (let i = 0; i < n; i++) parts[i] = i + 1;
      g.textContent = parts.join("\n");
      lastGutterLines = n;
    }
    g.scrollTop = ed.scrollTop;
  }

  // ---- 分栏：实时预览 + 分隔线拖拽 ----
  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreviewNow, 500);
  }
  function renderPreviewNow() {
    clearTimeout(previewTimer);
    const tab = currentTab();
    if (!tab || !tab.doc || !state.editMode) return;
    // 超大文档跳过逐键实时渲染（>200KB），退出编辑模式时统一重渲染
    if ((tab.doc.content || "").length > 200000) return;
    renderDocIntoPage(tab.doc, { resetScroll: false, scroll: $("reader").scrollTop });
  }

  function bindSplitDivider() {
    const div = $("splitDivider"), pane = $("editorPane"), wrap = editorWrap();
    if (!div || !pane || !wrap) return;
    let dragging = false, startX = 0, startW = 0, raf = 0, pendingW = 0;
    const applyW = () => {
      // 单一宽度来源：.layout 上的 --split-w（窗格与预览预留边距共用）
      $("layout").style.setProperty("--split-w", pendingW + "px");
      state.splitWidth = pendingW;
    };
    div.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startW = pane.getBoundingClientRect().width;
      div.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const maxW = wrap.clientWidth - 160;
      pendingW = Math.min(maxW, Math.max(300, startW + (e.clientX - startX)));
      if (!raf) {
        raf = requestAnimationFrame(() => { raf = 0; applyW(); }); // rAF 节流重排
      }
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      div.classList.remove("dragging");
      document.body.style.cursor = "";
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      applyW(); // 同步落地，保证拖拽结束状态确定
      if (state.splitWidth) saveConfig({ splitWidth: Math.round(state.splitWidth) });
    });
  }

  function bindEditor() {
    $("btnEdit").addEventListener("click", toggleEditor);
    $("editor").addEventListener("input", () => {
      const tab = currentTab();
      if (!tab || !tab.doc) return;
      tab.doc.content = $("editor").value;
      renderTabs();
    });
    $("editor").addEventListener("input", updateEditorGutter);
    $("editor").addEventListener("input", schedulePreview);
    $("editor").addEventListener("scroll", () => {
      const g = $("editorGutter");
      if (g) g.scrollTop = $("editor").scrollTop;
    });
    bindSplitDivider();
  }

  /* ---------------- print / export PDF ---------------- */
  // window.print() 走 Edge 打印对话框，页眉页脚（日期/标题/URL/页码）默认
  // 开启且无法编程关闭；改为经 Python 侧 WebView2 原生 PrintToPdfAsync：
  // A4、无页眉页脚、保留背景，成功后自动打开 PDF。
  async function doPrint() {
    const A = api();
    if (A && A.print_to_pdf) {
      const tab = currentTab();
      if (!tab || !tab.doc) { toast("先打开或新建一个文件"); return; }
      const base = (tab.doc.name || "document").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_");
      toast("正在生成 PDF…");
      try {
        const res = await A.print_to_pdf(base + ".pdf");
        if (res && res.ok) toast("已导出 PDF（A4）");
        else if (res && res.error === "canceled") { /* 用户取消，不打扰 */ }
        else toast("导出失败：" + ((res && res.error) || "未知错误"));
      } catch (e) {
        toast("导出失败：" + (e && e.message ? e.message : e));
      }
      return;
    }
    window.print(); // 纯浏览器模式兜底
  }

  /* ---------------- quit ---------------- */
  // window.close() 被 WebView2 脚本策略阻止，退出必须经 Python 侧销毁窗口。
  function quitNow() {
    const A = api();
    if (A && A.quit_app) { try { A.quit_app(); return; } catch (e) {} }
    window.close();
  }

  function confirmQuit() {
    const dirtyCount = state.tabs.filter(isDirty).length;
    if (!dirtyCount) { quitNow(); return; }
    const modal = $("quitModal");
    if (!modal) { quitNow(); return; }
    $("quitModalMsg").textContent = `有 ${dirtyCount} 个标签页未保存，退出将丢失修改。确定退出吗？`;
    modal.hidden = false;
  }

  function bindQuitModal() {
    const modal = $("quitModal");
    if (!modal) return;
    $("quitCancel").addEventListener("click", () => { modal.hidden = true; });
    $("quitConfirm").addEventListener("click", () => { modal.hidden = true; quitNow(); });
  }

  /* ---------------- find & replace ---------------- */
  function findBarEl() { return $("findBar"); }

  function openFind(withReplace) {
    if (state.editMode) exitEditMode();
    const bar = findBarEl();
    if (!bar) return;
    bar.hidden = false;
    $("replaceRow").hidden = !withReplace;
    state.find.visible = true;
    state.find.replaceVisible = !!withReplace;
    $("findInput").focus();
    $("findInput").select();
    if ($("findInput").value) doFind($("findInput").value);
  }

  function openReplace() { openFind(true); }

  function closeFind() {
    const bar = findBarEl();
    if (bar) bar.hidden = true;
    state.find.visible = false;
    clearFindMarks();
  }

  function clearFindMarks() {
    document.querySelectorAll("#content mark.find-hl").forEach((m) => {
      const p = m.parentNode;
      if (!p) return;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    });
    state.find.matches = [];
    state.find.idx = -1;
    updateFindCount();
  }

  function updateFindCount() {
    const f = state.find;
    $("findCount").textContent = f.matches.length
      ? `${f.idx + 1}/${f.matches.length}`
      : (f.q ? "0 结果" : "0/0");
  }

  function highlightCurrentFind() {
    const f = state.find;
    f.matches.forEach((m) => { if (m.mark) m.mark.classList.remove("find-hl-current"); });
    if (f.idx >= 0 && f.matches[f.idx] && f.matches[f.idx].mark) {
      const m = f.matches[f.idx].mark;
      m.classList.add("find-hl-current");
      m.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    updateFindCount();
  }

  function doFind(q) {
    clearFindMarks();
    state.find.q = q;
    if (!q) { updateFindCount(); return; }
    const content = $("content");
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const v = n.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(".mermaid-svg") || p.closest("mark.find-hl")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    const ql = q.toLowerCase();
    const matches = [];
    for (const node of textNodes) {
      const lower = node.nodeValue.toLowerCase();
      let i = 0;
      while ((i = lower.indexOf(ql, i)) !== -1) {
        matches.push({ node, start: i, end: i + q.length, mark: null });
        i += q.length;
      }
    }
    // wrap marks, grouped per text node (forward, no overlap)
    const byNode = new Map();
    matches.forEach((m) => {
      if (!byNode.has(m.node)) byNode.set(m.node, []);
      byNode.get(m.node).push(m);
    });
    for (const [node, ms] of byNode) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const m of ms) {
        if (m.start < pos) continue;
        if (m.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.start)));
        const mark = document.createElement("mark");
        mark.className = "find-hl";
        mark.textContent = text.slice(m.start, m.end);
        m.mark = mark;
        frag.appendChild(mark);
        pos = m.end;
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    }
    state.find.matches = matches;
    state.find.idx = matches.length ? 0 : -1;
    highlightCurrentFind();
  }

  function findStep(dir) {
    const f = state.find;
    if (!f.matches.length) return;
    f.idx = (f.idx + dir + f.matches.length) % f.matches.length;
    highlightCurrentFind();
  }

  function replaceNthInSource(src, q, r, nth) {
    const lower = src.toLowerCase(), ql = q.toLowerCase();
    let idx = -1, count = 0;
    while ((idx = lower.indexOf(ql, idx + 1)) !== -1) {
      if (count === nth) return src.slice(0, idx) + r + src.slice(idx + q.length);
      count++;
    }
    return null;
  }

  function replaceAllInSource(src, q, r) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let n = 0;
    const out = src.replace(re, () => { n++; return r; });
    return { out, n };
  }

  function replaceOne() {
    const tab = currentTab();
    const q = $("findInput").value;
    if (!tab || !tab.doc || !q) return;
    const f = state.find;
    if (!f.matches.length) { toast("无匹配"); return; }
    const r = $("replaceInput").value;
    const next = replaceNthInSource(tab.doc.content, q, r, f.idx);
    if (next == null) { toast("替换失败"); return; }
    tab.doc.content = next;
    renderTabs();
    renderDocIntoPage(tab.doc, { resetScroll: false });
    toast("已替换 1 处");
  }

  function replaceAll() {
    const tab = currentTab();
    const q = $("findInput").value;
    if (!tab || !tab.doc || !q) return;
    const r = $("replaceInput").value;
    const { out, n } = replaceAllInSource(tab.doc.content, q, r);
    if (!n) { toast("无匹配"); return; }
    tab.doc.content = out;
    renderTabs();
    renderDocIntoPage(tab.doc, { resetScroll: false });
    toast(`已替换 ${n} 处`);
  }

  function bindFindBar() {
    const bar = findBarEl();
    if (!bar) return;
    let debounce = null;
    $("findInput").addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => doFind($("findInput").value.trim()), 200);
    });
    $("findInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
    });
    $("replaceInput").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeFind(); }
      else if (e.key === "Enter") { e.preventDefault(); replaceOne(); }
    });
    $("findPrev").addEventListener("click", () => findStep(-1));
    $("findNext").addEventListener("click", () => findStep(1));
    $("findClose").addEventListener("click", closeFind);
    $("findToggleReplace").addEventListener("click", () => {
      const row = $("replaceRow");
      row.hidden = !row.hidden;
      state.find.replaceVisible = !row.hidden;
      if (!row.hidden) $("replaceInput").focus();
    });
    $("replaceOne").addEventListener("click", replaceOne);
    $("replaceAll").addEventListener("click", replaceAll);
  }

  /* ---------------- mermaid zoom & pan ---------------- */
  function applyMermaidZoom(root) {
    root.querySelectorAll(".mermaid-block[data-zoom]").forEach((b) => {
      const svg = b.querySelector(".mermaid-svg svg");
      if (svg && MDRender.setMermaidSvgZoom) MDRender.setMermaidSvgZoom(svg, parseFloat(b.dataset.zoom || "1"));
    });
  }

  function bindMermaidControls(root) {
    root.querySelectorAll(".mermaid-block:not([data-zoom-bound])").forEach((block) => {
      block.setAttribute("data-zoom-bound", "1");
      const head = block.querySelector(".code-head");
      if (!head) return;
      const ctrl = document.createElement("span");
      ctrl.className = "mermaid-zoomctrl";
      ctrl.innerHTML =
        '<button class="mz-btn" data-act="out" title="缩小">−</button>' +
        '<input class="mz-pct" type="text" inputmode="numeric" spellcheck="false" value="100%" title="输入缩放百分比（40–400），回车确认">' +
        '<button class="mz-btn" data-act="in" title="放大">+</button>' +
        '<button class="mz-btn" data-act="reset" title="恢复原始大小">⟲</button>';
      head.appendChild(ctrl);

      const apply = () => {
        const k = parseFloat(block.dataset.zoom || "1");
        const svg = block.querySelector(".mermaid-svg svg");
        if (svg && MDRender.setMermaidSvgZoom) MDRender.setMermaidSvgZoom(svg, k);
        ctrl.querySelector(".mz-pct").value = Math.round(k * 100) + "%";
        const vp = block.querySelector(".mermaid-svg");
        if (vp) vp.classList.toggle("zoomed", k > 1.001);
      };

      // 手动输入百分比：回车或失焦提交，非法输入恢复当前值
      const pctInput = ctrl.querySelector(".mz-pct");
      const commitPct = () => {
        const v = parseInt(pctInput.value, 10);
        if (isFinite(v)) {
          const k = Math.min(4, Math.max(0.4, v / 100));
          block.dataset.zoom = String(k);
          apply();
        } else {
          apply(); // 恢复为当前缩放值
        }
      };
      pctInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commitPct(); pctInput.blur(); } // 提交幂等，blur 兜底
        else if (e.key === "Escape") { e.preventDefault(); apply(); pctInput.blur(); }
      });
      pctInput.addEventListener("focus", () => pctInput.select());
      pctInput.addEventListener("blur", commitPct);
      ctrl.addEventListener("click", (e) => {
        const btn = e.target.closest(".mz-btn");
        if (!btn) return;
        let k = parseFloat(block.dataset.zoom || "1");
        if (btn.dataset.act === "in") k = Math.min(4, k * 1.25);
        else if (btn.dataset.act === "out") k = Math.max(0.4, k / 1.25);
        else k = 1;
        block.dataset.zoom = String(k);
        apply();
      });

      const viewport = block.querySelector(".mermaid-svg");
      if (viewport) {
        let panning = false, sx = 0, sy = 0, sl = 0, st = 0;
        viewport.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          if (viewport.scrollWidth <= viewport.clientWidth &&
              viewport.scrollHeight <= viewport.clientHeight) return;
          panning = true;
          sx = e.clientX; sy = e.clientY;
          sl = viewport.scrollLeft; st = viewport.scrollTop;
          viewport.classList.add("panning");
          e.preventDefault();
        });
        window.addEventListener("mousemove", (e) => {
          if (!panning) return;
          viewport.scrollLeft = sl - (e.clientX - sx);
          viewport.scrollTop = st - (e.clientY - sy);
        });
        window.addEventListener("mouseup", () => {
          if (!panning) return;
          panning = false;
          viewport.classList.remove("panning");
        });
      }
      apply();
    });
  }

  /* ---------------- tab session ---------------- */
  let sessionTimer = null;
  function saveSessionDebounced() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSession, 400);
  }
  function saveSession() {
    const paths = state.tabs.map((t) => (t.doc && t.doc.path) || "").filter(Boolean);
    saveConfig({ tabs: paths });
  }
  async function restoreSession() {
    const paths = (state.cfg.tabs || []).filter(Boolean).slice(0, 20);
    if (!paths.length) return;
    const A = api();
    if (!A) return;
    for (const p of paths) {
      try {
        const res = await A.open_path(p);
        if (res && res.kind === "doc") {
          state.tabs.push({ id: state.nextTabId++, doc: { path: res.path, name: res.name, dir: res.dir, content: res.content }, scroll: 0, savedContent: res.content, confirmClose: false });
        }
      } catch (e) {}
    }
    if (!state.tabs.length) return;
    if (state.activeTabId == null) activateTab(state.tabs[0].id);
    else renderTabs();
  }

  function resolveImages(root, baseDir) {
    const A = api();
    if (!A) return;
    root.querySelectorAll("img[data-src]").forEach(async (img) => {
      const src = img.getAttribute("data-src");
      if (/^(data:|https?:|file:)/i.test(src)) return;
      try {
        const data = await A.read_asset(baseDir, src);
        if (data) img.src = data;
      } catch (e) { /* leave as-is */ }
    });
  }

  function makeCodeCopyable(root) {
    root.querySelectorAll(".code-copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pre = document.getElementById(btn.getAttribute("data-code-id"));
        if (!pre) return;
        const text = pre.innerText;
        try {
          await navigator.clipboard.writeText(text);
        } catch (e) {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch (e2) {}
          ta.remove();
        }
        btn.textContent = "已复制";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1400);
      });
    });
  }

  function bindContentLinks(root) {
    root.querySelectorAll("a[data-mdlink]").forEach((a) => {
      a.addEventListener("click", (e) => {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("#")) {
          e.preventDefault();
          const id = decodeURIComponent(href.slice(1));
          const target = document.getElementById(id);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        e.preventDefault();
        if (/^(https?:|mailto:)/i.test(href)) {
          if (api()) api().open_external(href);
          else window.open(href, "_blank");
        } else if (state.doc) {
          const sep = state.doc.dir.includes("\\") ? "\\" : "/";
          const candidate = state.doc.dir + sep + decodeURIComponent(href.split("#")[0]);
          const A = api();
          if (!A) return;
          A.open_path(candidate).then((res) => {
            if (res && res.kind === "doc") {
              const target = { path: res.path, name: res.name, dir: res.dir, content: res.content };
              if (e.ctrlKey || e.metaKey) {
                openInTab(target);            // Ctrl+点击：新标签
              } else {
                const cur = currentTab();
                if (cur) activateTab(cur.id, target);   // 同标签页导航
                else openInTab(target);
              }
              toast("已打开 " + res.name);
            } else {
              toast("无法打开链接目标");
            }
          });
        }
      });
    });
  }

  function bindImageLightbox(root) {
    root.querySelectorAll("img").forEach((img) => {
      img.addEventListener("click", () => {
        if (!img.src) return;
        let lb = document.querySelector(".lightbox");
        if (!lb) {
          lb = document.createElement("div");
          lb.className = "lightbox";
          lb.innerHTML = '<img alt="">';
          lb.addEventListener("click", () => lb.classList.remove("show"));
          document.body.appendChild(lb);
        }
        lb.querySelector("img").src = img.src;
        lb.classList.add("show");
      });
    });
  }

  /* ---------------- TOC ---------------- */
  function buildToc(root) {
    const list = $("tocList");
    const heads = root.querySelectorAll("h1,h2,h3,h4,h5,h6");
    if (!heads.length) {
      list.innerHTML = '<div class="empty-hint">本文档暂无标题</div>';
      return;
    }
    list.innerHTML = "";
    heads.forEach((h) => {
      const item = document.createElement("div");
      item.className = "toc-item";
      item.dataset.level = h.tagName[1];
      item.textContent = h.textContent;
      item.title = h.textContent;
      item.addEventListener("click", () => {
        h.scrollIntoView({ behavior: "smooth", block: "start" });
        document.querySelectorAll(".toc-item.active").forEach((x) => x.classList.remove("active"));
        item.classList.add("active");
      });
      list.appendChild(item);
    });
  }

  function updateMeta(doc) {
    if (!doc) { $("docMeta").textContent = "—"; return; }
    const chars = (doc.content || "").length;
    const lines = (doc.content || "").split("\n").length;
    const readMin = Math.max(1, Math.round(chars / 400));
    $("docMeta").textContent = `${chars} 字符 · ${lines} 行 · 约 ${readMin} 分钟`;
  }

  /* ---------------- progress + active toc ---------------- */
  function updateProgress() {
    const reader = $("reader");
    const max = reader.scrollHeight - reader.clientHeight;
    const pct = max > 0 ? (reader.scrollTop / max) * 100 : 0;
    $("readProgress").style.width = pct.toFixed(2) + "%";
  }

  function updateActiveToc() {
    const reader = $("reader");
    const heads = $("content").querySelectorAll("h1,h2,h3,h4,h5,h6");
    if (!heads.length) return;
    const top = reader.getBoundingClientRect().top + 40;
    let activeIdx = -1;
    heads.forEach((h, i) => { if (h.getBoundingClientRect().top <= top) activeIdx = i; });
    const items = $("tocList").querySelectorAll(".toc-item");
    items.forEach((it, i) => it.classList.toggle("active", i === activeIdx));
  }

  /* ---------------- file tree ---------------- */
  function renderFolder(data) {
    state.folder = data;
    $("folderHead").hidden = false;
    $("folderName").textContent = data.name || data.folder;
    $("folderName").title = data.folder;
    const tree = $("fileTree");
    tree.innerHTML = "";
    if (!data.items || !data.items.length) {
      tree.innerHTML = '<div class="empty-hint">该文件夹内没有 Markdown 文件</div>';
      return;
    }
    data.items.forEach((item) => tree.appendChild(buildNode(item)));
    markActiveTree();
  }

  function buildNode(item) {
    const node = document.createElement("div");
    node.className = "node";
    const row = document.createElement("div");
    row.className = "node-row";
    row.dataset.path = item.path;

    if (item.type === "dir") {
      row.innerHTML =
        '<svg class="caret" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<svg class="ico" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>' +
        '<span class="label"></span>';
      row.querySelector(".label").textContent = item.name;

      const children = document.createElement("div");
      children.className = "node-children";

      row.addEventListener("click", async () => {
        const opening = !node.classList.contains("open");
        node.classList.toggle("open");
        if (opening && !children.dataset.loaded) {
          children.dataset.loaded = "1";
          const A = api();
          if (A) {
            try {
              const subs = await A.list_subfolder(item.path);
              if (subs && subs.length) subs.forEach((s) => children.appendChild(buildNode(s)));
              else children.innerHTML = '<div class="empty-hint" style="padding:8px;font-size:11.5px">（空）</div>';
            } catch (e) {}
          }
        }
      });
      node.appendChild(row);
      node.appendChild(children);
    } else {
      row.innerHTML =
        '<svg class="ico" viewBox="0 0 24 24"><path d="M6.5 3.5h7l4.5 4.5v12.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20.5V5a1.5 1.5 0 0 1 1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13 3.5V8h4.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
        '<span class="label"></span>';
      row.querySelector(".label").textContent = item.name;
      row.title = item.path;
      row.addEventListener("click", () => openFile(item.path));
      node.appendChild(row);
    }
    return node;
  }

  function markActiveTree() {
    const path = state.doc && state.doc.path;
    document.querySelectorAll(".node-row").forEach((r) => {
      r.classList.toggle("active", !!path && r.dataset.path === path);
    });
  }

  /* ---------------- recent ---------------- */
  function renderRecent() {
    const list = $("recentList");
    const recent = (state.cfg.recent || []).filter(Boolean);
    if (!recent.length) {
      list.innerHTML = '<div class="empty-hint">暂无最近打开记录</div>';
      return;
    }
    list.innerHTML = "";
    recent.forEach((p) => {
      const parts = p.split(/[\\/]/);
      const name = parts.pop();
      const dir = parts.join("\\");
      const el = document.createElement("div");
      el.className = "recent-item";
      const n = document.createElement("div"); n.className = "r-name"; n.textContent = name;
      const d = document.createElement("div"); d.className = "r-dir"; d.textContent = dir;
      el.appendChild(n); el.appendChild(d);
      el.title = p;
      el.addEventListener("click", () => openFile(p));
      list.appendChild(el);
    });
  }

  /* ---------------- actions ---------------- */
  async function openFile(path) {
    const A = api();
    if (!A) { toast("Python 后端未就绪"); return; }
    try {
      const res = path ? await A.open_path(path) : await A.pick_file();
      if (!res) return;
      if (res.kind === "folder") { renderFolder(res); return; }
      renderDoc({ path: res.path, name: res.name, dir: res.dir, content: res.content });
      markActiveTree();
      await loadConfig();
      renderRecent();
    } catch (e) {
      toast("打开失败：" + (e && e.message ? e.message : e));
    }
  }

  async function openFolder() {
    const A = api();
    if (!A) return;
    try {
      const res = await A.pick_folder();
      if (res) renderFolder(res);
    } catch (e) {
      toast("打开文件夹失败");
    }
  }

  async function reloadDoc() {
    const A = api();
    if (!A || !state.doc) return;
    try {
      const res = await A.reload_doc(state.doc.path);
      if (res) {
        renderDoc({ path: res.path, name: res.name, dir: res.dir, content: res.content });
        toast("已重新加载");
      } else toast("文件不可用");
    } catch (e) { toast("重新加载失败"); }
  }

  /* ---------------- sidebar ---------------- */
  function toggleSidebar(force) {
    const layout = $("layout");
    const hidden = layout.classList.contains("sidebar-hidden");
    // force === true -> show, force === false -> hide, omitted -> toggle
    const show = typeof force === "boolean" ? force : hidden;
    layout.classList.toggle("sidebar-hidden", !show);
    saveConfig({ sidebar: show });
  }

  function switchTab(tab) {
    document.querySelectorAll(".stab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === tab));
    if (tab === "recent") renderRecent();
  }

  /* ---------------- debug/test export ---------------- */
  window.__MDR__ = { renderDoc, openFile, state, boot, switchTab, openInTab, closeTab, activateTab, renderTabs, doPrint, renderPreviewNow };

  /* ---------------- 应用内菜单栏控制器 ---------------- */
  // 菜单动作统一走 __mdr.menu(action)（与快捷键/原生菜单时代同一管线）。
  (function setupMenubar() {
    const bar = document.getElementById("menubar");
    if (!bar) return;
    const open = () => bar.querySelector(".menubar-menu.open");
    function closeAll() {
      bar.querySelectorAll(".menubar-menu.open").forEach((m) => m.classList.remove("open"));
    }
    bar.querySelectorAll(".menubar-top").forEach((top) => {
      const menu = top.parentElement;
      top.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = menu.classList.contains("open");
        closeAll();
        if (!wasOpen) menu.classList.add("open");
      });
      top.addEventListener("mouseenter", () => {
        if (open() && open() !== menu) { closeAll(); menu.classList.add("open"); }
      });
    });
    bar.querySelectorAll(".menubar-entry").forEach((en) => {
      en.addEventListener("click", () => {
        closeAll();
        const action = en.getAttribute("data-action");
        if (action) window.__mdr.menu(action);
      });
    });
    document.addEventListener("click", (e) => {
      if (open() && !bar.contains(e.target)) closeAll();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && open()) closeAll();
    });
  })();

  /* ---------------- native menu dispatcher ---------------- */
  window.__mdr = window.__mdr || {};
  window.__mdr.menu = function (action) {
    switch (action) {
      case "file.open": openFile(); break;
      case "file.openFolder": openFolder(); break;
      case "file.new": newFile(); break;
      case "file.save": saveActive(); break;
      case "file.saveAs": saveActiveAs(); break;
      case "file.closeTab": if (state.activeTabId != null) closeTab(state.activeTabId); break;
      case "file.quit": confirmQuit(); break;
      case "edit.toggleEdit": toggleEditor(); break;
      case "edit.find": openFind(state.find.replaceVisible); break;
      case "edit.replace": openReplace(); break;
      case "view.sidebar": toggleSidebar(); break;
      case "view.toc": toggleSidebar(true); switchTab("toc"); break;
      case "view.theme": toggleTheme(); break;
      case "view.zoomIn": setZoom(state.zoom + 0.1); break;
      case "view.zoomOut": setZoom(state.zoom - 0.1); break;
      case "view.zoomReset": setZoom(1); break;
      case "view.reload": reloadDoc(); break;
      case "view.print": doPrint(); break;
      case "help.about": api() && api().get_version && api().get_version().then((v) =>
        toast(v.name + " v" + v.version + " · 离线 Markdown 阅读器")).catch(() => {}); break;
    }
  };
  // merge: keep the menu dispatcher installed above
  Object.assign(window.__mdr, {
    onExternalOpen: async function (paths) {
      if (!paths || !paths.length) return;
      const A = api();
      if (!A) return;
      const opened = [];
      let folderRes = null;
      for (const p of paths) {
        try {
          const res = await A.open_path(p);
          if (res && res.kind === "doc") {
            openInTab({ path: res.path, name: res.name, dir: res.dir, content: res.content });
            opened.push(res.path);
          } else if (res && res.kind === "folder") {
            folderRes = res;
          }
        } catch (e) {}
      }
      if (folderRes) renderFolder(folderRes);
      if (opened.length) {
        const first = state.tabs.find((t) => t.doc && t.doc.path === opened[0]);
        if (first && state.activeTabId !== first.id) activateTab(first.id);
        markActiveTree();
        await loadConfig();
        renderRecent();
      } else if (!folderRes) {
        toast("无法打开该文件");
      }
    },
  });

  /* ---------------- drop zone ---------------- */
  function setupDropZone() {
    const overlay = $("dropOverlay");
    if (!overlay) return;
    let depth = 0;

    window.addEventListener("dragenter", (e) => { depth++; overlay.classList.add("show"); });
    window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove("show"); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove("show");
      const A = api();
      if (!A) return;
      try {
        const paths = await A.take_dropped();
        if (paths && paths.length) window.__mdr.onExternalOpen(paths);
      } catch (err) {}
    });

    setInterval(async () => {
      const A = api();
      if (!A) return;
      if (!startupConsumed) { try { await consumeStartupFile(); } catch (e) {} }
      try {
        const paths = await A.take_dropped();
        if (paths && paths.length) window.__mdr.onExternalOpen(paths);
      } catch (err) {}
    }, 800);
  }

  /* ---------------- keyboard ---------------- */
  function setupKeyboard() {
    window.addEventListener("keydown", (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === "o") { e.preventDefault(); if (e.shiftKey) openFolder(); else openFile(); }
      else if (ctrl && k === "b") { e.preventDefault(); toggleSidebar(); }
      else if (ctrl && k === "t") { e.preventDefault(); toggleSidebar(true); switchTab("toc"); }
      else if (ctrl && k === "d") { e.preventDefault(); toggleTheme(); }
      else if (ctrl && k === "p") { e.preventDefault(); doPrint(); }
      else if (ctrl && k === "w") { e.preventDefault(); if (state.activeTabId != null) closeTab(state.activeTabId); }
      else if (ctrl && e.key === "Tab") { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
      else if (ctrl && k === "s") { e.preventDefault(); if (e.shiftKey) saveActiveAs(); else saveActive(); }
      else if (ctrl && k === "e") { e.preventDefault(); toggleEditor(); }
      else if (ctrl && k === "n") { e.preventDefault(); newFile(); }
      else if (ctrl && k === "f") { e.preventDefault(); openFind(state.find.replaceVisible); }
      else if (ctrl && k === "h") { e.preventDefault(); openReplace(); }
      else if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom(state.zoom + 0.1); }
      else if (ctrl && e.key === "-") { e.preventDefault(); setZoom(state.zoom - 0.1); }
      else if (ctrl && e.key === "0") { e.preventDefault(); setZoom(1); }
      else if (e.key === "F5") { e.preventDefault(); reloadDoc(); }
      else if (e.key === "Escape") {
        if (state.find.visible) { closeFind(); }
        else {
          const lb = document.querySelector(".lightbox.show");
          if (lb) lb.classList.remove("show");
        }
      }
    });
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    const cfg = await loadConfig();
    applyTheme(cfg.theme || "light");
    state.zoom = 1;
    applyZoom();
    if (cfg.sidebar === false) $("layout").classList.add("sidebar-hidden");
    WELCOME_HTML = $("content").innerHTML;

    $("btnOpen").addEventListener("click", () => openFile());
    $("btnFolder").addEventListener("click", openFolder);
    $("btnReload").addEventListener("click", reloadDoc);
    $("btnSidebar").addEventListener("click", () => toggleSidebar());
    $("btnToc").addEventListener("click", () => { toggleSidebar(true); switchTab("toc"); });
    $("btnTheme").addEventListener("click", toggleTheme);
    $("btnZoomIn").addEventListener("click", () => setZoom(state.zoom + 0.1));
    $("btnZoomOut").addEventListener("click", () => setZoom(state.zoom - 0.1));
    $("zoomLabel").addEventListener("click", () => setZoom(1));
    $("btnPrint").addEventListener("click", doPrint);
    $("btnNewTab").addEventListener("click", () => openFile());
    $("btnRefreshFolder").addEventListener("click", async () => {
      if (!state.folder || !api()) return;
      try { renderFolder(await api().list_folder(state.folder.folder)); } catch (e) {}
    });

    bindWelcome();

    document.querySelectorAll(".stab").forEach((b) => {
      b.addEventListener("click", () => switchTab(b.dataset.tab));
    });

    const reader = $("reader");
    let ticking = false;
    reader.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { updateProgress(); updateActiveToc(); ticking = false; });
    });

    setupKeyboard();
    setupDropZone();
    bindEditor();
    bindQuitModal();
    bindFindBar();
    // Ctrl+滚轮 全局内容缩放
    window.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(state.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    renderRecent();

    // Open a file passed on the command line ("Open with" / drag onto exe).
    await consumeStartupFile();
    // 恢复上次会话的标签页（仅路径仍存在的）
    await restoreSession();
  }

  function bindWelcome() {
    $("ctaOpen").addEventListener("click", () => openFile());
    $("ctaFolder").addEventListener("click", openFolder);
  }

  let startupConsumed = false;
  async function consumeStartupFile() {
    if (startupConsumed) return;
    const A = api();
    if (!A || !A.take_startup_file) return;
    try {
      const st = await A.take_startup_file();
      if (!st) { startupConsumed = true; return; }
      startupConsumed = true;
      if (st.kind === "doc") {
        renderDoc({ path: st.path, name: st.name, dir: st.dir, content: st.content });
        markActiveTree();
        await loadConfig();
        renderRecent();
      } else if (st.kind === "folder") {
        renderFolder(st);
      }
    } catch (e) { /* retry later via the interval below */ }
  }

  /* ---------------- self test (dev only, #selftest=1) ---------------- */
  /* 两阶段：early(DOMContentLoaded，监听器未绑) 只测渲染；final(pywebviewready
     后 300ms) 跑完整 UI 流程。main.py 只接受 phase==="final" 的结果。 */
  function runSelfTest(isFinal) {
    const results = {};
    try {
      const md = [
        "# Title", "", "**bold** *it* ~~del~~ ==mark== `code`", "",
        "- a", "  - nested", "", "| h | h2 |", "| - | - |", "| c | c2 |", "",
        "```python", "def f(): return 1", "```", "", "> quote", "",
        "ref[^1]", "", "[^1]: note", "",
        "<script>window.__XSS=1<\/script>",
        "<img src=x onerror=\"window.__XSS=2\">",
        "[bad](javascript:window.__XSS=3)",
        "![bad](javascript:window.__XSS=4)",
      ].join("\n");
      const html = MDRender.parse(md);
      const box = document.createElement("div");
      box.className = "markdown-body";
      box.innerHTML = html;
      document.body.appendChild(box);

      const q = (s) => box.querySelector(s);
      results.h1 = !!q("h1");
      results.bold = !!q("strong");
      results.del = !!q("del");
      results.mark = !!q("mark");
      results.table = !!q("table");
      results.nestedList = box.querySelectorAll("ul").length >= 2;
      results.codeKw = !!q(".tok-kw");
      results.blockquote = !!q("blockquote");
      results.footnote = !!q(".footnote-def");
      results.noScriptTag = box.querySelectorAll("script").length === 0;
      results.noOnerror = !box.querySelector("img[onerror]");
      results.noJsHref = !box.querySelector('a[href^="javascript:"]');
      results.xssDidNotRun = typeof window.__XSS === "undefined";
      box.remove();

      // regression: indented footnote definitions
      const ind = MDRender.parse("body text\n\n  [^2]: indented note");
      const box2 = document.createElement("div");
      box2.innerHTML = ind;
      results.indentedFootnote = !!box2.querySelector(".footnote-def");
      results.footnoteNotParagraph = !box2.querySelector("p .fn-ref") || !!box2.querySelector(".footnote-defs");

      // regression: task list renders a checkbox
      const tl = MDRender.parse("- [x] done\n- [ ] todo");
      const box3 = document.createElement("div");
      box3.innerHTML = tl;
      results.taskCheckbox = box3.querySelectorAll("input[type=checkbox]").length === 2;

      // robustness: CRLF input and empty input must not throw
      MDRender.parse("a\r\nb\r");
      MDRender.parse("");
      results.robustInput = true;

      // perf smoke: 200KB doc renders in < 2s
      const big = Array.from({ length: 2000 }, (_, i) => `## 节 ${i}\n\n段落${i} **粗** *斜* \`code\`\n`).join("\n");
      const t0 = performance.now();
      MDRender.parse(big);
      results.bigDocMs = Math.round(performance.now() - t0);
      results.bigDocFast = results.bigDocMs < 2000;

      // ---- UI flow tests (drive real DOM through __MDR__ hooks) ----
      // 仅在 final 阶段执行（此时 boot() 已绑定全部监听器）
      if (isFinal) {
      const M = window.__MDR__;
      results.uiHooksPresent = !!(M && M.renderDoc && M.boot && M.switchTab && M.state);

      // renderDoc: title, meta, TOC, copy button, link/img binding
      M.renderDoc({ path: "C:\\test\\sample.md", name: "sample.md", dir: "C:\\test", content: "# 大标题\n\n## 小节A\n\n正文 **b**\n\n```py\nx=1\n```\n\n[链](https://a.com) ![图](p.png)\n" });
      results.uiDocTitle = $("docTitle").textContent === "sample.md";
      results.uiTocBuilt = $("tocList").querySelectorAll(".toc-item").length >= 2;
      results.uiMetaSet = $("docMeta").textContent.includes("字符");
      results.uiCopyBtn = !!$("content").querySelector(".code-copy");
      results.uiImgDataSrc = !!$("content").querySelector("img[data-src]");
      results.uiLinkBound = !!$("content").querySelector("a[data-mdlink]");

      // theme toggle both ways
      const before = document.documentElement.getAttribute("data-theme");
      toggleTheme();
      const mid = document.documentElement.getAttribute("data-theme");
      toggleTheme();
      const after = document.documentElement.getAttribute("data-theme");
      results.uiThemeToggle = before !== mid && before === after;

      // zoom clamps and applies CSS var
      setZoom(3);
      results.uiZoomClampHigh = state.zoom <= 2.5;
      setZoom(0.1);
      results.uiZoomClampLow = state.zoom >= 0.6;
      setZoom(1);
      results.uiZoomLabel = $("zoomLabel").textContent === "100%";

      // tabs switch panels
      switchTab("toc");
      results.uiTabToc = document.querySelector('.panel[data-panel="toc"]').classList.contains("active");
      switchTab("files");
      results.uiTabFiles = document.querySelector('.panel[data-panel="files"]').classList.contains("active");

      // file tree renders dirs first and marks active doc
      renderFolder({ folder: "C:\\test", name: "test", items: [
        { type: "dir", name: "sub", path: "C:\\test\\sub" },
        { type: "file", name: "sample.md", path: "C:\\test\\sample.md" },
        { type: "file", name: "other.md", path: "C:\\test\\other.md" },
      ] });
      results.uiTreeRows = $("fileTree").querySelectorAll(".node-row").length === 3;
      results.uiTreeActive = Array.from($("fileTree").querySelectorAll(".node-row"))
        .some((r) => r.classList.contains("active") && r.dataset.path === "C:\\test\\sample.md");
      results.uiFolderHead = $("folderHead").hidden === false && $("folderName").textContent === "test";

      // recent list
      state.cfg.recent = ["C:\\x\\甲.md", "C:\\y\\乙.md"];
      renderRecent();
      results.uiRecent = $("recentList").querySelectorAll(".recent-item").length === 2;

      // keyboard: Ctrl+D toggles theme, Escape closes lightbox
      const kTheme0 = document.documentElement.getAttribute("data-theme");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
      const kTheme1 = document.documentElement.getAttribute("data-theme");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
      results.uiKeyTheme = kTheme0 !== kTheme1;

      // image lightbox opens on click and closes on Escape
      const img = $("content").querySelector("img");
      let lbOk = false;
      if (img) {
        img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const lb = document.querySelector(".lightbox.show");
        lbOk = !!lb;
        if (lb) {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          lbOk = lbOk && !document.querySelector(".lightbox.show");
        }
      }
      results.uiLightbox = lbOk;

      // progress bar reflects scroll state (0 at top)
      results.uiProgressAtTop = parseFloat($("readProgress").style.width) === 0;

      // sidebar toggle force-show semantics (regression)
      $("layout").classList.add("sidebar-hidden");
      toggleSidebar(true);
      results.uiSidebarForceShow = !$("layout").classList.contains("sidebar-hidden");
      toggleSidebar(false);
      results.uiSidebarForceHide = $("layout").classList.contains("sidebar-hidden");
      $("layout").classList.remove("sidebar-hidden");

      // ---- tab flow tests ----
      while (state.tabs.length) closeTab(state.tabs[0].id);
      M.renderDoc({ path: "C:\\t\\a.md", name: "a.md", dir: "C:\\t", content: "# A\n\n内容A" });
      M.renderDoc({ path: "C:\\t\\b.md", name: "b.md", dir: "C:\\t", content: "# B\n\n内容B" });
      results.uiTabsOpen = $("tabs").querySelectorAll(".tab").length === 2;
      results.uiTabActiveB = $("tabs").querySelector(".tab.active .tab-label").textContent === "b.md";
      results.uiTabbarVisible = $("tabbar").hidden === false;
      $("tabs").querySelector(".tab").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      results.uiTabSwitch = $("docTitle").textContent === "a.md" && $("content").textContent.includes("内容A");
      closeTab(state.activeTabId);
      results.uiTabClose = $("tabs").querySelectorAll(".tab").length === 1 && $("docTitle").textContent === "b.md";
      closeTab(state.activeTabId);
      results.uiTabWelcome = $("tabs").querySelectorAll(".tab").length === 0
        && $("tabbar").hidden === true
        && $("content").innerHTML.includes("打开 Markdown 文件");

      // ---- editor / save flow ----
      newFile();
      results.uiEditorOpens = state.editMode === true && $("editorWrap").hidden === false;
      $("editor").value = "# 新文件\n\nHello 编辑器";
      $("editor").dispatchEvent(new Event("input", { bubbles: true }));
      results.uiDirtyDot = $("tabs").querySelector(".tab.active .tab-label").textContent.startsWith("● ");
      results.uiEditorContentSync = currentTab().doc.content === "# 新文件\n\nHello 编辑器";
      exitEditMode();
      results.uiEditorExits = state.editMode === false && $("editorWrap").hidden === true;
      results.uiPreviewRerenders = $("content").textContent.includes("Hello 编辑器");
      results.uiDirtyPersist = $("tabs").querySelector(".tab.active .tab-label").textContent.startsWith("● ");
      // Ctrl+E 再进编辑模式
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true }));
      results.uiCtrlE = state.editMode === true;
      // 未保存关闭需二次确认
      const dirtyId = state.activeTabId;
      closeTab(dirtyId);
      results.uiDirtyGuard = state.tabs.some((t) => t.id === dirtyId);
      closeTab(dirtyId);
      results.uiDirtySecondClose = !state.tabs.some((t) => t.id === dirtyId) && state.tabs.length === 0;
      state.editMode = false;
      if (editorWrap()) editorWrap().hidden = true;

      // ---- quit confirm flow ----
      // 无脏标签：直接退出 —— 自检里不能真退，跳过；仅测脏标签确认弹窗。
      M.renderDoc({ path: "C:\\t\\q.md", name: "q.md", dir: "C:\\t", content: "# Q" });
      const qTab = currentTab();
      qTab.doc.content = "# Q 改过的内容";
      window.__mdr.menu("file.quit");
      results.uiQuitModalShows = $("quitModal").hidden === false
        && $("quitModalMsg").textContent.includes("1 个标签页未保存");
      $("quitCancel").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      results.uiQuitCancelAlive = $("quitModal").hidden === true && state.tabs.length === 1;
      // 清理：关闭脏标签（二次确认）避免影响后续
      closeTab(qTab.id);
      closeTab(qTab.id);

      // ---- mermaid flow ----
      M.renderDoc({ path: "C:\\t\\m.md", name: "m.md", dir: "C:\\t", content: "```mermaid\nflowchart LR\nA[开始] --> B[结束]\n```\n\n```py\nx=1\n```" });
      results.uiMermaidSvg = !!$("content").querySelector(".mermaid-svg svg");
      results.uiMermaidNodes = $("content").querySelectorAll(".me-node").length === 2;
      results.uiMermaidEdges = $("content").querySelectorAll(".me-edge").length === 1;
      results.uiMermaidCodeOk = !!$("content").querySelector(".code-block pre code");
      closeTab(state.activeTabId);

      // ---- mermaid zoom controls ----
      M.renderDoc({ path: "C:\\t\\mz.md", name: "mz.md", dir: "C:\\t", content: "```mermaid\nflowchart LR\nA --> B --> C\n```" });
      const mzBlock = $("content").querySelector(".mermaid-block");
      results.uiMzControls = !!mzBlock && !!mzBlock.querySelector(".mermaid-zoomctrl");
      const mzIn = mzBlock.querySelector('[data-act="in"]');
      mzIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const mzSvg = mzBlock.querySelector(".mermaid-svg svg");
      results.uiMzZoomIn = mzBlock.dataset.zoom === "1.25"
        && mzSvg.style.maxWidth === "none" && /px$/.test(mzSvg.style.width) && mzSvg.style.zoom === ""
        && mzBlock.querySelector(".mz-pct").value === "125%";
      mzBlock.querySelector('[data-act="reset"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
      results.uiMzReset = mzBlock.dataset.zoom === "1" && mzBlock.querySelector(".mz-pct").value === "100%"
        && mzSvg.style.width === "" && mzSvg.style.maxWidth === "";
      // 手动输入百分比
      const pctInput = mzBlock.querySelector(".mz-pct");
      pctInput.value = "180%";
      pctInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      results.uiMzPctInput = mzBlock.dataset.zoom === "1.8" && pctInput.value === "180%"
        && parseFloat(mzSvg.style.width) > 0 && mzSvg.style.maxWidth === "none";
      pctInput.value = "abc";
      pctInput.dispatchEvent(new Event("blur"));
      results.uiMzPctInvalid = pctInput.value === "180%" && mzBlock.dataset.zoom === "1.8";
      pctInput.value = "9999%";
      pctInput.dispatchEvent(new Event("blur"));
      results.uiMzPctClamp = mzBlock.dataset.zoom === "4" && pctInput.value === "400%";
      mzBlock.querySelector('[data-act="reset"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
      closeTab(state.activeTabId);

      // ---- 超宽 mermaid 图（固有宽 > 栏宽，max-width 钳制场景）----
      const wideSrc = "```mermaid\nflowchart TB\n"
        + Array.from({ length: 12 }, (_, i) => 'N' + i + '["可靠性指标定义节点' + i + '"]').join("\n") + "\n```";
      M.renderDoc({ path: "C:\\t\\mzw.md", name: "mzw.md", dir: "C:\\t", content: wideSrc });
      const zwBlock = $("content").querySelector(".mermaid-block");
      const zwSvg = zwBlock.querySelector(".mermaid-svg svg");
      const zwVp = zwBlock.querySelector(".mermaid-svg");
      results.uiMzWideFit = zwSvg.getBoundingClientRect().width <= zwVp.clientWidth + 1; // 100% 收缩适配
      zwBlock.querySelector('[data-act="in"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
      results.uiMzWideOverflow = parseFloat(zwSvg.style.width) > zwVp.clientWidth
        && zwSvg.getBoundingClientRect().width > zwVp.clientWidth + 1
        && zwVp.scrollWidth > zwVp.clientWidth; // 放大后真正溢出，可滚动/平移
      closeTab(state.activeTabId);

      // ---- 编辑器行号栏 ----
      const gutterSrc = Array.from({ length: 120 }, (_, i) => "line " + (i + 1)).join("\n");
      M.renderDoc({ path: "C:\\t\\g.md", name: "g.md", dir: "C:\\t", content: gutterSrc });
      enterEditMode();
      const gut = $("editorGutter"), ged = $("editor");
      results.uiGutterInit = gut.textContent.trim().split("\n").length === 120;
      ged.value = ged.value + "\nextra1\nextra2";
      ged.dispatchEvent(new Event("input", { bubbles: true }));
      results.uiGutterGrow = gut.textContent.trim().split("\n").length === 122;
      ged.value = gutterSrc;
      ged.dispatchEvent(new Event("input", { bubbles: true }));
      results.uiGutterShrink = gut.textContent.trim().split("\n").length === 120;
      const gedCs = getComputedStyle(ged), gutCs = getComputedStyle(gut);
      results.uiGutterAlign = gutCs.lineHeight === gedCs.lineHeight
        && gutCs.paddingTop === gedCs.paddingTop
        && gutCs.fontFamily === gedCs.fontFamily
        && gutCs.fontSize === gedCs.fontSize;
      ged.scrollTop = 300;
      ged.dispatchEvent(new Event("scroll"));
      results.uiGutterScrollSync = ged.scrollTop === 300 && gut.scrollTop === 300;

      // ---- 编辑分栏：左右布局 + 拖拽 + 实时预览 ----
      const ew = $("editorWrap"), ep = $("editorPane"), sd = $("splitDivider");
      const ewCs = getComputedStyle(ew);
      results.uiSplitLayout = ew.hidden === false
        && ewCs.display === "flex" && ewCs.flexDirection === "row"
        && !!ep && !!sd
        && $("content").offsetParent !== null; // 右侧预览窗格可见
      // 拖拽前重置为已知宽度：splitWidth 会持久化，避免跨轮状态污染断言
      $("layout").style.setProperty("--split-w", "460px");
      const wBefore = ep.getBoundingClientRect().width;
      sd.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 600, bubbles: true, cancelable: true }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 680, bubbles: true }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      const wAfter = ep.getBoundingClientRect().width;
      const expectedW = Math.min($("editorWrap").clientWidth - 160, Math.max(300, wBefore + 80));
      results.uiSplitDrag = wAfter === expectedW && Math.round(state.splitWidth) === expectedW;
      // 方案 B：预览侧必须预留等宽空间（margin-left 随分栏宽度生效）
      results.uiSplitReserve = parseFloat(getComputedStyle($("reader")).marginLeft) >= 300;
      // 方案 B 几何一致性：预览左缘必须贴住编辑窗格右缘（≤2px），
      // 防止 margin 基准错位（如侧栏宽被重复计入）再次产生分栏死空间
      const paneRight = $("editorPane").getBoundingClientRect().right;
      const readerLeft = $("reader").getBoundingClientRect().left;
      results.uiSplitGap = (readerLeft - paneRight) <= 2;
      // 预览内容列必须紧贴分隔线（≤45px = read-inner 左内边距 40px + 容差）
      results.uiSplitContentFlush = ($("content").getBoundingClientRect().left - paneRight) <= 45;
      ged.value = "# 实时预览标题";
      ged.dispatchEvent(new Event("input", { bubbles: true }));
      renderPreviewNow();
      results.uiSplitLivePreview = $("content").querySelector("h1")
        && $("content").querySelector("h1").textContent === "实时预览标题";
      exitEditMode();
      results.uiSplitExit = ew.hidden === true;
      closeTab(state.activeTabId);

      // ---- 显示模式内容栏宽度 ----
            results.uiContentWide = parseFloat(getComputedStyle($("content")).maxWidth) >= 1280;

      // ---- 打印样式与导出桥接 ----
      // 解析样式表：@media print 必须隐藏标签栏等界面元素，@page 必须声明 A4
      let printHideTabbar = false, printHideFindbar = false, pageA4 = false;
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const rule of rules) {
          if (rule.media && /print/.test(rule.media.mediaText)) {
            for (const r of rule.cssRules) {
              const sel = r.selectorText || "";
              if (sel.includes(".tabbar")) printHideTabbar = true;
              if (sel.includes(".findbar")) printHideFindbar = true;
              if (r.type === 6 && /A4/i.test(r.cssText)) pageA4 = true; // @page 在 media 内
            }
          }
          if (rule.type === 6 && /A4/i.test(rule.cssText)) pageA4 = true; // CSSPageRule
        }
      }
      results.uiPrintCss = printHideTabbar && printHideFindbar && pageA4;
      results.uiPrintBridge = typeof window.__MDR__.doPrint === "function";

      // ---- Ctrl+wheel zoom ----
      const zoomBefore = state.zoom;
      window.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -120, cancelable: true }));
      results.uiWheelZoomIn = state.zoom > zoomBefore;
      window.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: 120, cancelable: true }));
      window.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: 120, cancelable: true }));
      results.uiWheelZoomOut = state.zoom < zoomBefore;
      setZoom(1);

      // ---- find & replace ----
      M.renderDoc({ path: "C:\\t\\f.md", name: "f.md", dir: "C:\\t", content: "alpha beta alpha\ngamma alpha" });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
      results.uiFindOpens = findBarEl().hidden === false && document.activeElement === $("findInput");
      $("findInput").value = "alpha";
      doFind("alpha"); // 输入框有 200ms 防抖，自检直接调搜索引擎保证同步确定性
      results.uiFindHighlights = $("content").querySelectorAll("mark.find-hl").length === 3;
      results.uiFindCount = $("findCount").textContent === "1/3";
      $("findNext").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      results.uiFindNext = $("findCount").textContent === "2/3"
        && $("content").querySelectorAll("mark.find-hl-current").length === 1;
      $("findPrev").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      $("findPrev").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      results.uiFindWrap = $("findCount").textContent === "3/3";
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      results.uiFindEscCloses = findBarEl().hidden === true
        && $("content").querySelectorAll("mark.find-hl").length === 0;
      // replace flow (Ctrl+H)
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "h", ctrlKey: true, bubbles: true, cancelable: true }));
      results.uiReplaceOpens = findBarEl().hidden === false && $("replaceRow").hidden === false;
      $("findInput").value = "alpha";
      doFind("alpha");
      $("replaceInput").value = "BETA";
      $("replaceOne").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      results.uiReplaceOne = currentTab().doc.content === "BETA beta alpha\ngamma alpha"
        && $("findCount").textContent === "1/2";
      $("replaceAll").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      results.uiReplaceAll = currentTab().doc.content === "BETA beta BETA\ngamma BETA"
        && $("content").querySelectorAll("mark.find-hl").length === 0;
      results.uiReplaceDirty = isDirty(currentTab());
      closeFind();
      closeTab(state.activeTabId);
      closeTab(state.activeTabId);
      }

      results.total = Object.keys(results).filter((k) => k !== "error").every((k) => results[k]) && !results.error;
    } catch (e) {
      results.error = String((e && e.stack) || e);
      results.total = false;
    }
    results.phase = isFinal ? "final" : "early";
    window.__SELFTEST__ = results;
    document.title = "SELFTEST:" + (results.total ? "PASS" : "FAIL");
    if (api() && api().report_selftest) {
      try { api().report_selftest(results); } catch (e) {}
    }
  }

  // Install self-test as early as possible.
  if (isSelfTest()) {
    document.addEventListener("DOMContentLoaded", () => {
      try { runSelfTest(false); } catch (e) {
        window.__SELFTEST__ = { error: String((e && e.stack) || e), total: false };
      }
    });
  }

  // pywebview injects the API asynchronously; wait for it before boot.
  window.addEventListener("pywebviewready", () => {
    try { boot(); } catch (e) { console.error("boot failed", e); }
    if (isSelfTest()) setTimeout(() => runSelfTest(true), 300);
  });

  // Fallback: no backend (plain browser) — still start the UI shell.
  setTimeout(() => {
    if (!api()) {
      try { boot(); } catch (e) {}
      const hint = document.querySelector(".drop-hint");
      if (hint) hint.textContent = "浏览器模式（无本地文件访问能力），请使用打包后的 EXE。";
    }
  }, 1200);
})();
