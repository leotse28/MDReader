# XSS 攻击向量测试

渲染后所有脚本都必须失效（净化检查）。

## 1. 脚本标签（块级 HTML）

<script>alert(1)</script>

## 2. 事件属性

<img src=x onerror="alert(2)">

<div onclick="alert(3)">点击我</div>

## 3. 危险协议

[js](javascript:alert(4))

[img-js](![x](javascript:alert(5)))

[vbs](vbscript:msgbox(6))

[data-html](data:text/html;base64,PHNjcmlwdD5hbGVydCg3KTwvc2NyaXB0Pg==)

## 4. iframe / object / embed / form

<iframe src="https://evil.example"></iframe>

<object data="x"></object>

<embed src="x">

<form action="x"><input></form>

## 5. style 表达式（旧 IE）

<div style="width: expression(alert(8))">x</div>

## 6. 自动链接

http://normal.example 应该可以打开

## 7. 内联 HTML 转义预期

段内 <b>加粗</b> 与 <br> 会显示为字面文本（安全优先设计）。

## 预期

- 无弹窗、无外域加载
- 危险元素被剥除或转义
- 普通内容正常渲染
