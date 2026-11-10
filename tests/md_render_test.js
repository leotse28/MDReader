/* markdown.js 渲染器穷举测试（Node 直跑，无需 GUI）
   用法: node tests/md_render_test.js   -> 全过输出 ALL RENDER TESTS PASSED */
"use strict";

global.window = global; // markdown.js 是 IIFE(global)
require("../app/web/js/markdown.js");
const MD = global.MDRender;

let passed = 0, failed = 0;
const failures = [];

function t(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; failures.push(`${name}${detail ? " :: " + detail : ""}`); }
}
const html = (md) => MD.parse(md);

/* ---------- 标题 ---------- */
{
  const h = html("# 一级标题\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级");
  for (let i = 1; i <= 6; i++) t(`h${i} 渲染`, h.includes(`<h${i}`));
  t("标题 id 含 CJK", /id="一级标题"/.test(h), h.match(/<h1[^>]*>/)?.[0]);
  t("7个#不是标题", !html("####### seven").includes("<h7"));
  t("闭合井号剥离", html("## 带闭合 ##").includes(">带闭合</h2>"));
  t("setext h1", html("Title\n=====").includes("<h1"));
  t("setext h2", html("Title\n-----").includes("<h2"));
}

/* ---------- 行内样式 ---------- */
{
  const h = html("***bi*** **b** *i* __u__ _i_ ~~s~~ ==m== `c`");
  t("粗斜体", h.includes("<strong><em>bi</em></strong>"), h);
  t("粗体*", h.includes("<strong>b</strong>"));
  t("粗体__", h.includes("<strong>u</strong>"));
  t("斜体*", h.includes("<em>i</em>"));
  t("斜体_", h.includes("<em>i</em>"));
  t("删除线", h.includes("<del>s</del>"));
  t("高亮", h.includes("<mark>m</mark>"));
  t("行内代码", h.includes("<code>c</code>"));
}

/* ---------- 下划线词内不斜体（CommonMark 规则） ---------- */
{
  const h = html("my_var_name and snake_case_x");
  t("词内下划线不斜体", !h.includes("<em>"), h);
  const h2 = html("正常 _强调_ 结束");
  t("正常下划线强调", h2.includes("<em>强调</em>"));
  const h3 = html("**粗**_斜_");
  t("粗后紧跟_斜_", h3.includes("<em>斜</em>"), h3);
}

/* ---------- 行内代码 ---------- */
{
  t("单反引号", html("`a`").includes("<code>a</code>"));
  t("双反引号包内含反引号", html("``a`b``").includes("<code>a`b</code>"));
  t("代码内不解析强调", html("`**not bold**`").includes("<code>**not bold**</code>"));
  t("代码内不自动链接", html("`http://x.com`").includes("<code>http://x.com</code>") && !html("`http://x.com`").includes("<a href"));
  t("代码内实体转义", html("`<div>`").includes("<code>&lt;div&gt;</code>"));
}

/* ---------- 链接 ---------- */
{
  const h = html("[文本](https://a.com)");
  t("基本链接", h.includes('href="https://a.com"') && h.includes("data-mdlink"));
  t("链接 target blank", h.includes('target="_blank"'));
  t("链接标题双引号", html('[a](https://a.com "t")').includes('title="t"'));
  t("链接标题单引号", html("[a](https://a.com 't')").includes('title="t"'));
  t("锚点链接无 target", !html("[a](#sec)").includes('target="_blank"'));
  t("尖括号自动链接", html("<https://a.com>").includes('href="https://a.com"'));
  const bare = html("访问 https://a.com/x?q=1&r=2 结束");
  t("裸 URL 自动链接", bare.includes('href="https://a.com/x?q=1&amp;r=2"'), bare);
  t("ref 链接", html("[a][ref1]\n\n[ref1]: https://r.com").includes('href="https://r.com"'));
  t("ref 链接隐式", html("[ref1][]\n\n[ref1]: https://r.com").includes('href="https://r.com"'));
  t("相对链接保留", html("[x](sub/other.md)").includes('href="sub/other.md"'));
  t("链接嵌套强调", html("[**粗**](https://a.com)").includes("<strong>粗</strong>"));
}

/* ---------- 图片 ---------- */
{
  const h = html("![alt](pic.png)");
  t("图片 data-src", h.includes('data-src="pic.png"'));
  t("图片标题", html('![a](p.png "t")').includes('title="t"'));
  const bad = html("![a](javascript:alert(1))");
  t("js 图片被剥", !bad.includes("javascript:"), bad);
  const dta = html("![a](data:text/html;base64,AAAA)");
  t("data:text/html 图片被剥", !dta.includes("data:text/html"), dta);
  const ok = html("![a](data:image/png;base64,AAAA)");
  t("data:image 允许", ok.includes('data:image/png;base64,AAAA'));
}

/* ---------- 转义 ---------- */
{
  t("转义星号", html("\\*not em\\*").includes("*not em*") && !html("\\*x\\*").includes("<em>"));
  t("转义下划线", !html("\\_x\\_").includes("<em>"));
  t("转义方括号", html("\\[x\\]").includes("[x]") && !html("\\[x\\]").includes("<a"));
  t("转义反引号", html("\\`x").includes("`x"));
}

/* ---------- 块级引用 ---------- */
{
  t("引用", html("> q").includes("<blockquote>"));
  t("引用段落", html("> q").includes("<p>q</p>"));
  const n = html("> a\n> > b");
  t("嵌套引用", (n.match(/<blockquote>/g) || []).length >= 2, n);
  const w = html("> 引用\n> ```py\n> code\n> ```");
  t("引用内代码块", w.includes("<blockquote>") && w.includes("<pre"), w);
}

/* ---------- 列表 ---------- */
{
  t("无序列表", (html("- a\n- b").match(/<li[ >]/g) || []).length === 2);
  t("有序列表", html("1. a\n2. b").includes("<ol>"));
  t("有序 start 属性", html("3. a\n4. b").includes('start="3"'));
  t("圆括号有序", html("1) a").includes("<ol>"));
  t("嵌套列表", /a<ul>/.test(html("- a\n  - b\n  - c")));
  t("三层嵌套", html("- a\n  - b\n    - c").split("<ul>").length >= 3);
  const mix = html("- a\n* b\n+ c");
  t("不同 bullet 分属不同列表", (mix.match(/<ul>/g) || []).length === 3, mix);
  t("任务列表勾选", html("- [x] done").includes("checked"));
  t("任务列表未勾", html("- [ ] todo").includes("checkbox") && !html("- [ ] todo").includes("checked"));
  t("列表项多段", html("- a\n\n  b").includes("<p>b</p>"), html("- a\n\n  b"));
  t("列表内代码块", /<pre id="code-\d+"><code>/.test(html("- item\n\n  ```py\n  x=1\n  ```")));
}

/* ---------- 表格 ---------- */
{
  const h = html("| A | B |\n| --- | --- |\n| 1 | 2 |");
  t("表格渲染", h.includes("<table>") && h.includes("<th>A</th>") && h.includes("<td>2</td>"));
  t("左对齐", html("| A |\n| :-- |\n| 1 |").includes("text-align:left"));
  t("居中", html("| A |\n| :-: |\n| 1 |").includes("text-align:center"));
  t("右对齐", html("| A |\n| --: |\n| 1 |").includes("text-align:right"));
  t("缺列补空", html("| A | B |\n| --- | --- |\n| 1 |").includes("<td></td>"));
  const pipe = html("| a | b |\n| --- | --- |\n| `x\\|y` | c |");
  t("转义竖线", pipe.includes("<td>x|y</td>") || pipe.includes("<code>x|y</code>"), pipe);
  const bare = html("a|b\n-|-");
  t("无包围竖线表格", bare.includes("<table>"), bare);
  const code = html("| a | b |\n| --- | --- |\n| `x|y` | c |");
  t("代码内竖线不切列", code.includes("<code>x|y</code>"), code);
}

/* ---------- 代码块与高亮 ---------- */
{
  const h = html("```python\ndef f(): return 1  # 注释\n```");
  t("代码块", /<pre id="code-\d+"><code>/.test(h));
  t("语言标注", h.includes("python"));
  t("关键字高亮", h.includes("tok-kw"));
  t("注释高亮", h.includes("tok-com"));
  const h2 = html("```\nplain ``` not fence\n```");
  t("无语言代码块", h2.includes("text"));
  const h3 = html("~~~js\nlet x = 1;\n~~~");
  t("波浪围栏", h3.includes("tok-kw") && h3.includes("let"), h3);
  t("未闭合围栏", /<pre id="code-\d+"><code>/.test(html("```py\nx=1")));
  const ind = html("    code block?\n    line2");
  t("4空格缩进段落不吞内容", ind.length > 0);
  const h4 = html("```js\nconst s = \"str\"; // c\n```");
  t("字符串高亮", h4.includes("tok-str"), h4);
  t("数字高亮", html("```py\nx = 42\n```").includes("tok-num"));
  t("代码内 HTML 转义", html("```\n<div>\n```").includes("&lt;div&gt;"));
}

/* ---------- 脚注 ---------- */
{
  const h = html("正文[^1]\n\n[^1]: 注释内容");
  t("脚注引用", h.includes("fnref-1"));
  t("脚注定义", h.includes("footnote-def") && h.includes("注释内容"));
  t("缩进脚注", html("正文[^2]\n\n  [^2]: 缩进注释").includes("footnote-def"));
  const h2 = html("a[^b] b[^a]\n\n[^a]: A\n[^b]: B");
  t("乱序脚注 id", h2.includes('id="fn-a"') && h2.includes('id="fn-b"'));
}

/* ---------- 结构与鲁棒性 ---------- */
{
  t("CRLF 输入", html("a\r\nb\r\rc").includes("<p>"));
  t("空输入", html("") === "");
  t("纯空白", html("   \n\t\n").trim() === "");
  t("tab 转空格", html("\t正文").includes("正文"));
  const hr = html("---\n\n***\n\n___");
  t("分隔线三变体", (hr.match(/<hr>/g) || []).length === 3, hr);
  t("段落软换行保留", html("a\nb").includes("a\nb"));
  t("段落合并多行", (html("a\nb\nc").match(/<p>/g) || []).length === 1);
  t("标题后段落", html("# T\n\npara").includes("<p>para</p>"));
  t("大量嵌套不崩", html("- a\n" + "  ".repeat(30) + "- deep").length > 0);
  const deep = "- " + "x".repeat(1) + "\n" + Array.from({length: 50}, (_, i) => " ".repeat(i * 2) + "- y").join("\n");
  t("50 层深列表不崩", html(deep).length > 0);
  t("长文本性能", (() => { const s = Date.now(); html(("段落 **粗** *斜* `码`\n\n").repeat(5000)); return Date.now() - s < 3000; })());
}

/* ---------- slug 唯一性 ---------- */
{
  const h = html("# Same\n\n## Same");
  const ids = h.match(/id="same"/g) || [];
  t("相同标题各自有 id", ids.length === 2, h);
}

/* ---------- XSS（渲染层面，净化用真实 DOM 在自检里测） ---------- */
{
  const h = html("[x](javascript:alert(1))");
  t("js 链接被剥", !h.includes("javascript:"), h);
  const h2 = html("[x](vbscript:msgbox)");
  t("vbscript 链接被剥", !h2.includes("vbscript:"), h2);
  const h3 = html("[x](data:text/html,<script>)");
  t("data:html 链接被剥", !h3.includes("data:text/html"), h3);
  const h4 = html("![x](javascript:alert(1))");
  t("js 图片被剥", !h4.includes("javascript:"), h4);
}

console.log(`\nrender: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("ALL RENDER TESTS PASSED");
