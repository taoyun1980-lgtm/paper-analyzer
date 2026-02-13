import { NextRequest } from 'next/server';

export const maxDuration = 120; // allow long-running analysis

// ---- helpers ----

function send(controller: ReadableStreamDefaultController, encoder: TextEncoder, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function parseInput(raw: string): { type: 'arxiv' | 'doi' | 'title'; id: string } {
  const s = raw.trim();
  // arXiv URL or ID
  const arxiv = s.match(/(?:arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (arxiv) return { type: 'arxiv', id: arxiv[1] };
  // DOI
  const doi = s.match(/(10\.\d{4,}\/\S+)/);
  if (doi) return { type: 'doi', id: doi[1] };
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

// ---- search by title via Semantic Scholar ----

async function searchByTitle(title: string): Promise<PaperMeta | null> {
  try {
    const fields = 'title,authors,abstract,year,venue,externalIds,url';
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${fields}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const paper = data.data?.[0];
    if (!paper) return null;

    return {
      title: paper.title,
      authors: (paper.authors || []).map((a: { name: string }) => a.name),
      abstract: paper.abstract || '',
      year: String(paper.year || ''),
      venue: paper.venue || '',
      arxivId: paper.externalIds?.ArXiv,
      url: paper.url,
    };
  } catch {
    return null;
  }
}

// ---- analysis prompt ----

const SYSTEM_PROMPT = `你是一位资深学术论文分析专家，拥有深厚的跨学科知识。请用通俗易懂但专业的中文对论文进行深度分析。输出使用 Markdown 格式，层次清晰、内容详实。`;

function buildPrompt(meta: PaperMeta, fullText: string, impact: ImpactData | null): string {
  const impactInfo = impact
    ? `\n- 被引用次数：${impact.citations}（其中高影响力引用 ${impact.influentialCitations} 次）\n- 研究领域：${impact.fieldsOfStudy.join(', ') || '未分类'}\n- 一句话摘要：${impact.tldr || '无'}`
    : '';

  const paperContent = fullText || meta.abstract;

  return `请对以下学术论文进行全面深度分析，全部用中文输出。

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

        // 2. fetch metadata
        let meta: PaperMeta | null = null;
        let fullText = '';

        if (parsed.type === 'arxiv') {
          emit('status', { message: `正在从 arXiv 获取论文 ${parsed.id}...` });
          meta = await fetchArxiv(parsed.id);
        }

        if (!meta && (parsed.type === 'title' || parsed.type === 'doi')) {
          emit('status', { message: '正在搜索论文...' });
          meta = await searchByTitle(parsed.id);
        }

        if (!meta) {
          emit('error', { message: '未找到论文。请检查输入，支持 arXiv ID（如 1706.03762）、arXiv 链接或论文英文标题。' });
          controller.close();
          return;
        }

        emit('metadata', meta);

        // 3. full text
        if (meta.arxivId) {
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
