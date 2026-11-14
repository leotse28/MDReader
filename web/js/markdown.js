/*!
 * md-reader :: zero-dependency Markdown renderer
 * Supports: ATX/setext headings, bold/italic/strike, inline code, code fences,
 * links, images, reference links, blockquotes, ordered/unordered lists
 * (nested), task lists, tables (alignment), hr, HTML passthrough (sanitized),
 * footnotes-lite, autolinks, escapes.
 * Output is HTML sanitized against script injection.
 */
(function (global) {
  "use strict";

  // ---- HTML escaping -------------------------------------------------
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  const ALLOWED_TAGS = new Set(
    (
      "a abbr b blockquote br caption center code col colgroup dd del details div dl dt em " +
      "figcaption figure font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q rp rt ruby s " +
      "samp small span strike strong sub summary sup table tbody td tfoot th thead tr tt u ul var " +
      "input section article header footer nav"
    ).split(" ")
  );

  // Strip dangerous tags & attributes from raw HTML blocks/inline.
  function sanitizeHtml(html) {
    const doc = document.implementation.createHTMLDocument("sanitize");
    const container = doc.createElement("div");
    container.innerHTML = html;

    const walk = (node) => {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (tag === "script" || tag === "style" || tag === "iframe" ||
              tag === "object" || tag === "embed" || tag === "link" || tag === "meta" ||
              tag === "form") {
            child.remove();
            continue;
          }
          if (!ALLOWED_TAGS.has(tag)) {
            // unwrap unknown tags but keep their text
            const frag = doc.createDocumentFragment();
            while (child.firstChild) frag.appendChild(child.firstChild);
            child.replaceWith(frag);
            continue;
          }
          // scrub attributes
          for (const attr of Array.from(child.attributes)) {
            const name = attr.name.toLowerCase();
            const val = attr.value || "";
            const isUrl = /^(href|src|srcset|xlink:href)$/.test(name);
            const isEvent = name.startsWith("on");
            const isDangerUrl = isUrl && /^\s*(javascript|vbscript|data:text\/html)/i.test(val);
            if (isEvent || isDangerUrl || name === "style" && /expression|javascript:/i.test(val)) {
              child.removeAttribute(attr.name);
            }
          }
          walk(child);
        } else if (child.nodeType === 8) {
          child.remove();
        }
      }
    };
    walk(container);
    return container.innerHTML;
  }

  // ---- Math rendering --------------------------------------------------
  // Dual mode: full KaTeX when the vendored library is present
  // (app/web/vendor/katex/, loaded by index.html); otherwise a built-in
  // minimal TeX subset renderer covering common formulas. Both are fully
  // offline; every text node is escaped before insertion.
  function renderMath(tex, displayMode) {
    let html = null;
    if (typeof katex !== "undefined" && katex && typeof katex.renderToString === "function") {
      try {
        html = katex.renderToString(tex, { displayMode: displayMode, throwOnError: false, strict: false, output: "html" });
      } catch (e) { html = null; }
    }
    if (html == null) {
      try { html = miniTeX(tex); }
      catch (e) { html = "<code>" + esc(tex) + "</code>"; }
    }
    return displayMode
      ? '<div class="math-block">' + html + "</div>"
      : '<span class="math-inline">' + html + "</span>";
  }

  // Minimal TeX subset: greek letters, operators, arrows, accents, \frac,
  // \sqrt, ^/_ scripts, \text/\mathbf/\mathrm, spacing, \% \& \{ escapes.
  const TEX_SYMBOLS = {
    alpha: "\u03b1", beta: "\u03b2", gamma: "\u03b3", delta: "\u03b4", epsilon: "\u03b5",
    varepsilon: "\u03b5", zeta: "\u03b6", eta: "\u03b7", theta: "\u03b8", vartheta: "\u03d1",
    iota: "\u03b9", kappa: "\u03ba", lambda: "\u03bb", mu: "\u03bc", nu: "\u03bd",
    xi: "\u03be", pi: "\u03c0", rho: "\u03c1", sigma: "\u03c3", varsigma: "\u03c2",
    tau: "\u03c4", upsilon: "\u03c5", phi: "\u03c6", varphi: "\u03d5", chi: "\u03c7",
    psi: "\u03c8", omega: "\u03c9",
    Gamma: "\u0393", Delta: "\u0394", Theta: "\u0398", Lambda: "\u039b", Xi: "\u039e",
    Pi: "\u03a0", Sigma: "\u03a3", Upsilon: "\u03a5", Phi: "\u03a6", Psi: "\u03a8", Omega: "\u03a9",
    sum: "\u2211", prod: "\u220f", coprod: "\u2210", int: "\u222b", iint: "\u222c", iiint: "\u222d",
    oint: "\u222e", bigcup: "\u22c3", bigcap: "\u22c2", bigoplus: "\u2a01", bigotimes: "\u2a02",
    infty: "\u221e", partial: "\u2202", nabla: "\u2207", hbar: "\u210f", ell: "\u2113",
    Re: "\u211c", Im: "\u2111", aleph: "\u2135", wp: "\u2118", imath: "\u0131", jmath: "\u0237",
    pm: "\u00b1", mp: "\u2213", times: "\u00d7", div: "\u00f7", cdot: "\u22c5", ast: "\u2217",
    star: "\u22c6", circ: "\u2218", bullet: "\u2219", oplus: "\u2295", ominus: "\u2296",
    otimes: "\u2297", oslash: "\u2298", odot: "\u2299", dagger: "\u2020", ddagger: "\u2021",
    leq: "\u2264", le: "\u2264", geq: "\u2265", ge: "\u2265", neq: "\u2260", ne: "\u2260",
    approx: "\u2248", equiv: "\u2261", sim: "\u223c", simeq: "\u2243", cong: "\u2245",
    propto: "\u221d", ll: "\u226a", gg: "\u226b", prec: "\u227a", succ: "\u227b",
    subset: "\u2282", supset: "\u2283", subseteq: "\u2286", supseteq: "\u2287",
    in: "\u2208", ni: "\u220b", notin: "\u2209", cup: "\u222a", cap: "\u2229",
    emptyset: "\u2205", varnothing: "\u2205", forall: "\u2200", exists: "\u2203",
    neg: "\u00ac", lnot: "\u00ac", land: "\u2227", lor: "\u2228", implies: "\u27f9",
    to: "\u2192", gets: "\u2190", rightarrow: "\u2192", leftarrow: "\u2190",
    Rightarrow: "\u21d2", Leftarrow: "\u21d0", leftrightarrow: "\u2194",
    Leftrightarrow: "\u21d4", uparrow: "\u2191", downarrow: "\u2193", mapsto: "\u21a6",
    longrightarrow: "\u27f6", iff: "\u27fa", leadsto: "\u219d",
    angle: "\u2220", triangle: "\u25b3", perp: "\u22a5", parallel: "\u2225",
    mid: "\u2223", ldots: "\u2026", cdots: "\u22ef", vdots: "\u22ee", ddots: "\u22f1", dots: "\u2026",
    prime: "\u2032", surd: "\u221a", top: "\u22a4", bot: "\u22a5", models: "\u22a8",
    lceil: "\u2308", rceil: "\u2309", lfloor: "\u230a", rfloor: "\u230b",
    langle: "\u27e8", rangle: "\u27e9", uplus: "\u228e", sqcup: "\u2294",
    lim: "lim", log: "log", ln: "ln", lg: "lg", exp: "exp", det: "det", dim: "dim", deg: "deg",
    max: "max", min: "min", sup: "sup", inf: "inf", gcd: "gcd",
    sin: "sin", cos: "cos", tan: "tan", cot: "cot", sec: "sec", csc: "csc",
    arcsin: "arcsin", arccos: "arccos", arctan: "arctan", sinh: "sinh", cosh: "cosh", tanh: "tanh",
  };
  // fix the accidental alias above
  TEX_SYMBOLS.cos = "cos";

  function miniTeX(src) {
    const out = [];
    let i = 0;
    const n = src.length;

    function skipSpace() { while (i < n && /\s/.test(src[i])) i++; }

    function readGroup() {
      skipSpace();
      if (src[i] === "{") {
        i++;
        const h = parseUntil("}");
        if (src[i] === "}") i++;
        return h;
      }
      if (src[i] === "\\") return parseCommand();
      if (i < n) { const c = src[i]; i++; return esc(c); }
      return "";
    }

    function parseUntil(stop) {
      const buf = [];
      while (i < n) {
        const c = src[i];
        if (stop === "}" && c === "}") break;
        if (c === "\\") { buf.push(parseCommand()); continue; }
        if (c === "^" || c === "_") { buf.push(parseScript(c)); continue; }
        if (c === "{") { i++; buf.push(parseUntil("}")); if (src[i] === "}") i++; continue; }
        if (c === "%") { while (i < n && src[i] !== "\n") i++; continue; }
        if (/[a-zA-Z]/.test(c)) { buf.push('<i class="mx-var">' + esc(c) + "</i>"); i++; continue; }
        if (c === " " || c === "\t" || c === "\n") { buf.push(" "); i++; continue; }
        buf.push(esc(c)); i++;
      }
      return buf.join("");
    }

    function parseScript(kind) {
      i++;
      const h = readGroup();
      return kind === "^" ? '<sup class="mx-sup">' + h + "</sup>"
                          : '<sub class="mx-sub">' + h + "</sub>";
    }

    function parseCommand() {
      i++; // backslash
      if (i >= n) return "";
      let name = "";
      while (i < n && /[a-zA-Z]/.test(src[i])) name += src[i++];
      if (!name) {
        const c = src[i]; i++;
        if (c === "," || c === ":" || c === ";") return '<span class="mx-thin"> </span>';
        if (c === " ") return " ";
        if (c === "quad") return '<span class="mx-quad"></span>';
        return esc(c);
      }
      switch (name) {
        case "quad": return '<span class="mx-quad"></span>';
        case "qquad": return '<span class="mx-quad"></span><span class="mx-quad"></span>';
        case "frac": case "dfrac": case "tfrac": {
          const a = readGroup(), b = readGroup();
          return '<span class="mx-frac"><span class="mx-num">' + a + '</span><span class="mx-den">' + b + "</span></span>";
        }
        case "sqrt": {
          const a = readGroup();
          return '<span class="mx-sqrt">\u221a<span class="mx-inner">' + a + "</span></span>";
        }
        case "text": case "mathrm": case "operatorname": {
          const a = readGroup();
          return '<span class="mx-text">' + a + "</span>";
        }
        case "mathbf": case "bm": case "boldsymbol": {
          const a = readGroup();
          return '<b class="mx-bf">' + a + "</b>";
        }
        case "mathit": {
          const a = readGroup();
          return "<i>" + a + "</i>";
        }
        case "vec": {
          const a = readGroup();
          return '<span class="mx-acc">' + a + '<span class="mx-accmark">\u2192</span></span>';
        }
        case "hat": {
          const a = readGroup();
          return '<span class="mx-acc">' + a + '<span class="mx-accmark">\u02c6</span></span>';
        }
        case "bar": case "overline": {
          const a = readGroup();
          return '<span class="mx-ovl">' + a + "</span>";
        }
        case "underline": {
          const a = readGroup();
          return '<span class="mx-und">' + a + "</span>";
        }
        case "left": case "right": case "big": case "Big": case "bigg": case "Bigg": {
          skipSpace();
          if (src[i] && src[i] !== ".") { const d = src[i]; i++; return esc(d); }
          return "";
        }
        case "begin": case "end": { readGroup(); return ""; }
        case "\\": return "<br>";
        case "displaystyle": case "textstyle": case "limits": case "nolimits": return "";
      }
      const sym = TEX_SYMBOLS[name];
      if (sym != null) return sym;
      return esc("\\" + name);
    }

    while (i < n) {
      const c = src[i];
      if (c === "\\") { out.push(parseCommand()); continue; }
      if (c === "^" || c === "_") { out.push(parseScript(c)); continue; }
      if (c === "{") { i++; out.push(parseUntil("}")); if (src[i] === "}") i++; continue; }
      if (c === "%") { while (i < n && src[i] !== "\n") i++; continue; }
      if (/[a-zA-Z]/.test(c)) { out.push('<i class="mx-var">' + esc(c) + "</i>"); i++; continue; }
      if (c === " " || c === "\t" || c === "\n") { out.push(" "); i++; continue; }
      out.push(esc(c)); i++;
    }
    return out.join("");
  }

  // ---- Inline rendering ----------------------------------------------
  // Strategy: first escape the raw text so no user HTML survives, then run
  // all inline transforms on the *escaped* string. Any tags we emit are our
  // own and therefore trusted. Inline code / links / images are stashed as
  // tokens first so emphasis rules never touch their content.
  function renderInline(raw) {
    const tokens = [];
    const stash = (html) => {
      const key = "\u0000" + tokens.length + "\u0000";
      tokens.push(html);
      return key;
    };

    // 0. protect backslash escapes (before escaping)
    let text = String(raw).replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, (_, ch) => stash(esc(ch)));

    // 1. inline code FIRST (on raw text, before math detection so `$` inside
    //    code spans is never treated as a math delimiter)
    text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => {
      const c = esc(code.replace(/^ (.*) $/, "$1"));
      return stash("<code>" + c + "</code>");
    });

    // 2. inline math $...$ on raw text. Guards against money strings:
    //    opening $ must not directly follow a word char or another $
    //    (CJK / fullwidth punctuation are fine); content must not start or
    //    end with whitespace; closing $ must not be followed by a word char
    //    or another $; pure-number content stays literal.
    text = text.replace(/(?<![\w$])\$(\S(?:[^$\n]*?\S)?)\$(?![\w$])/g,
      (m, tex) => {
        if (/^\d+(?:[.,]\d+)?$/.test(tex)) return m;
        return stash(renderMath(tex, false));
      });

    // 3. escape the remaining raw text exactly once
    text = esc(text);

    // 4. images  ![alt](src "title")  — brackets/parens survive esc
    text = text.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;|\s+&#39;([^&]*)&#39;|\s+'([^']*)')?\s*\)/g,
      (_, alt, src, t1, t2, t3) => {
        if (isUnsafeUrl(src)) return stash(esc(alt));
        const title = t1 || t2 || t3 || "";
        const t = title ? ` title="${title}"` : "";
        return stash(
          `<img src="${resolveAsset(src)}" alt="${alt}"${t} loading="lazy" data-src="${src}">`
        );
      });

    // 5. links [text](url "title") — label may itself contain escaped text
    text = text.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;|\s+&#39;([^&]*)&#39;|\s+'([^']*)')?\s*\)/g,
      (_, label, href, t1, t2, t3) => {
        if (isUnsafeUrl(href)) return stash(renderInline(label));
        const title = t1 || t2 || t3 || "";
        const t = title ? ` title="${title}"` : "";
        const isAnchor = href.startsWith("#");
        const target = isAnchor ? "" : ' target="_blank" rel="noopener noreferrer"';
        // label may contain inline markdown -> render recursively
        return stash(`<a href="${href}"${t}${target} data-mdlink="1">${renderInline(label)}</a>`);
      });

    // 6. autolinks <http://...>  (raw < became &lt; after esc)
    text = text.replace(/&lt;((?:https?|mailto):[^>\s&]+)&gt;/g, (_, url) =>
      stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    );

    // 7. bare urls
    text = text.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>)]+[^\s<>).,;:!?"'])/g, (m, pre, url) =>
      pre + stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    );

    // 8. emphasis (order matters: bold-italic, bold, italic)
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // intraword underscores do NOT emphasize (CommonMark): a_b_c stays literal
    text = text.replace(/(^|[^_\w\u0000])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    text = text.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");

    // 9. inline footnote refs [^1]
    text = text.replace(/\[\^([^\]]+)\]/g, (_, id) =>
      `<sup class="fn-ref"><a href="#fn-${id}" id="fnref-${id}">${id}</a></sup>`
    );

    // 10. restore stashed tokens
    text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[+i]);
    return text;
  }

  // ---- Block parsing --------------------------------------------------
  function parse(md, opts) {
    opts = opts || {};
    const lines = md.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
    let i = 0;

    // collect reference link definitions
    const refs = {};
    const refRe = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+["']([^"']*)["'])?\s*$/;
    const kept = [];
    for (const line of lines) {
      const m = line.match(refRe);
      // footnote definitions "[^id]: ..." must NOT be treated as link refs
      const isFootnoteDef = /^\s{0,3}\[\^[^\]]+\]:/.test(line);
      if (m && !isFootnoteDef) {
        refs[m[1].toLowerCase()] = { href: m[2], title: m[3] || "" };
      } else {
        kept.push(line);
      }
    }
    const src = kept;

    // pre-resolve reference links into inline form
    const resolved = src.map((line) =>
      line.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (full, label, id) => {
        const key = (id || label).toLowerCase();
        const r = refs[key];
        if (!r) return full;
        const title = r.title ? ` "${r.title}"` : "";
        return `[${label}](${r.href}${title})`;
      })
    );

    function parseBlocks(lines) {
      let out = [];
      let idx = 0;
      while (idx < lines.length) {
        const line = lines[idx];
        if (isBlank(line)) { idx++; continue; }

        // fenced code
        const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
        if (fence) {
          const indent = fence[1].length;
          const marker = fence[2][0];
          const minLen = fence[2].length;
          const lang = fence[3] || "";
          const buf = [];
          idx++;
          while (idx < lines.length) {
            const l = lines[idx];
            const close = l.match(/^(\s*)(`{3,}|~{3,})\s*$/);
            if (close && close[2][0] === marker && close[2].length >= minLen) { idx++; break; }
            buf.push(l.replace(new RegExp("^\\s{0," + (indent || 0) + "}"), ""));
            idx++;
          }
          out.push(renderCode(lang, buf.join("\n")));
          continue;
        }

        // math block $$ ... $$  (single-line, or multi-line with closing $$)
        if (/^\s{0,3}\$\$/.test(line)) {
          const single = line.match(/^\s{0,3}\$\$(.+)\$\$\s*$/);
          if (single) {
            out.push(renderMath(single[1], true));
            idx++; continue;
          }
          const firstRest = line.replace(/^\s{0,3}\$\$/, "");
          let k = idx + 1;
          let closeIdx = -1;
          while (k < lines.length) {
            if (lines[k].indexOf("$$") !== -1) { closeIdx = k; break; }
            k++;
          }
          if (closeIdx !== -1) {
            const buf = [];
            if (firstRest.trim()) buf.push(firstRest);
            for (let j = idx + 1; j < closeIdx; j++) buf.push(lines[j]);
            const tail = lines[closeIdx].split("$$")[0];
            if (tail.trim()) buf.push(tail);
            out.push(renderMath(buf.join("\n"), true));
            idx = closeIdx + 1;
            continue;
          }
          // unclosed $$: fall through and render literally as a paragraph
        }

        // heading ATX
        const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (h) {
          const level = h[1].length;
          const id = slugify(h[2]);
          out.push(`<h${level} id="${id}">${renderInline(h[2])}</h${level}>`);
          idx++; continue;
        }

        // hr
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
          out.push("<hr>"); idx++; continue;
        }

        // blockquote
        if (/^\s{0,3}>/.test(line)) {
          const buf = [];
          while (idx < lines.length && (/^\s{0,3}>/.test(lines[idx]) || (!isBlank(lines[idx]) && buf.length && !/^\s{0,3}#{1,6}\s/.test(lines[idx]) && /^\s{0,3}>/.test(buf[buf.length-1]||"")))) {
            buf.push(lines[idx].replace(/^\s{0,3}>\s?/, ""));
            idx++;
          }
          // also absorb lazy continuation lines
          while (idx < lines.length && !isBlank(lines[idx]) && !/^\s{0,3}(>|#{1,6}\s|```|~~~)/.test(lines[idx]) && !LIST_RE.test(lines[idx])) {
            buf.push(lines[idx]); idx++;
          }
          out.push("<blockquote>" + parseBlocks(buf) + "</blockquote>");
          continue;
        }

        // table (delimiter row must contain a pipe so bare --- stays setext/hr)
        if (line.includes("|") && idx + 1 < lines.length && lines[idx + 1].includes("|") && TABLE_DELIM_RE.test(lines[idx + 1])) {
          const header = splitRow(line);
          const aligns = splitRow(lines[idx + 1]).map((c) => {
            c = c.trim();
            if (/^:-+:$/.test(c)) return "center";
            if (/^:-+$/.test(c)) return "left";
            if (/^-+:$/.test(c)) return "right";
            return "";
          });
          idx += 2;
          const rows = [];
          while (idx < lines.length && lines[idx].includes("|") && !isBlank(lines[idx])) {
            rows.push(splitRow(lines[idx]));
            idx++;
          }
          out.push(renderTable(header, aligns, rows));
          continue;
        }

        // list
        if (LIST_RE.test(line)) {
          const res = parseList(lines, idx);
          out.push(res.html);
          idx = res.next;
          continue;
        }

        // setext heading (=== or ---)
        if (idx + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[idx + 1]) && !isBlank(line) && !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
          const level = lines[idx + 1].trim()[0] === "=" ? 1 : 2;
          const id = slugify(line);
          out.push(`<h${level} id="${id}">${renderInline(line.trim())}</h${level}>`);
          idx += 2; continue;
        }

        // HTML block (line starts with <tag)
        if (/^\s{0,3}<([a-zA-Z][\w-]*)(\s|>|\/)/.test(line) || /^\s{0,3}<!--/.test(line)) {
          const buf = [];
          while (idx < lines.length && !isBlank(lines[idx])) { buf.push(lines[idx]); idx++; }
          out.push(sanitizeHtml(buf.join("\n")));
          continue;
        }

        // paragraph
        const para = [];
        while (idx < lines.length && !isBlank(lines[idx]) &&
               !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[idx]) &&
               !(LIST_RE.test(lines[idx]) && para.length >= 0 && !/^\s+\S/.test(lines[idx])) &&
               !(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[idx]))) {
          // stop paragraph if a table starts right after
          if (para.length && lines[idx].includes("|") && idx + 1 < lines.length && lines[idx + 1].includes("|") && TABLE_DELIM_RE.test(lines[idx + 1])) break;
          para.push(lines[idx]);
          idx++;
          if (idx < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[idx]) && para.length === 1) break;
        }
        // footnote definition block  [^id]: text (up to 3 leading spaces)
        if (/^\s{0,3}\[\^[^\]]+\]:/.test(para[0])) {
          const defs = [];
          for (const pl of para) {
            const m = pl.match(/^\s{0,3}\[\^([^\]]+)\]:\s*([\s\S]*)$/);
            if (m) defs.push({ id: m[1], text: m[2] });
            else if (defs.length) defs[defs.length - 1].text += " " + pl.trim();
          }
          out.push(`<div class="footnote-defs">` + defs.map(d =>
            `<div class="footnote-def" id="fn-${esc(d.id)}"><span class="fn-num">${esc(d.id)}.</span> ${renderInline(d.text)}</div>`
          ).join("") + `</div>`);
          continue;
        }
        out.push("<p>" + para.map((l) => renderInline(l)).join("\n") + "</p>");
      }
      return out.join("\n");
    }

    return parseBlocks(resolved);
  }

  const LIST_RE = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/;
  const TABLE_DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  function isBlank(l) { return /^\s*$/.test(l); }

  // Reject javascript:/vbscript:/data:text-html URLs (defense against XSS)
  function isUnsafeUrl(u) {
    const s = String(u || "").replace(/[\u0000-\u001f\s]/g, "").toLowerCase();
    return /^(javascript|vbscript):/.test(s) ||
           /^data:text\/html/.test(s) ||
           (/^data:/.test(s) && !/^data:image\//.test(s));
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    const cells = [];
    let cur = "", inCode = false;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (ch === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
      if (ch === "`") inCode = !inCode;
      if (ch === "|" && !inCode) { cells.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  }

  function renderTable(header, aligns, rows) {
    const al = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : "");
    let html = "<div class=\"table-wrap\"><table><thead><tr>";
    header.forEach((c, k) => (html += `<th${al(k)}>${renderInline(c)}</th>`));
    html += "</tr></thead><tbody>";
    for (const row of rows) {
      html += "<tr>";
      for (let k = 0; k < header.length; k++) {
        html += `<td${al(k)}>${renderInline(row[k] != null ? row[k] : "")}</td>`;
      }
      html += "</tr>";
    }
    html += "</tbody></table></div>";
    return html;
  }

  function parseList(lines, start) {
    const first = lines[start];
    const baseIndent = first.match(/^(\s*)/)[1].length;
    const ordered = /^\s{0,3}\d{1,9}[.)]\s+/.test(first);
    const marker = ordered ? first.match(/^\s*(\d{1,9})[.)]/)[1] : null;
    // different bullet chars (- * +) start different lists (CommonMark)
    const bulletChar = ordered ? null : first.match(/^\s{0,3}([-*+])/)[1];
    const items = [];
    let idx = start;

    while (idx < lines.length) {
      const line = lines[idx];
      const m = line.match(/^(\s{0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/);
      if (!m) {
        // continuation of previous item?
        if (items.length && !isBlank(line) && /^\s{2,}/.test(line)) {
          items[items.length - 1].push(line.replace(new RegExp("^\\s{0," + (baseIndent + 2) + "}"), ""));
          idx++;
          continue;
        }
        break;
      }
      const itemIndent = m[1].length;
      if (itemIndent !== baseIndent) break;
      const thisOrdered = /\d/.test(m[2]);
      if (thisOrdered !== ordered) break;
      if (!ordered && m[2][0] !== bulletChar) break;
      const content = [m[3]];
      idx++;
      // gather nested / continuation lines belonging to this item
      while (idx < lines.length) {
        const l = lines[idx];
        if (isBlank(l)) {
          // lookahead: blank then indented -> keep as item content
          if (idx + 1 < lines.length && /^\s{2,}/.test(lines[idx + 1])) {
            content.push("");
            idx++;
            continue;
          }
          break;
        }
        const lm = l.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/);
        if (lm && lm[1].length <= baseIndent) break;
        content.push(l.replace(new RegExp("^\\s{0," + (baseIndent + 2) + "}"), ""));
        idx++;
      }
      items.push(content);
    }

    const tag = ordered ? "ol" : "ul";
    const startAttr = ordered && marker && marker !== "1" ? ` start="${marker}"` : "";
    let html = `<${tag}${startAttr}>`;
    for (const content of items) {
      // task list
      let cls = "", inner = content.join("\n");
      const task = inner.match(/^\s*\[([ xX])\]\s+([\s\S]*)$/);
      let lead = "";
      let body = "";
      if (task) {
        cls = " task-item";
        const checked = task[1].toLowerCase() === "x" ? " checked" : "";
        lead = `<input type="checkbox" disabled${checked}> `;
        body = renderBlocksBody(task[2].split("\n"));
      } else {
        // tight vs loose: if content has blank line or multiple blocks
        body = renderBlocksBody(content);
      }
      const tight = !content.some((l) => isBlank(l)) && !/^\s*([-*+]|\d{1,9}[.)])\s+/.test((content[1] || ""));
      html += `<li class="${cls.trim()}"${tight ? ' data-tight="1"' : ""}>${lead}${body}</li>`;
    }
    html += `</${tag}>`;
    return { html, next: idx };
  }

  // Render item body: if it's a single paragraph, keep inline; else blocks.
  // Nested lists appear here as their own lines, so a block is present when:
  //   - the first line is a list marker (a nested list), or
  //   - any line looks like a heading / blockquote / fence, or
  //   - a blank line separates multiple blocks.
  function renderBlocksBody(lines) {
    while (lines.length && isBlank(lines[0])) lines.shift();
    while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
    if (!lines.length) return "";

    // loose item (blank line inside) -> full block parse => multiple <p>
    if (lines.some(isBlank)) return parse(lines.join("\n"));

    const firstIsText = !LIST_RE.test(lines[0]);
    const hasBlock =
      LIST_RE.test(lines[0]) ||
      lines.some((l) =>
        LIST_RE.test(l) ||
        /^\s{0,3}(#{1,6}\s|>|```|~~~|([-*_])(\s*\2){2,}\s*$)/.test(l)
      );

    if (hasBlock) {
      // Parse the whole item body as blocks. Pull the leading paragraph text
      // (before the first nested list) out so a tight item still reads well.
      if (firstIsText) {
        let k = 0;
        const head = [];
        while (k < lines.length && !LIST_RE.test(lines[k]) && !isBlank(lines[k])) {
          head.push(lines[k]); k++;
        }
        // drop a single blank separator before the nested list
        while (k < lines.length && isBlank(lines[k])) k++;
        // If the list marker follows the head text directly (no blank line),
        // keep the head tight (no <p> wrapper); otherwise wrap in a paragraph.
        const hadBlankBeforeList = k > head.length;
        const headHtml = head.length
          ? (hadBlankBeforeList
              ? "<p>" + head.map(renderInline).join("\n") + "</p>"
              : head.map(renderInline).join("\n"))
          : "";
        const restHtml = k < lines.length ? parse(lines.slice(k).join("\n")) : "";
        return headHtml + restHtml;
      }
      return parse(lines.join("\n"));
    }
    if (lines.length === 1) return renderInline(lines[0]);
    // multiple lines of a single paragraph
    return renderInline(lines.join("\n"));
  }

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\w\u4e00-\u9fa5\- ]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  }

  // ---- Code highlighting (minimal, regex based) -----------------------
  const KEYWORDS = {
    js: "const let var function return if else for while class new this import export from default async await try catch throw typeof instanceof switch case break continue do delete in of yield static get set extends super null true false undefined",
    ts: "const let var function return if else for while class new this import export from default async await try catch throw typeof instanceof switch case break continue interface type enum implements extends public private protected readonly any string number boolean void null true false undefined",
    py: "def class return if elif else for while import from as try except finally raise with lambda pass break continue yield global nonlocal assert del in is not and or None True False self async await",
    java: "public private protected class interface extends implements static final void int long double float boolean char String new return if else for while switch case break continue try catch finally throw throws import package this super null true false abstract synchronized volatile transient enum",
    c: "int char float double void long short unsigned signed struct union enum typedef static const volatile extern register return if else for while do switch case break continue goto sizeof NULL true false",
    cpp: "int char float double void long short unsigned signed struct union enum typedef static const volatile extern register return if else for while do switch case break continue goto sizeof class public private protected virtual template typename namespace using new delete this nullptr true false",
    cs: "using namespace class struct interface public private protected internal static void int string var new return if else for foreach while switch case break continue try catch finally throw this base null true false async await",
    go: "package import func var const type struct interface map chan go defer return if else for range switch case break continue default nil true false string int",
    rs: "fn let mut const static struct enum impl trait pub use mod return if else for while loop match break continue self Self true false",
    sh: "if then else fi for do done while case esac function echo export local return cd ls grep sed awk cat",
    sql: "select from where insert into values update set delete create table drop alter join left right inner outer on group by order having limit offset as and or not null",
  };

  const LANG_ALIAS = {
    python: "py", python3: "py", py3: "py",
    javascript: "js", jsx: "js", node: "js", mjs: "js",
    typescript: "ts", tsx: "ts",
    "c++": "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp",
    "c#": "cs", csharp: "cs",
    golang: "go", rust: "rs",
    bash: "sh", shell: "sh", zsh: "sh", console: "sh", powershell: "sh", ps1: "sh",
    mysql: "sql", postgres: "sql", postgresql: "sql", sqlite: "sql",
    java8: "java", kotlin: "java",
    rs: "rs", ts: "ts",
  };
  function resolveLang(lang) {
    const l = String(lang || "").toLowerCase();
    return LANG_ALIAS[l] || l;
  }

  // Tokenize protected regions (strings, comments) first into placeholders,
  // then keyword/number-highlight the plain code, then restore placeholders.
  function highlight(code, lang) {
    const key = resolveLang(lang);
    const kw = KEYWORDS[key] || null;
    const slots = [];
    // Placeholder uses only letters so the number/keyword regexes cannot
    // corrupt it while highlighting the remaining plain code.
    const reserve = (html) => {
      let n = slots.length;
      let id = "";
      do { id = String.fromCharCode(97 + (n % 26)) + id; n = Math.floor(n / 26); } while (n > 0);
      const k = "\u0001" + id + "\u0001";
      slots.push(html);
      return k;
    };

    let out = esc(code);

    // 1. strings (single/double/backtick) — match on escaped quotes
    out = out.replace(/(&quot;(?:\\.|[^&])*?&quot;|&#39;(?:\\.|[^&])*?&#39;|`[^`]*`)/g,
      (m) => reserve('<span class="tok-str">' + m + "</span>"));

    // 2. comments (after strings so # inside a string is safe)
    out = out.replace(/(\/\/[^\n]*|#[^\n]*|--[^\n]*)/g,
      (m) => reserve('<span class="tok-com">' + m + "</span>"));

    // 3. numbers
    out = out.replace(/\b(\d+(?:\.\d+)?)\b/g,
      (m) => reserve('<span class="tok-num">' + m + "</span>"));

    // 4. keywords
    if (kw) {
      const words = kw.split(/\s+/).filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const re = new RegExp("\\b(" + words.join("|") + ")\\b", "g");
      out = out.replace(re, (m) => reserve('<span class="tok-kw">' + m + "</span>"));
    }

    // 5. restore placeholders
    out = out.replace(/\u0001([a-z]+)\u0001/g, (_, id) => {
      let n = 0;
      for (const ch of id) n = n * 26 + (ch.charCodeAt(0) - 97);
      return slots[n] != null ? slots[n] : "";
    });
    return out;
  }

  let lastCodeId = 0;
  function renderCode(lang, code) {
    const l = String(lang || "").toLowerCase();
    // mermaid blocks become diagram containers, NOT code blocks
    if (l === "mermaid" || l.startsWith("mermaid-") || l === "mermaid-diagram") {
      return '<div class="mermaid-block" data-lang="mermaid">'
        + '<div class="code-head"><span class="code-lang">mermaid</span></div>'
        + '<pre class="mermaid-src" hidden>' + esc(code) + "</pre>"
        + "</div>";
    }
    const id = "code-" + ++lastCodeId;
    const body = lang ? highlight(code, l) : esc(code);
    return (
      `<div class="code-block" data-lang="${esc(lang || "text")}">` +
      `<div class="code-head"><span class="code-lang">${esc(lang || "text")}</span>` +
      `<button class="code-copy" type="button" data-code-id="${id}">Copy</button></div>` +
      `<pre id="${id}"><code>${body}</code></pre></div>`
    );
  }

  // ---- mermaid enhancement --------------------------------------------
  // Runs after each render: prefers vendored full mermaid.js
  // (web/vendor/mermaid/mermaid.min.js), falls back to the built-in
  // mermaid-mini flowchart engine, and on failure shows the raw source.
  let mermaidSeq = 0;

  // 把缩放系数应用到 mermaid SVG。
  // 不能用 CSS zoom：当 SVG 宽度被 max-width:100% 钳制（超宽图收缩适配）时，
  // Chromium 里 zoom 会被百分比 max-width 抵消，画面不变。因此改用显式宽度：
  // 放大时按固有宽 × 系数设 style.width 并解除 max-width，让图溢出容器，
  // 由 .mermaid-svg 的 overflow:auto 提供滚动/平移；k=1 时清除内联样式恢复适配。
  function setMermaidSvgZoom(svg, k) {
    if (!svg) return;
    k = Math.max(0.2, Math.min(8, parseFloat(k) || 1));
    svg.style.zoom = "";
    if (Math.abs(k - 1) < 0.001) {
      svg.style.maxWidth = "";
      svg.style.width = "";
      svg.style.height = "";
      return;
    }
    const attr = (svg.getAttribute("width") || "").trim();
    let w = /%$/.test(attr) ? NaN : parseFloat(attr);
    if (!isFinite(w) || w <= 0) {
      const savedW = svg.style.width, savedMax = svg.style.maxWidth;
      svg.style.maxWidth = "none";
      svg.style.width = "auto";
      w = svg.getBoundingClientRect().width;
      svg.style.width = savedW;
      svg.style.maxWidth = savedMax;
    }
    if (!isFinite(w) || w <= 0) return;
    svg.style.maxWidth = "none";
    svg.style.width = Math.round(w * k) + "px";
    svg.style.height = "auto";
  }

  function showMermaidFallback(el, src) {
    try {
      const svg = global.MermaidMini && global.MermaidMini.render(src);
      if (svg) {
        const holder = document.createElement("div");
        holder.className = "mermaid-svg";
        holder.innerHTML = svg;
        el.appendChild(holder);
        return;
      }
    } catch (e) { /* fall through */ }
    const srcEl = el.querySelector(".mermaid-src");
    if (srcEl) srcEl.hidden = false;
  }

  function enhanceMermaid(root) {
    const blocks = root.querySelectorAll(".mermaid-block:not([data-done])");
    blocks.forEach((el) => {
      el.setAttribute("data-done", "1");
      const srcEl = el.querySelector(".mermaid-src");
      const src = srcEl ? srcEl.textContent : "";
      if (typeof global.mermaid !== "undefined" && global.mermaid && typeof global.mermaid.run === "function") {
        try {
          const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
          global.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme });
          global.mermaid.render("mmd-" + (++mermaidSeq), src).then(
            (res) => {
              const svg = res && (res.svg || res);
              const holder = document.createElement("div");
              holder.className = "mermaid-svg";
              holder.innerHTML = svg;
              el.appendChild(holder);
              const z = parseFloat(el.dataset.zoom || "1");
              if (z !== 1) setMermaidSvgZoom(holder.querySelector("svg"), z);
            },
            () => showMermaidFallback(el, src)
          );
          return;
        } catch (e) { /* fall through to mini */ }
      }
      showMermaidFallback(el, src);
    });
  }

  function rerenderMermaid(root) {
    root.querySelectorAll(".mermaid-block").forEach((el) => {
      const svg = el.querySelector(".mermaid-svg");
      if (svg) svg.remove();
      el.removeAttribute("data-done");
    });
    enhanceMermaid(root);
  }

  // asset resolver injected by app.js (turns relative image paths into data URLs)
  let assetResolver = (p) => p;
  function resolveAsset(p) {
    try { return assetResolver(p); } catch (e) { return p; }
  }

  function setAssetResolver(fn) { assetResolver = fn; }

  global.MDRender = { parse, setAssetResolver, esc, sanitizeHtml, _highlight: highlight, enhanceMermaid, rerenderMermaid, setMermaidSvgZoom };
})(window);
