# AI 论文 & 文章深度分析器

**在线访问：https://paper-analyzer-omega.vercel.app**

自动搜索获取论文/文章全文，进行深度拆解分析，中文输出。

## 功能

- 支持 arXiv ID、论文/文章链接、DOI 或标题搜索
- 支持学术论文、技术博客（Anthropic、OpenAI 等）、研究报告
- 自动获取全文（arXiv/ar5iv）、引用数据（Semantic Scholar）
- 互联网搜索（DuckDuckGo），找不到时用 AI 知识分析
- 3 种分析深度：快速概览 / 标准分析 / 深度拆解
- 4 种输出形式：分析报告 / 通俗解读 / 要点提炼 / 批判性评议
- Qwen AI 流式输出，实时显示分析过程

## 技术栈

Next.js 16 + React 19 + TypeScript + Tailwind CSS 4 + Qwen API (SSE Streaming)
