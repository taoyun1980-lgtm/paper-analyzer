import { NextRequest } from 'next/server';
import { execSync } from 'child_process';

export const maxDuration = 120; // allow long-running analysis

// ---- helpers ----

function send(controller: ReadableStreamDefaultController, encoder: TextEncoder, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function parseInput(raw: string): { type: 'arxiv' | 'doi' | 'url' | 'title'; id: string } {
  const s = raw.trim();
  // arXiv URL or ID
  const arxiv = s.match(/(?:arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (arxiv) return { type: 'arxiv', id: arxiv[1] };
  // DOI
  const doi = s.match(/(10\.\d{4,}\/\S+)/);
  if (doi) return { type: 'doi', id: doi[1] };
  // generic URL (blog posts, papers on other sites)
  if (s.startsWith('http://') || s.startsWith('https://')) return { type: 'url', id: s };
  // treat as title
  return { type: 'title', id: s };
}

// ---- arXiv ----

interface PaperMeta {
  title: string;
  authors: string[];
  abstract: string;
  year: string;
  venue: string;
  arxivId?: string;
  url?: string;
}

async function fetchArxiv(id: string): Promise<PaperMeta | null> {
  try {
    const res = await fetch(`https://export.arxiv.org/api/query?id_list=${id}`);
    if (!res.ok) return null;
    const xml = await res.text();

    // extract from <entry> block to avoid matching feed-level tags
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) return null;
    const entry = entryMatch[1];

    const extract = (tag: string) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : '';
    };

    const title = extract('title').replace(/\n/g, ' ').replace(/\s+/g, ' ');
    const abstract = extract('summary').replace(/\n/g, ' ').replace(/\s+/g, ' ');
    const published = extract('published');

    // authors
    const authorMatches = [...entry.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)];
    const authors = authorMatches.map(m => m[1].trim());

    if (!title || title === 'Error') return null;

    return {
      title,
      authors,
      abstract,
      year: published ? published.slice(0, 4) : '',
      venue: 'arXiv',
      arxivId: id,
      url: `https://arxiv.org/abs/${id}`,
    };
  } catch {
    return null;
  }
}

// ---- arXiv search by title ----

async function searchArxiv(query: string): Promise<PaperMeta | null> {
  try {
    // try exact title match first, then broad search
    for (const q of [
      `ti:"${query}"`,
      `all:${query}`,
    ]) {
      const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&max_results=3&sortBy=relevance`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const xml = await res.text();

      // parse all entries
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
      if (entries.length === 0) continue;

      // pick the best match with similarity check
      let bestResult: PaperMeta | null = null;
      let bestScore = 0;

      for (const entry of entries) {
        const block = entry[1];
        const extractField = (tag: string) => {
          const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
          return m ? m[1].trim().replace(/\s+/g, ' ') : '';
        };

        const title = extractField('title');
        if (!title || title === 'Error') continue;

        const score = titleSimilarity(query, title);
        if (score <= bestScore) continue;

        const abstract = extractField('summary');
        const published = extractField('published');

        const idMatch = block.match(/<id>https?:\/\/arxiv\.org\/abs\/([\d.]+(?:v\d+)?)<\/id>/);
        const arxivId = idMatch ? idMatch[1] : '';

        const authorMatches = [...block.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)];
        const authors = authorMatches.map(m => m[1].trim());

        bestScore = score;
        bestResult = {
          title,
          authors,
          abstract,
          year: published ? published.slice(0, 4) : '',
          venue: 'arXiv',
          arxivId,
          url: arxivId ? `https://arxiv.org/abs/${arxivId}` : '',
        };
      }

      if (bestResult && bestScore >= 0.4) return bestResult;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- web search via DuckDuckGo (for blog posts, articles, tech reports) ----

async function webSearch(query: string): Promise<{ title: string; url: string }[]> {
  try {
    // DuckDuckGo blocks Node.js fetch but allows curl, so use child_process
    const encoded = encodeURIComponent(query);
    const html = execSync(
      `curl -s -X POST "https://html.duckduckgo.com/html/" -d "q=${encoded}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" --max-time 10`,
      { timeout: 12000, encoding: 'utf-8' }
    );

    const results: { title: string; url: string }[] = [];

    // DuckDuckGo HTML results: <a class="result__a" href="URL">Title</a>
    const linkRegex = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
      let url = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').replace(/&#\w+;/g, '').trim();

      // handle uddg redirect wrapper if present
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);

      if (url.startsWith('http') && !url.includes('duckduckgo.com')) {
        results.push({ title, url });
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ---- fetch web page as text (for blog posts, non-arXiv papers) ----

async function fetchWebPage(pageUrl: string): Promise<{ title: string; text: string } | null> {
  try {
    const res = await fetch(pageUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperAnalyzer/1.0)' },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';

    // extract main content
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > 50000) text = text.slice(0, 50000) + '\n[... 内容已截断 ...]';
    return { title, text };
  } catch {
    return null;
  }
}

// ---- ar5iv full text ----

async function fetchFullText(arxivId: string): Promise<string> {
  try {
    const res = await fetch(`https://ar5iv.labs.arxiv.org/html/${arxivId}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const html = await res.text();

    // extract main content, strip tags
    let content = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // limit to ~50K chars to stay within model context
    if (content.length > 50000) content = content.slice(0, 50000) + '\n[... 论文后续内容已截断 ...]';
    return content;
  } catch {
    return '';
  }
}

// ---- Semantic Scholar ----

interface ImpactData {
  citations: number;
  influentialCitations: number;
  venue: string;
  year: number;
  fieldsOfStudy: string[];
  tldr?: string;
}

async function fetchImpact(title: string, arxivId?: string): Promise<ImpactData | null> {
  try {
    const fields = 'citationCount,influentialCitationCount,venue,year,fieldsOfStudy,tldr';
    let url: string;
    if (arxivId) {
      url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=${fields}`;
    } else {
      url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${fields}`;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();

    const paper = data.data ? data.data[0] : data;
    if (!paper) return null;

    return {
      citations: paper.citationCount ?? 0,
      influentialCitations: paper.influentialCitationCount ?? 0,
      venue: paper.venue || '',
      year: paper.year ?? 0,
      fieldsOfStudy: paper.fieldsOfStudy || [],
      tldr: paper.tldr?.text,
    };
  } catch {
    return null;
  }
}

// ---- title similarity check ----

function titleSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const wordsA = new Set(normalize(a));
  const wordsB = new Set(normalize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ---- search by title via Semantic Scholar ----

async function searchByTitle(title: string): Promise<PaperMeta | null> {
  try {
    const fields = 'title,authors,abstract,year,venue,externalIds,url';
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=5&fields=${fields}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const papers = data.data || [];

    // find best matching paper (similarity > 0.4)
    let bestPaper = null;
    let bestScore = 0;
    for (const paper of papers) {
      const score = titleSimilarity(title, paper.title || '');
      if (score > bestScore) {
        bestScore = score;
        bestPaper = paper;
      }
    }

    if (!bestPaper || bestScore < 0.4) return null;

    return {
      title: bestPaper.title,
      authors: (bestPaper.authors || []).map((a: { name: string }) => a.name),
      abstract: bestPaper.abstract || '',
      year: String(bestPaper.year || ''),
      venue: bestPaper.venue || '',
      arxivId: bestPaper.externalIds?.ArXiv,
      url: bestPaper.url,
    };
  } catch {
    return null;
  }
}

// ---- analysis prompt ----

const SYSTEM_PROMPT = `你是一位资深的技术文章和学术论文分析专家，拥有深厚的跨学科知识。请用通俗易懂但专业的中文进行深度分析。输出使用 Markdown 格式，层次清晰、内容详实。

你可以分析以下类型的内容：
- 学术论文（arXiv、期刊、会议论文）
- 技术博客文章（如 Anthropic、OpenAI、Google、Meta 等公司的技术博客）
- 技术报告和白皮书
- 研究笔记和技术文档

重要：如果提供的内容不完整或只有标题，请充分利用你训练数据中的知识来分析。你大概率在训练过程中已经学习过相关内容。即使全文未提供，也请尽力给出详尽的分析。如果确实不了解，请如实说明。

对于非学术论文（如博客文章），请灵活调整分析框架，不必严格遵循学术论文的评分体系，而是侧重于内容价值、技术深度和实践意义。`;

function buildPrompt(
  meta: PaperMeta,
  fullText: string,
  impact: ImpactData | null,
  detailLevel: string,
  outputFormat: string,
): string {
  const impactInfo = impact
    ? `\n- 被引用次数：${impact.citations}（其中高影响力引用 ${impact.influentialCitations} 次）\n- 研究领域：${impact.fieldsOfStudy.join(', ') || '未分类'}\n- 一句话摘要：${impact.tldr || '无'}`
    : '';

  const paperContent = fullText || meta.abstract || '（未获取到论文全文和摘要，请基于你对这篇论文的了解进行分析）';

  const header = `请对以下内容进行分析，全部用中文输出。如果内容部分缺失，请结合你训练数据中的了解来补充。

## 文章信息
- 标题：${meta.title}
- 作者：${meta.authors.join(', ') || '未知'}
- 发表年份：${meta.year || '未知'}
- 来源：${meta.venue || '未知'}${impactInfo}

## 文章内容
${paperContent}

---

`;

  // detail level instructions
  const detailInstructions: Record<string, string> = {
    quick: '请用简洁精炼的方式输出，总字数控制在 800 字以内。重点突出核心要点，不需要展开太多细节。',
    standard: '请用适中的篇幅输出，总字数约 2000-3000 字。既要有结构，也要有足够的解释和分析。',
    deep: '请用极其详细的方式输出，不限字数（建议 4000-8000 字）。每个部分都要深入展开，包含技术细节、公式解读、类比说明等。对复杂概念要用多种方式解释。',
  };

  // output format templates
  const formatTemplates: Record<string, string> = {
    report: `请按照以下结构输出分析报告：

## 一、概述
用通俗语言概括核心问题、方法和结论。

## 二、核心贡献与创新点
列出最重要的贡献，每个贡献解释其意义。

## 三、方法论与技术路线
拆解技术路线、模型架构或实验设计。用类比帮助理解。

## 四、关键实验与结果
分析实验设计、对比方法、关键指标和结果说服力。

## 五、技术细节拆解
选取最重要的技术点深入解读。

## 六、局限性与不足
客观分析局限、假设条件、潜在问题。

## 七、业界反响与应用
${impact?.citations ? `该文已被引用 ${impact.citations} 次。` : ''}分析后续研究、工业应用和领域影响。

## 八、综合评价
给出 10 分制评分（创新性、技术深度、实验充分性、影响力、总评），以及一段整体评价。`,

    explain: `请用轻松通俗的语言来解读，像给一个聪明但非本领域的朋友讲解一样。要求：

## 这篇文章讲了什么？
用最简单的话概括，避免术语。如果必须用专业词汇，请立刻用括号解释。

## 它为什么重要？
放在大背景下解释这件事的意义，让读者产生"哦原来如此"的感觉。

## 核心思路是什么？
用生活中的类比来解释核心技术方法。比如"就像……一样"。

## 具体是怎么做的？
分步骤讲解，每一步都用浅显的语言。

## 效果怎么样？
用具体数字或比较来说明效果，不要只说"显著提升"。

## 有什么不足？
诚实地指出问题，以及未来可能的改进方向。

## 一句话总结
用一句话概括这篇文章的核心价值。`,

    keypoints: `请用精简的要点形式输出，要求干净利落、信息密度高：

## 一句话总结
> 用一句话概括全文核心

## 核心要点
用编号列表列出 5-8 个最重要的要点，每个要点 1-2 句话。

## 关键数据
列出文章中最重要的数字、指标和对比结果。

## 方法亮点
用 3-5 个要点概括技术方法的精华。

## 局限与争议
用 2-3 个要点指出不足。

## 实践启示
对从业者有什么具体的可行建议？列出 3-5 条。

## 相关推荐
推荐 3-5 篇相关的论文/文章/项目供进一步阅读。`,

    review: `请以同行评审专家的视角进行严谨的批判性评议：

## 论文/文章摘要
用 3-5 句话精确概括。

## 主要贡献
客观列出声称的贡献，并评估每个贡献的真实新颖性。

## 方法论评估
- 技术路线是否合理？有无逻辑漏洞？
- 假设条件是否过强？
- 与现有方法的对比是否公平充分？

## 实验评估
- 实验设计是否严谨？基准选择是否合适？
- 消融实验是否充分？
- 结果的统计显著性如何？
- 是否有选择性报告的嫌疑？

## 写作质量
评价文章的清晰度、逻辑结构和表达质量。

## 主要优点
列出 3-5 个突出的优点。

## 主要问题
列出 3-5 个需要改进或值得质疑的问题，按严重程度排序。

## 次要问题
列出一些不影响核心结论但值得注意的小问题。

## 评审建议
给出明确的建议：强烈推荐 / 推荐 / 弱推荐 / 弱拒绝 / 拒绝，并解释理由。

## 改进建议
具体说明如果作者要修改，最应该改进哪些方面。`,
  };

  const detail = detailInstructions[detailLevel] || detailInstructions.standard;
  const format = formatTemplates[outputFormat] || formatTemplates.report;

  return header + detail + '\n\n' + format;
}

// ---- main handler ----

export async function POST(request: NextRequest) {
  const { input, apiKey, detailLevel = 'standard', outputFormat = 'report' } = await request.json();

  if (!input || !apiKey) {
    return Response.json({ error: '请提供论文信息和 API Key' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: unknown) => send(controller, encoder, event, data);

      try {
        // 1. parse input
        emit('status', { message: '正在解析输入...' });
        const parsed = parseInput(input);

        // 2. fetch metadata - try multiple sources
        let meta: PaperMeta | null = null;
        let fullText = '';

        if (parsed.type === 'arxiv') {
          emit('status', { message: `正在从 arXiv 获取论文 ${parsed.id}...` });
          meta = await fetchArxiv(parsed.id);
        }

        if (parsed.type === 'url') {
          // direct URL - fetch web page content
          emit('status', { message: '正在获取网页内容...' });
          const page = await fetchWebPage(parsed.id);
          if (page && page.text.length > 200) {
            meta = {
              title: page.title || parsed.id,
              authors: [],
              abstract: page.text.slice(0, 1000),
              year: '',
              venue: new URL(parsed.id).hostname,
              url: parsed.id,
            };
            fullText = page.text;
          }
        }

        if (!meta && (parsed.type === 'title' || parsed.type === 'doi')) {
          // Strategy 1: Semantic Scholar (with relevance check)
          emit('status', { message: '正在 Semantic Scholar 搜索...' });
          meta = await searchByTitle(parsed.id);

          // Strategy 2: arXiv title search (with relevance check)
          if (!meta) {
            emit('status', { message: '正在 arXiv 搜索...' });
            meta = await searchArxiv(parsed.id);
          }

          // Strategy 3: Semantic Scholar match API (exact string match)
          if (!meta) {
            try {
              emit('status', { message: '正在尝试精确匹配...' });
              const matchRes = await fetch(
                `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(parsed.id)}&fields=title,authors,abstract,year,venue,externalIds,url`,
                { signal: AbortSignal.timeout(8000) }
              );
              if (matchRes.ok) {
                const matchData = await matchRes.json();
                const papers = matchData.data || [];
                for (const paper of papers) {
                  if (titleSimilarity(parsed.id, paper.title || '') >= 0.4) {
                    meta = {
                      title: paper.title,
                      authors: (paper.authors || []).map((a: { name: string }) => a.name),
                      abstract: paper.abstract || '',
                      year: String(paper.year || ''),
                      venue: paper.venue || '',
                      arxivId: paper.externalIds?.ArXiv,
                      url: paper.url,
                    };
                    break;
                  }
                }
              }
            } catch { /* continue */ }
          }

          // Strategy 4: Web search (for blog posts, tech articles, etc.)
          if (!meta) {
            emit('status', { message: '正在互联网上搜索文章...' });
            const searchResults = await webSearch(parsed.id);
            if (searchResults.length > 0) {
              // try fetching the top results until we get content
              for (const result of searchResults.slice(0, 3)) {
                emit('status', { message: `正在获取: ${result.title || result.url}` });
                const page = await fetchWebPage(result.url);
                if (page && page.text.length > 200) {
                  let hostname = '';
                  try { hostname = new URL(result.url).hostname; } catch {}
                  meta = {
                    title: page.title || result.title || parsed.id,
                    authors: [],
                    abstract: page.text.slice(0, 1000),
                    year: '',
                    venue: hostname,
                    url: result.url,
                  };
                  fullText = page.text;
                  break;
                }
              }
            }
          }

          // Strategy 5: if still not found, let AI analyze based on title alone
          if (!meta) {
            emit('status', { message: '未找到原文，将基于 AI 知识进行分析...' });
            meta = {
              title: parsed.id,
              authors: [],
              abstract: '',
              year: '',
              venue: '',
            };
          }
        }

        if (!meta) {
          emit('error', { message: '未能获取论文信息。请检查输入。支持：arXiv ID、arXiv/论文链接、DOI 或论文标题。' });
          controller.close();
          return;
        }

        emit('metadata', meta);

        // 3. full text
        if (!fullText && meta.arxivId) {
          emit('status', { message: '正在获取论文全文（ar5iv）...' });
          fullText = await fetchFullText(meta.arxivId);
          if (fullText) {
            emit('status', { message: `已获取全文（${Math.round(fullText.length / 1000)}K 字符）` });
          } else {
            emit('status', { message: '未获取到全文，将基于摘要进行分析' });
          }
        }

        // 4. impact
        emit('status', { message: '正在获取引用和影响力数据...' });
        const impact = await fetchImpact(meta.title, meta.arxivId);
        if (impact) emit('impact', impact);

        // 5. AI analysis (streaming)
        emit('status', { message: '正在进行深度分析（Qwen AI）...' });

        const prompt = buildPrompt(meta, fullText, impact, detailLevel, outputFormat);

        const qwenRes = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'qwen-plus',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
            stream: true,
            temperature: 0.3,
            max_tokens: detailLevel === 'quick' ? 2000 : detailLevel === 'deep' ? 16000 : 8000,
          }),
        });

        if (!qwenRes.ok) {
          const errText = await qwenRes.text().catch(() => '');
          emit('error', { message: `AI 分析请求失败 (${qwenRes.status}): ${errText.slice(0, 200)}` });
          controller.close();
          return;
        }

        // parse Qwen SSE
        const reader = qwenRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const content = j.choices?.[0]?.delta?.content;
              if (content) emit('chunk', { text: content });
            } catch { /* skip malformed */ }
          }
        }

        emit('done', {});
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '未知错误';
        emit('error', { message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
