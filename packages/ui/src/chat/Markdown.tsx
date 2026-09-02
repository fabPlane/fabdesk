import { memo, useEffect, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../util";

type Shiki = typeof import("shiki");
let shikiPromise: Promise<Shiki> | null = null;
function loadShiki(): Promise<Shiki> {
  shikiPromise ??= import("shiki");
  return shikiPromise;
}

const cache = new Map<string, string>();

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const key = `${lang} ${code}`;
  const [html, setHtml] = useState<string | null>(() => cache.get(key) ?? null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    const cached = cache.get(key);
    if (cached !== undefined) {
      setHtml(cached);
      return;
    }
    // Debounce: streaming text re-renders too often to highlight every keystroke.
    const handle = setTimeout(() => {
      loadShiki()
        .then(async (shiki) => {
          const langs = shiki.bundledLanguages as Record<string, unknown>;
          const language = lang in langs ? lang : "text";
          const out = await shiki.codeToHtml(code, {
            lang: language,
            themes: { light: "github-light", dark: "github-dark" },
            defaultColor: false,
          });
          cache.set(key, out);
          if (alive) setHtml(out);
        })
        .catch(() => {
          if (alive) setHtml(null);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [key, code, lang]);
  return (
    <div className="group relative">
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="rounded bg-panel px-1.5 py-0.5 font-mono text-[10px] text-muted">{lang}</span>
        <button
          className="rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted hover:text-fg"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

type CodeProps = ComponentProps<"code"> & { node?: unknown };
type PreProps = ComponentProps<"pre"> & { node?: unknown };
type AnchorProps = ComponentProps<"a"> & { node?: unknown };

const components: Components = {
  code(props: CodeProps) {
    const { className, children, node: _node, ...rest } = props;
    void _node;
    const match = /language-([\w-]+)/.exec(className ?? "");
    if (match?.[1]) {
      const text = String(children ?? "").replace(/\n$/, "");
      return <CodeBlock code={text} lang={match[1]} />;
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre(props: PreProps) {
    // A fenced block with a language renders its own <pre> via CodeBlock; avoid nesting.
    const { children, node: _node, ...rest } = props;
    void _node;
    const child = Array.isArray(children) ? children[0] : children;
    const cls = (child as { props?: { className?: string } } | null)?.props?.className ?? "";
    if (/language-/.test(cls)) return <>{children}</>;
    return <pre {...rest}>{children}</pre>;
  },
  a(props: AnchorProps) {
    const { node: _node, ...rest } = props;
    void _node;
    return <a {...rest} target="_blank" rel="noreferrer" />;
  },
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("fd-prose break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
