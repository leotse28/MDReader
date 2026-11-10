/* 数学渲染测试：miniTeX 兜底 + KaTeX 检测（Node 无 katex，走 fallback） */
"use strict";

global.window = global;
require("../app/web/js/markdown.js");
const MD = global.MDRender;

let passed = 0, failed = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) passed++;
  else { failed++; failures.push(`${name}${detail ? " :: " + detail : ""}`); }
}
const html = (md) => MD.parse(md);

/* ---------- 行内公式 $...$ ---------- */
{
  const h = html("欧拉公式 $e^{i\\pi}+1=0$ 很美");
  t("行内公式渲染", h.includes("math-inline"), h);
  t("上标", h.includes("mx-sup") && h.includes("i\\u03c0") === false && h.includes("\u03c0"), h);
  t("公式不参与强调", !h.includes("<em>") && !h.includes("<strong>"), h);
  t("纯文本保留", h.includes("欧拉公式") && h.includes("很美"));

  const f = html("分式 $\\frac{a}{b}$ 与根号 $\\sqrt{x}$");
  t("分式结构", f.includes("mx-frac") && f.includes("mx-num") && f.includes("mx-den"), f);
  t("根号", f.includes("mx-sqrt") && f.includes("\u221a"), f);

  const g = html("希腊字母 $\\alpha\\beta\\Gamma$ 表");
  t("希腊字母", g.includes("\u03b1") && g.includes("\u03b2") && g.includes("\u0393"), g);

  const s = html("求和 $\\sum_{i=1}^{n} x_i$");
  t("求和符号", s.includes("\u2211"), s);
  t("下标", s.includes("mx-sub"), s);

  const m = html("矩阵 $A \\times B \\neq C$");
  t("运算符", m.includes("\u00d7") && m.includes("\u2260"), m);

  const lim = html("极限 $\\lim_{n \\to \\infty} a_n$");
  t("极限+箭头+无穷", lim.includes("\u2192") && lim.includes("\u221e"), lim);
}

/* ---------- 美元符号不误判 ---------- */
{
  const h = html("价格是 $5，买 $10 的");
  t("人民币语境不渲染", !h.includes("math-inline"), h);
  const h2 = html("It costs $5 and $10 total");
  t("英文金额不渲染", !h2.includes("math-inline"), h2);
  const h3 = html("转义 \\$5 是字面美元");
  t("转义美元", !h3.includes("math-inline"), h3);
  const h4 = html("数字 $42$ 保持字面");
  t("纯数字字面", !h4.includes("math-inline"), h4);
  t("数字仍在文本", h4.includes("42"));
}

/* ---------- 紧跟全角标点 / CJK 的公式 ---------- */
{
  const h = html("希腊字母：$\\alpha$ 与 $\\beta$。");
  t("全角冒号后的公式", h.includes("\u03b1") && !h.includes("$\\alpha"), h);
  const h2 = html("其中$x$满足条件");
  t("CJK 紧邻公式", h2.includes("math-inline"), h2);
  const h3 = html("范围（$0, 1$）内");
  t("全角括号紧邻公式", h3.includes("math-inline"), h3);
}

/* ---------- 代码内 $ 不触发 ---------- */
{
  const h = html("代码 `$x^2$` 保持原样。\n\n```py\ny=$x$\n```\n\n完");
  t("行内代码中的公式不渲染", !h.match(/<code[^>]*>[\s\S]*?math-inline/), h);
  t("代码块中的公式不渲染", (h.match(/math-inline/g) || []).length === 0, h);
  t("代码块内容原样", h.includes("y=$x$"), h);
}

/* ---------- 块级公式 $$...$$ ---------- */
{
  const h = html("$$\\int_0^1 x^2 dx = \\frac{1}{3}$$");
  t("单行块公式", h.includes("math-block") && h.includes("\u222b") && h.includes("mx-frac"), h);

  const h2 = html("前文\n\n$$\na^2 + b^2 = c^2\n$$\n\n后文");
  t("多行块公式", h2.includes("math-block") && h2.includes("前文") && h2.includes("后文"), h2);

  const h3 = html("$$\nE = mc^2\n");
  t("未闭合回落为段落", !h3.includes("math-block") && h3.includes("E = mc^2"), h3);

  const h4 = html("正文\n\n$$x+y$$\n\n结尾");
  t("块公式前后段落完好", h4.includes("<p>正文</p>") && h4.includes("<p>结尾</p>"), h4);
}

/* ---------- XSS：TeX 内容全转义 ---------- */
{
  const h = html("$\\text{<script>alert(1)</script>}$");
  t("TeX 内无真实 script 标签", !h.includes("<script>") && !h.includes("alert(1)</"), h);
  const h2 = html("$x <script>alert(2)</script>$");
  t("公式外注入仍被转义", !h2.includes("<script>"), h2);
}

/* ---------- 常见组合压力 ---------- */
{
  const cases = [
    "$\\vec{F} = m\\vec{a}$", "$\\hat{y} = \\bar{x}$", "$\\overline{\\psi}$",
    "$a_1 + a_2 + \\cdots + a_n$", "$\\frac{\\partial y}{\\partial x}$",
    "$\\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0}$",
    "$\\left( a + b \\right)^2$", "$\\text{if } x > 0$", "$50\\%$ 的",
    "$p \\Rightarrow q$", "$\\mathbf{v} \\times \\mathbf{B}$",
  ];
  let ok = true;
  for (const c of cases) {
    const h = html(c);
    if (!h.includes("math-inline")) { ok = false; failures.push("case failed: " + c + " :: " + h); }
  }
  t("常见 TeX 组合全部渲染", ok);
}

console.log(`\nmath: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("ALL MATH TESTS PASSED");
