/*!
 * mermaid-mini :: offline flowchart-subset renderer for MD Reader
 * Supported DSL: "flowchart TD|LR|BT|RL" / "graph ...", %% comments,
 * subgraph (one level), node shapes  id / id["rect"] / id("round") /
 * id(["stadium"]) / id{"diamond"}, <br/> in labels, edge styles
 * --- --> -.-> ==> === -.- with |labels| and -. label .-> , chains.
 * Anything else (sequence/class/gantt...) returns null so the caller can
 * fall back to showing the source. Full mermaid.js can be vendored at
 * web/vendor/mermaid/mermaid.min.js — markdown.js auto-detects it.
 */
(function (global) {
  "use strict";

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  function supported(src) {
    return /^\s*(flowchart|graph)\b/i.test(String(src || ""));
  }

  // ---------- label helpers ----------
  function cleanLabel(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
        (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
      s = s.slice(1, -1);
    }
    s = s.replace(/\\"/g, '"').replace(/\\'/g, "'");
    s = s.replace(/<br\s*\/?\s*>/gi, "\n");
    return s.trim();
  }

  function labelLines(label) {
    return String(label).split("\n").filter((l, i, a) => l.trim() !== "" || (i > 0 && i < a.length - 1));
  }

  function textWidth(line, fontSize) {
    let w = 0;
    for (const ch of line) w += ch.charCodeAt(0) > 0x2e80 ? fontSize : fontSize * 0.58;
    return w;
  }

  // ---------- parsing ----------
  const ID_RE = /^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*/;

  // Reads a node reference at s[i]: id + optional shape/label.
  // Returns { id, label, shape, next } or null.
  function scanNodeRef(s, i) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const m = s.slice(i).match(ID_RE);
    if (!m) return null;
    const id = m[0];
    i += id.length;
    let label = id, shape = "rect";
    const openers = { "[": "]", "(": ")", "{": "}" };
    while (i < s.length && /\s/.test(s[i])) i++;
    const c = s[i];
    if (c === "[" || c === "(" || c === "{") {
      // stadium: ([ ... ])
      let closer = openers[c];
      let stadium = false;
      if (c === "(" && s[i + 1] === "[") { stadium = true; i++; }
      if (c === "(" && s[i + 1] === "{") { i++; closer = "}"; } // ({"..."}) rare; treat inner
      const depthStart = i;
      i++; // skip opener
      let depth = 1, j = i, quote = null;
      while (j < s.length) {
        const ch = s[j];
        if (quote) { if (ch === quote) quote = null; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "[" || ch === "(" || ch === "{") depth++;
        else if (ch === "]" || ch === ")" || ch === "}") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (j >= s.length) return { id, label: id, shape: "rect", next: j };
      let inner = s.slice(i, j);
      // skip the closer(s): ']' or ')' or '}', plus stadium's extra ')'
      let end = j + 1;
      if (stadium && s[end] === ")") end++;
      label = cleanLabel(inner);
      shape = c === "{" ? "diamond" : (c === "(" ? "round" : "rect");
      if (stadium) shape = "stadium";
      i = end;
    }
    return { id, label, shape, next: i };
  }

  // Reads an edge operator at s[i]. Returns { style, arrow, label, next } or null.
  function scanEdge(s, i) {
    while (i < s.length && /\s/.test(s[i])) i++;
    let style = null, arrow = false, next = i;
    if (s.startsWith("-.->", i)) { style = "dot"; arrow = true; next = i + 4; }
    else if (s.startsWith("-->", i)) { style = "solid"; arrow = true; next = i + 3; }
    else if (s.startsWith("==>", i)) { style = "thick"; arrow = true; next = i + 3; }
    else if (s.startsWith("---", i)) { style = "solid"; arrow = false; next = i + 3; }
    else if (s.startsWith("===", i)) { style = "thick"; arrow = false; next = i + 3; }
    else if (s.startsWith("-.-", i)) { style = "dot"; arrow = false; next = i + 3; }
    else if (s.startsWith("-.", i)) {
      // dotted with inline label: -. text .->
      const close = s.indexOf(".->", i + 2);
      if (close === -1) return null;
      style = "dot"; arrow = true;
      return { style, arrow, label: cleanLabel(s.slice(i + 2, close)), next: close + 3 };
    }
    else if (s.startsWith("--", i)) {
      // open link with inline label: -- text -->
      const close = s.indexOf("-->", i + 2);
      if (close === -1) return null;
      style = "solid"; arrow = true;
      return { style, arrow, label: cleanLabel(s.slice(i + 2, close)), next: close + 3 };
    }
    else {
      return null;
    }
    // optional |label|
    let label = "";
    let p = next;
    while (p < s.length && /\s/.test(s[p])) p++;
    if (s[p] === "|") {
      const bar = s.indexOf("|", p + 1);
      if (bar !== -1) { label = cleanLabel(s.slice(p + 1, bar)); next = bar + 1; }
    }
    return { style, arrow, label, next };
  }

  function parse(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    let dir = "TD";
    const nodes = new Map();
    const edges = [];
    const subgraphs = [];
    let curSg = null;
    let sgSeq = 0;

    const defineNode = (ref) => {
      let n = nodes.get(ref.id);
      if (!n) {
        n = { id: ref.id, label: ref.label, shape: ref.shape, sg: null };
        nodes.set(ref.id, n);
      } else {
        // keep first shape; update label if a richer one appears later
        if (ref.label && ref.label !== ref.id) n.label = ref.label;
        if (ref.shape !== "rect") n.shape = ref.shape;
      }
      if (curSg) {
        if (n.sg !== curSg.id) { n.sg = curSg.id; }
        if (!curSg.ids.includes(ref.id)) curSg.ids.push(ref.id);
      }
      return n;
    };

    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("%%")) continue;

      const dirM = line.match(/^(?:flowchart|graph)\s+(TD|TB|LR|BT|RL)\b/i);
      if (dirM) { dir = dirM[1].toUpperCase(); if (dir === "TB") dir = "TD"; continue; }

      const sgM = line.match(/^subgraph\s+(.+)$/i);
      if (sgM) {
        const rest = sgM[1].trim();
        const ref = scanNodeRef(rest, 0);
        let id, title;
        if (ref && ref.next >= rest.trimEnd().length - 0 && ref.label !== ref.id) {
          id = ref.id; title = ref.label;
        } else if (ref && /^[\w\u4e00-\u9fff-]+$/.test(rest.trim())) {
          id = ref.id; title = ref.id;
        } else {
          id = "sg" + (++sgSeq); title = cleanLabel(rest);
        }
        curSg = { id, title, ids: [] };
        subgraphs.push(curSg);
        continue;
      }
      if (/^end$/i.test(line)) { curSg = null; continue; }

      // statement: node (edge node)*
      let i = 0;
      const first = scanNodeRef(line, i);
      if (!first) continue;
      defineNode(first);
      let cur = first;
      i = first.next;
      for (;;) {
        const e = scanEdge(line, i);
        if (!e) break;
        const nxt = scanNodeRef(line, e.next);
        if (!nxt) break;
        defineNode(nxt);
        edges.push({ from: cur.id, to: nxt.id, style: e.style, arrow: e.arrow, label: e.label });
        cur = nxt;
        i = nxt.next;
      }
    }
    if (!nodes.size) return null;
    return { dir, nodes, edges, subgraphs };
  }

  // ---------- layout ----------
  function layout(g) {
    const { nodes, edges, dir } = g;
    // longest-path layering (depth = longest chain from any source),
    // memoized, with back-edges skipped so cycles cannot inflate layers
    const radj = {};
    edges.forEach((e) => { (radj[e.to] = radj[e.to] || []).push(e.from); });
    const depth = {};
    nodes.forEach((n) => { depth[n.id] = 0; });
    const state = {};
    const depthOf = (id) => {
      if (state[id]) return depth[id];
      state[id] = 1;
      let best = 0;
      for (const from of radj[id] || []) {
        if (state[from] === 1) continue; // back-edge
        best = Math.max(best, depthOf(from) + 1);
      }
      state[id] = 2;
      depth[id] = best;
      return best;
    };
    for (const id of nodes.keys()) depthOf(id);

    // layers -> declaration order
    const layers = [];
    for (const id of nodes.keys()) {
      const L = depth[id] || 0;
      (layers[L] = layers[L] || []).push(id);
    }
    for (let k = 0; k < layers.length; k++) if (!layers[k]) layers[k] = [];

    // sizes
    const FS = 13, LINE_H = 18, PAD_X = 14, PAD_Y = 10;
    nodes.forEach((n) => {
      n.lines = labelLines(n.label);
      let w = 40;
      for (const l of n.lines) w = Math.max(w, textWidth(l, FS));
      n.w = Math.round(w + PAD_X * 2);
      n.h = Math.round(n.lines.length * LINE_H + PAD_Y * 2);
      if (n.shape === "diamond") { n.w = Math.round(n.w * 1.45); n.h = Math.round(n.h * 1.6); }
      if (n.shape === "stadium") n.h = Math.round(n.h * 1.15);
    });

    const horizontal = dir === "LR" || dir === "RL";
    const GAP_MAIN = 64, GAP_CROSS = 36;
    const crossSize = (n) => (horizontal ? n.h : n.w);
    const mainSize = (n) => (horizontal ? n.w : n.h);

    // main-axis offsets per layer
    const layerMain = [];
    let acc = 0;
    for (let L = 0; L < layers.length; L++) {
      let mw = 0;
      layers[L].forEach((id) => { mw = Math.max(mw, mainSize(nodes.get(id))); });
      layerMain[L] = { off: acc, size: mw };
      acc += mw + GAP_MAIN;
    }
    const totalMain = Math.max(0, acc - GAP_MAIN);

    // cross-axis: stack per layer, centered against the fullest layer
    let maxCross = 0;
    const layerCross = layers.map((ids) => {
      let c = 0;
      ids.forEach((id) => { c += crossSize(nodes.get(id)); });
      c += GAP_CROSS * Math.max(0, ids.length - 1);
      maxCross = Math.max(maxCross, c);
      return c;
    });

    layers.forEach((ids, L) => {
      let c = (maxCross - layerCross[L]) / 2;
      ids.forEach((id) => {
        const n = nodes.get(id);
        const main = layerMain[L].off + (layerMain[L].size - mainSize(n)) / 2;
        if (horizontal) {
          n.x = dir === "LR" ? main : totalMain - main - n.w;
          n.y = c;
        } else {
          n.y = dir === "TD" ? main : totalMain - main - n.h;
          n.x = c;
        }
        n.cx = n.x + n.w / 2;
        n.cy = n.y + n.h / 2;
        c += crossSize(n) + GAP_CROSS;
      });
    });

    const width = horizontal ? totalMain : maxCross;
    const height = horizontal ? maxCross : totalMain;

    // subgraph boxes (single level; members may span layers)
    g.subgraphs.forEach((sg) => {
      const members = sg.ids.map((id) => nodes.get(id)).filter(Boolean);
      if (!members.length) { sg.box = null; return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      members.forEach((n) => {
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
      });
      const pad = 14, titleH = sg.title ? 22 : 6;
      sg.box = { x: x0 - pad, y: y0 - pad - titleH, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 + titleH, title: sg.title };
    });

    // grow canvas to include subgraph boxes
    let width_ = width, height_ = height;
    g.subgraphs.forEach((sg) => {
      if (!sg.box) return;
      width_ = Math.max(width_, sg.box.x + sg.box.w);
      height_ = Math.max(height_, sg.box.y + sg.box.h);
    });

    return { width: Math.ceil(width_ + 8), height: Math.ceil(height_ + 8) };
  }

  // ---------- svg ----------
  function clipPoint(n, tx, ty) {
    // point where the segment center->target exits node rect
    const dx = tx - n.cx, dy = ty - n.cy;
    if (dx === 0 && dy === 0) return { x: n.cx, y: n.cy };
    let t = Infinity;
    if (dx !== 0) {
      const txEdge = dx > 0 ? n.x + n.w : n.x;
      t = Math.min(t, (txEdge - n.cx) / dx);
    }
    if (dy !== 0) {
      const tyEdge = dy > 0 ? n.y + n.h : n.y;
      t = Math.min(t, (tyEdge - n.cy) / dy);
    }
    if (!isFinite(t)) t = 0;
    return { x: n.cx + dx * t, y: n.cy + dy * t };
  }

  function toSVG(g) {
    const { width, height } = layout(g);
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="me-svg">`);
    out.push('<defs>' +
      '<marker id="me-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="me-arrow"/></marker>' +
      '<marker id="me-arr-thick" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="me-arrow"/></marker>' +
      '</defs>');

    // subgraph boxes behind everything
    g.subgraphs.forEach((sg) => {
      if (!sg.box) return;
      out.push(`<rect class="me-sgbox" x="${sg.box.x}" y="${sg.box.y}" width="${sg.box.w}" height="${sg.box.h}" rx="8"/>`);
      if (sg.title) {
        out.push(`<text class="me-sgtitle" x="${sg.box.x + 10}" y="${sg.box.y + 15}">${esc(sg.title)}</text>`);
      }
    });

    // edges
    g.edges.forEach((e) => {
      const a = g.nodes.get(e.from), b = g.nodes.get(e.to);
      if (!a || !b) return;
      const p1 = clipPoint(a, b.cx, b.cy);
      const p2 = clipPoint(b, a.cx, a.cy);
      const cls = "me-edge me-" + e.style;
      const marker = e.arrow ? ` marker-end="url(#me-arr${e.style === "thick" ? "-thick" : ""})"` : "";
      out.push(`<path class="${cls}" d="M${p1.x.toFixed(1)},${p1.y.toFixed(1)} L${p2.x.toFixed(1)},${p2.y.toFixed(1)}"${marker}/>`);
      if (e.label) {
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        out.push(`<text class="me-elabel" x="${mx.toFixed(1)}" y="${(my - 5).toFixed(1)}" text-anchor="middle">${esc(e.label)}</text>`);
      }
    });

    // nodes
    g.nodes.forEach((n) => {
      const { x, y, w, h, cx, cy } = n;
      if (n.shape === "diamond") {
        const pts = `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
        out.push(`<polygon class="me-node" points="${pts}"/>`);
      } else {
        const rx = n.shape === "stadium" ? h / 2 : (n.shape === "round" ? 12 : 3);
        out.push(`<rect class="me-node" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`);
      }
      const startY = cy - ((n.lines.length - 1) * 18) / 2 + 4.5;
      out.push(`<text class="me-ntext" x="${cx}" y="${startY.toFixed(1)}" text-anchor="middle">`);
      n.lines.forEach((l, idx) => {
        out.push(`<tspan x="${cx}" dy="${idx === 0 ? 0 : 18}">${esc(l)}</tspan>`);
      });
      out.push("</text>");
    });

    out.push("</svg>");
    return out.join("");
  }

  function render(src) {
    if (!supported(src)) return null;
    const g = parse(src);
    if (!g || !g.nodes.size) return null;
    try {
      return toSVG(g);
    } catch (e) {
      return null;
    }
  }

  global.MermaidMini = { render, supported, parse };
})(window);
