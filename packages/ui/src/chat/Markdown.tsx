import { memo, useEffect, useState, type ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProject } from "@fabdesk/client-core";
import { useProjectBlobUrl } from "../hooks/queries";
import { useUiStore } from "../stores/ui";
import { basename, cn, isImagePath, projectRelativePath } from "../util";
import { ProjectImage } from "./ProjectImage";
import { useCore } from "@fabdesk/client-core";

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
type ImgProps = ComponentProps<"img"> & { node?: unknown };

function ProjectFileLink({
  projectId,
  href,
  absolutePath,
  children,
  ...props
}: AnchorProps & { projectId: string; href: string; absolutePath: string }) {
  const { url } = useProjectBlobUrl(projectId, href);
  const { host } = useCore();
  const label = children || basename(href);
  return (
    <a
      {...props}
      href={url ?? "#"}
      target="_blank"
      rel="noreferrer"
      title={absolutePath}
      onClick={(event) => {
        if (host.openPath) {
          event.preventDefault();
          void host.openPath(absolutePath);
          return;
        }
        if (!url) event.preventDefault();
        props.onClick?.(event);
      }}
    >
      {label}
    </a>
  );
}

function linkBareFileUrls(text: string): string {
  return text.replace(/(^|[\s(])((?:file:\/\/)[^\s)<]+)(?=$|[\s).,;!?])/gm, (_match, prefix: string, url: string) => {
    const decoded = (() => {
      try {
        return decodeURIComponent(new URL(url).pathname).split("/").pop() || url;
      } catch {
        return url;
      }
    })();
    return `${prefix}[${decoded}](${url})`;
  });
}

function urlTransform(url: string): string {
  return url.startsWith("file://") ? url : defaultUrlTransform(url);
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId).data;
  const root = project?.path ?? null;
  const components: Components = {
    code(props: CodeProps) {
      const { className, children, node: _node, ...rest } = props;
      void _node;
      const match = /language-([\w-]+)/.exec(className ?? "");
      if (match?.[1]) {
        const code = String(children ?? "").replace(/\n$/, "");
        return <CodeBlock code={code} lang={match[1]} />;
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
      const { node: _node, href, children, ...rest } = props;
      void _node;
      const projectPath = typeof href === "string" ? projectRelativePath(href, root) : null;
      if (projectId && projectPath && root) {
        return (
          <ProjectFileLink {...rest} projectId={projectId} href={projectPath} absolutePath={`${root.replace(/\/+$/, "")}/${projectPath}`}>
            {children || basename(projectPath)}
          </ProjectFileLink>
        );
      }
      return <a {...rest} href={href} target="_blank" rel="noreferrer" />;
    },
    img(props: ImgProps) {
      const { node: _node, src, alt, className } = props;
      void _node;
      const projectPath = typeof src === "string" ? projectRelativePath(src, root) : null;
      if (projectId && projectPath && isImagePath(projectPath)) {
        return (
          <ProjectImage
            projectId={projectId}
            path={projectPath}
            {...(alt !== undefined ? { alt } : {})}
            {...(className !== undefined ? { className } : {})}
          />
        );
      }
      return <img src={src} {...(alt !== undefined ? { alt } : {})} {...(className !== undefined ? { className } : {})} />;
    },
  };
  return (
    <div className={cn("fd-prose break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {linkBareFileUrls(text)}
      </ReactMarkdown>
    </div>
  );
});
