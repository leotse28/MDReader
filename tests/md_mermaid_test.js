/* mermaid-mini 引擎测试（Node 直跑）+ markdown.js 集成回归 */
"use strict";

global.window = global;
require("../app/web/js/mermaid-mini.js");
const MM = global.MermaidMini;
require("../app/web/js/markdown.js");
const MD = global.MDRender;

let passed = 0, failed = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) passed++;
  else { failed++; failures.push(`${name}${detail ? " :: " + String(detail).slice(0, 200) : ""}`); }
}

/* ---------- supported() ---------- */
t("flowchart 识别", MM.supported("flowchart LR\nA --> B"));
t("graph 识别", MM.supported("graph TD\nA --> B"));
t("sequenceDiagram 不支持", !MM.supported("sequenceDiagram\nA->>B: hi"));

/* ---------- 基础流程图 ---------- */
{
  const svg = MM.render("flowchart TD\nA[开始] --> B[处理]\nB --> C[结束]");
  t("TD 渲染出 svg", !!svg && svg.includes("<svg"), svg);
  t("3 个节点", (svg.match(/class="me-node"/g) || []).length === 3, svg);
  t("2 条边", (svg.match(/class="me-edge/g) || []).length === 2, svg);
  t("箭头标记", svg.includes("marker-end"), svg);
  t("节点文本", svg.includes("开始") && svg.includes("结束"), svg);
}

/* ---------- 用户实际样本：V 模型 LR + subgraph + 虚线闭环 ---------- */
{
  const src = [
    "flowchart LR",
    "    subgraph LEFT[\"V 左半（设计分解）\"]",
    "        AFHA[\"AFHA<br/>飞机级功能危险评估\"]",
    "        PASA[\"PASA<br/>初步飞机安全性评估\"]",
    "        SFHA[\"SFHA<br/>系统级功能危险评估\"]",
    "        PSSA[\"PSSA<br/>初步系统安全性评估\"]",
    "    end",
    "    subgraph BOTTOM[\"V 底部（实现）\"]",
    "        IMPL[\"软硬件实现<br/>DO-178C / DO-254\"]",
    "    end",
    "    subgraph RIGHT[\"V 右半（验证综合）\"]",
    "        SSA[\"SSA<br/>系统安全性评估\"]",
    "        ASA[\"ASA<br/>飞机安全性评估\"]",
    "    end",
    "    AFHA --> PASA --> SFHA --> PSSA --> IMPL --> SSA --> ASA",
    "    PASSA -. FTA/RBD/Markov/MBSA.-> PSSA",
    "    SSA -. FTA 更新+验证+确认.-> SSA",
    "    PASA -. CCA: ZSA/PRA/CMA/CEA.-> PSSA",
    "    SSA -. CCA 闭环 .-> ASA",
    "    PSSA -. FDAL/IDAL 分配 .-> IMPL",
  ].join("\n");
  const svg = MM.render(src);
  t("V 模型渲染成功", !!svg, "render returned null");
  if (svg) {
    t("8 个节点（含原文档的 PASSA 拼写）", (svg.match(/class="me-node"/g) || []).length === 8, (svg.match(/me-node/g) || []).length);
    t("3 个 subgraph 框", (svg.match(/class="me-sgbox"/g) || []).length === 3, svg);
    t("11 条边（6 链 + 5 虚线）", (svg.match(/class="me-edge/g) || []).length === 11, (svg.match(/me-edge/g) || []).length);
    t("虚线边存在", svg.includes("me-dot"), svg);
    t("边标签渲染", svg.includes("FTA/RBD/Markov/MBSA") && svg.includes("闭环"), svg);
    t("subgraph 标题", svg.includes("V 左半（设计分解）") && svg.includes("V 底部（实现）") && svg.includes("V 右半（验证综合）"), svg);
    t("br 换行成多行 tspan", svg.includes("<tspan"), svg);
    t("闭环边（回到自身/上游）仍绘制", (svg.match(/class="me-edge/g) || []).length === 11, svg);
    t("LR 方向：层沿 x 展开", svg.includes(`width="${svg.match(/width="(\d+)"/)[1]}"`), "");
  }
}

/* ---------- 形状与方向 ---------- */
{
  const svg = MM.render("flowchart LR\nA([起]) --> B{判断}\nB -- 是 --> C[做]\nB -- 否 --> D(算)");
  t("stadium/diamond/round/rect 全渲染", (svg.match(/class="me-node"/g) || []).length === 4, svg);
  t("diamond 是 polygon", svg.includes("<polygon"), svg);
  t("stadium 圆角", svg.includes('rx="' ), svg);
  t("带标签边", svg.includes("是") && svg.includes("否"), svg);
  const td = MM.render("flowchart TD\nA --> B");
  const lr = MM.render("flowchart LR\nA --> B");
  const tdW = Number(td.match(/width="(\d+)"/)[1]);
  const tdH = Number(td.match(/height="(\d+)"/)[1]);
  const lrW = Number(lr.match(/width="(\d+)"/)[1]);
  const lrH = Number(lr.match(/height="(\d+)"/)[1]);
  t("TD/LR 方向影响画布", tdH > tdW && lrW > lrH, `td ${tdW}x${tdH} lr ${lrW}x${lrH}`);
}

/* ---------- 注释 / 空行 / 环 ---------- */
{
  const svg = MM.render("flowchart TD\n%% 这是注释\nA --> B\n\nB --> A");
  t("注释被跳过", !svg.includes("这是注释"), svg);
  t("环形图仍渲染", (svg.match(/class="me-edge/g) || []).length === 2, svg);
}

/* ---------- 无法解析时返回 null（回退显示源码） ---------- */
{
  t("空输入 null", MM.render("") === null);
  t("纯注释 null", MM.render("%% nothing") === null);
  t("sequence null", MM.render("sequenceDiagram\nA->>B") === null);
}

/* ---------- markdown.js 集成：mermaid 块不再是代码块 ---------- */
{
  const html = MD.parse("```mermaid\nflowchart LR\nA --> B\n```\n\n```py\nx = 1\n```");
  t("mermaid 块生成容器", html.includes('class="mermaid-block"'), html);
  t("mermaid 源码隐藏保留", html.includes("mermaid-src") && html.includes("flowchart LR"), html);
  t("mermaid 不进代码高亮", !html.includes('data-lang="mermaid"') || !html.includes("tok-kw"), html);
  t("普通代码块不受影响", html.includes('data-lang="py"') && html.includes("<pre"), html);
  t("普通代码块有 Copy 按钮", html.includes("code-copy"), html);
  t("enhanceMermaid 已导出", typeof MD.enhanceMermaid === "function" && typeof MD.rerenderMermaid === "function");
}

console.log(`\nmermaid: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("ALL MERMAID TESTS PASSED");
