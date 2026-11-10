# MD Reader 示例文档

这是一个**离线**、**便携**的 Markdown 阅读器。支持 `GFM` 的大部分语法。

## 文本格式

普通文字、**粗体**、*斜体*、***粗斜体***、~~删除线~~、`行内代码`、==高亮==。
链接：[OpenAI](https://openai.com "访问官网")，自动链接 https://example.com 。

## 列表

- 无序列表项一
- 无序列表项二
  - 嵌套项 A
  - 嵌套项 B
    - 更深一层

1. 有序列表
2. 第二项
3. 第三项

任务列表：

- [x] 已完成的任务
- [ ] 未完成的任务

## 引用

> 阅读使人充实，讨论使人机敏，笔记使人准确。
>
> —— 培根

## 代码

```python
def fibonacci(n: int) -> list[int]:
    """返回前 n 个斐波那契数"""
    seq = [0, 1]
    for _ in range(n - 2):
        seq.append(seq[-1] + seq[-2])
    return seq[:n]


print(fibonacci(10))
```

```javascript
const greet = (name) => `你好，${name}！`;
console.log(greet("MD Reader"));
```

## 表格

| 功能 | 状态 | 说明 |
| :--- | :---: | ---: |
| Markdown 渲染 | ✅ | 支持 GFM |
| 深色主题 | ✅ | Ctrl+D 切换 |
| 文件树 | ✅ | 打开文件夹 |
| 导出 PDF | ✅ | Ctrl+P |

## 分割线

---

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

脚注示例：这是一句话[^1]。

[^1]: 这是脚注的内容说明。
