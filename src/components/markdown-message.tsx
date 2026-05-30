import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  content: string;
  className?: string;
}

export function MarkdownMessage({ content, className }: MarkdownMessageProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
          em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="text-zinc-100">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-400 underline underline-offset-2 hover:text-violet-300"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs text-violet-200">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg bg-zinc-800/80 p-3 text-xs">{children}</pre>
          ),
          h1: ({ children }) => <h1 className="mb-2 text-base font-bold text-white">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 text-sm font-bold text-white">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 text-sm font-semibold text-white">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-violet-500/40 pl-3 text-zinc-300">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-white/10" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
