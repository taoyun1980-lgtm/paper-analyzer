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

    const extract = (tag: string) => {
      const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : '';
    };

    const title = extract('title').replace(/\n/g, ' ');
    const abstract = extract('summary').replace(/\n/g, ' ');
    const published = extract('published');

    // authors
    const authorMatches = [...xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)];
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

function buildPrompt(meta: PaperMeta, fullText: string, impact: ImpactData | null): string {
  const impactInfo = impact
    ? `\n- 被引用次数：${impact.citations}（其中高影响力引用 ${impact.influentialCitations} 次）\n- 研究领域：${impact.fieldsOfStudy.join(', ') || '未分类'}\n- 一句话摘要：${impact.tldr || '无'}`
    : '';

  const paperContent = fullText || meta.abstract || '（未获取到论文全文和摘要，请基于你对这篇论文的了解进行分析）';

  return `请对以下学术论文进行全面深度分析，全部用中文输出。如果论文内容部分缺失，请结合你训练数据中对该论文的了解来补充分析。

## 论文信息
- 标题：${meta.title}
- 作者：${meta.authors.join(', ')}
- 发表年份：${meta.year}
- 发表渠道：${meta.venue || '未知'}${impactInfo}

## 论文内容
${paperContent}

---

请严格按照以下结构输出分析报告：

## 一、论文概述
用 2-3 段通俗语言概括论文的核心问题、方法和结论。让非专业读者也能快速理解。

## 二、核心贡献与创新点
列出论文最重要的 3-5 个贡献，每个贡献用 1-2 句话解释其意义。

## 三、研究方法论
详细拆解论文的技术路线、模型架构或实验设计。用类比帮助理解复杂概念。

## 四、关键实验与结果
分析主要实验：基准数据集、对比方法、关键指标。结果是否有说服力？

## 五、技术细节深度拆解
选取 2-3 个最重要的技术点深入解读（如核心公式、算法流程、架构设计）。

## 六、局限性与不足
客观分析论文的局限、假设条件、潜在问题。

## 七、业界反响与实际应用
${impact?.citations ? `该论文已被引用 ${impact.citations} 次。` : ''}
基于你的知识，分析：
- 后续重要的跟进研究（列出具体论文/项目名称）
- 在工业界的实际应用场景
- 对整个研究领域的影响和推动

## 八、综合评价
给出 10 分制评分，从以下维度评价：
- 创新性（x/10）
- 技术深度（x/10）
- 实验充分性（x/10）
- 影响力（x/10）
- 总评（x/10）

最后给出一段整体评价，包括论文的历史定位和长远意义。`;
}

// ---- main handler ----

export async function POST(request: NextRequest) {
  const { input, apiKey } = await request.json();

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

        const prompt = buildPrompt(meta, fullText, impact);

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
            max_tokens: 8000,
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
