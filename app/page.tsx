'use client';

import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const DEFAULT_KEY = 'sk-50b85b34ff9f4b7190fac784e81091e4';

const EXAMPLES = [
  { label: 'Attention Is All You Need', id: '1706.03762' },
  { label: 'BERT', id: '1810.04805' },
  { label: 'ResNet', id: '1512.03385' },
  { label: 'GPT-2', id: '1904.09751' },
  { label: 'Diffusion Models', id: '2006.11239' },
  { label: 'LoRA', id: '2106.09685' },
];

interface PaperMeta {
  title: string;
  authors: string[];
  abstract: string;
  year: string;
  venue: string;
  arxivId?: string;
  url?: string;
}

interface ImpactData {
  citations: number;
  influentialCitations: number;
  venue: string;
  fieldsOfStudy: string[];
  tldr?: string;
}

export default function Home() {
  const [input, setInput] = useState('');
  const [apiKey, setApiKey] = useState(DEFAULT_KEY);
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [meta, setMeta] = useState<PaperMeta | null>(null);
  const [impact, setImpact] = useState<ImpactData | null>(null);
  const [analysis, setAnalysis] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  async function handleAnalyze(paperId?: string) {
    const query = paperId || input.trim();
    if (!query) return;
    if (paperId) setInput(paperId);

    // reset
    setIsLoading(true);
    setStatus('正在开始分析...');
    setMeta(null);
    setImpact(null);
    setAnalysis('');
    setError('');

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: query, apiKey }),
        signal: abort.signal,
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';

        for (const part of parts) {
          const lines = part.split('\n');
          let evt = '', data = '';
          for (const l of lines) {
            if (l.startsWith('event: ')) evt = l.slice(7);
            if (l.startsWith('data: ')) data = l.slice(6);
          }
          if (!evt || !data) continue;

          const parsed = JSON.parse(data);
          switch (evt) {
            case 'status': setStatus(parsed.message); break;
            case 'metadata':
              setMeta(parsed);
              setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
              break;
            case 'impact': setImpact(parsed); break;
            case 'chunk': setAnalysis(prev => prev + parsed.text); break;
            case 'error': setError(parsed.message); break;
            case 'done': setStatus('分析完成'); break;
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message || '网络错误');
      }
    } finally {
      setIsLoading(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setIsLoading(false);
    setStatus('已停止');
  }

  return (
    <div className="min-h-screen">
      {/* header */}
      <header className="bg-white border-b border-[var(--border)] sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <h1 className="text-2xl font-bold">AI 论文 & 文章深度分析器</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            输入 arXiv ID、论文/文章链接或标题，自动搜索获取全文并深度拆解分析，中文输出
          </p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* input section */}
        <div className="bg-white rounded-xl border border-[var(--border)] p-6 shadow-sm">
          <div className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !isLoading && handleAnalyze()}
              placeholder="输入 arXiv ID、论文/文章链接或标题（如 Attention Is All You Need）"
              className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30 focus:border-[var(--primary)]"
              disabled={isLoading}
            />
            {isLoading ? (
              <button onClick={handleStop} className="px-5 py-2.5 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors">
                停止
              </button>
            ) : (
              <button onClick={() => handleAnalyze()} className="px-5 py-2.5 rounded-lg text-sm font-medium bg-[var(--primary)] text-white hover:opacity-90 transition-colors disabled:opacity-50" disabled={!input.trim()}>
                分析论文
              </button>
            )}
          </div>

          {/* examples */}
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-xs text-[var(--muted-foreground)]">试试：</span>
            {EXAMPLES.map(ex => (
              <button
                key={ex.id}
                onClick={() => handleAnalyze(ex.id)}
                disabled={isLoading}
                className="text-xs px-2.5 py-1 rounded-full bg-[var(--muted)] hover:bg-blue-100 hover:text-[var(--primary)] transition-colors disabled:opacity-50"
              >
                {ex.label}
              </button>
            ))}
          </div>

          {/* api key toggle */}
          <div className="mt-3 pt-3 border-t border-[var(--border)]">
            <button onClick={() => setShowKey(!showKey)} className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
              {showKey ? '▼' : '▶'} API Key 设置
            </button>
            {showKey && (
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Qwen API Key"
                className="mt-2 w-full px-3 py-2 border border-[var(--border)] rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
              />
            )}
          </div>
        </div>

        {/* status */}
        {isLoading && (
          <div className="flex items-center gap-3 text-sm text-[var(--muted-foreground)]">
            <div className="loading-dots flex gap-1">
              <span className="w-2 h-2 rounded-full bg-[var(--primary)]" />
              <span className="w-2 h-2 rounded-full bg-[var(--primary)]" />
              <span className="w-2 h-2 rounded-full bg-[var(--primary)]" />
            </div>
            {status}
          </div>
        )}

        {/* error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        {/* results */}
        <div ref={resultRef}>
          {/* paper metadata */}
          {meta && (
            <div className="bg-white rounded-xl border border-[var(--border)] p-6 shadow-sm space-y-3">
              <h2 className="text-lg font-bold leading-tight">{meta.title}</h2>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--muted-foreground)]">
                <span>{meta.authors.slice(0, 5).join(', ')}{meta.authors.length > 5 ? ` 等 ${meta.authors.length} 人` : ''}</span>
                {meta.year && <span>{meta.year} 年</span>}
                {meta.venue && <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs">{meta.venue}</span>}
              </div>
              {/* impact metrics */}
              {impact && (
                <div className="flex flex-wrap gap-3 pt-2">
                  <div className="px-3 py-1.5 rounded-lg bg-green-50 border border-green-200">
                    <span className="text-xs text-green-700">引用次数</span>
                    <p className="text-lg font-bold text-green-800">{impact.citations.toLocaleString()}</p>
                  </div>
                  <div className="px-3 py-1.5 rounded-lg bg-purple-50 border border-purple-200">
                    <span className="text-xs text-purple-700">高影响力引用</span>
                    <p className="text-lg font-bold text-purple-800">{impact.influentialCitations.toLocaleString()}</p>
                  </div>
                  {impact.fieldsOfStudy.length > 0 && (
                    <div className="px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
                      <span className="text-xs text-amber-700">研究领域</span>
                      <p className="text-sm font-medium text-amber-800">{impact.fieldsOfStudy.join(', ')}</p>
                    </div>
                  )}
                </div>
              )}
              {/* abstract */}
              <details className="pt-2">
                <summary className="text-xs text-[var(--muted-foreground)] cursor-pointer hover:text-[var(--foreground)]">
                  查看原文摘要
                </summary>
                <p className="mt-2 text-sm text-[var(--muted-foreground)] leading-relaxed bg-[var(--muted)] rounded-lg p-3">
                  {meta.abstract}
                </p>
              </details>
              {meta.url && (
                <a href={meta.url} target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-[var(--primary)] hover:underline">
                  查看原文 →
                </a>
              )}
            </div>
          )}

          {/* analysis */}
          {analysis && (
            <div className="mt-6 bg-white rounded-xl border border-[var(--border)] p-6 shadow-sm">
              <h3 className="text-base font-bold mb-4 pb-2 border-b border-[var(--border)]">
                深度分析报告
              </h3>
              <div className="prose text-sm leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {analysis}
                </ReactMarkdown>
                {isLoading && <span className="inline-block w-2 h-4 bg-[var(--primary)] animate-pulse ml-0.5 align-text-bottom" />}
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        {!meta && !isLoading && !error && (
          <div className="text-center py-16 text-[var(--muted-foreground)]">
            <p className="text-4xl mb-4">📄</p>
            <p className="text-sm">输入论文信息开始分析</p>
            <p className="text-xs mt-2">支持 arXiv ID、论文/文章链接、DOI 或标题（学术论文、技术博客、研究报告均可）</p>
          </div>
        )}
      </main>
    </div>
  );
}
