import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 论文深度分析器",
  description: "输入任意论文，自动获取全文并进行深度拆解分析",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
