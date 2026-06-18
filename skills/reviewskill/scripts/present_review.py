#!/usr/bin/env python3
"""Render a Markdown review report to HTML and optionally open it in a browser.

This script is intentionally dependency-free. It uses a small safe Markdown-ish
renderer suitable for review reports. Unsupported Markdown is shown as escaped
text rather than interpreted as HTML.
"""

from __future__ import annotations

import argparse
import html
import os
import re
import sys
import webbrowser
from pathlib import Path

CSS = """
:root {
  color-scheme: light dark;
  --bg: #f6f8fa;
  --fg: #1f2328;
  --muted: #656d76;
  --border: #d0d7de;
  --code-bg: #f0f3f6;
  --panel: #ffffff;
  --accent: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8b949e;
    --border: #30363d;
    --code-bg: #161b22;
    --panel: #010409;
    --accent: #58a6ff;
  }
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
main {
  box-sizing: border-box;
  max-width: 980px;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
  background: var(--panel);
  min-height: 100vh;
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.25;
  margin: 1.6em 0 0.6em;
}
h1 {
  margin-top: 0;
  padding-bottom: 0.35em;
  border-bottom: 1px solid var(--border);
}
p { margin: 0.65rem 0; }
pre, code {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
code {
  background: var(--code-bg);
  border-radius: 0.25rem;
  padding: 0.12rem 0.28rem;
}
pre {
  overflow: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1rem;
}
pre code {
  background: transparent;
  padding: 0;
  border-radius: 0;
}
blockquote {
  margin-left: 0;
  padding-left: 1rem;
  color: var(--muted);
  border-left: 0.25rem solid var(--border);
}
hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 2rem 0;
}
a { color: var(--accent); }
"""


def has_gui() -> bool:
    if sys.platform.startswith("linux"):
        return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    return True


def escape(value: str) -> str:
    return html.escape(value, quote=True)


def render_markdown(markdown: str) -> str:
    """Render a conservative Markdown subset to HTML.

    The renderer intentionally does not pass through raw HTML. It supports
    headings, fenced code blocks, bullets, task-list bullets, blockquotes, and
    horizontal rules. Everything else is escaped text in paragraphs.
    """
    out: list[str] = []
    code_fence: str | None = None
    code_lines: list[str] = []

    def fence_marker(value: str) -> str | None:
        match = re.match(r"^(`{3,}|~{3,})", value)
        return match.group(1) if match else None

    def flush_code() -> None:
        nonlocal code_lines
        out.append("<pre><code>" + "\n".join(escape(line) for line in code_lines) + "</code></pre>")
        code_lines = []

    for raw_line in markdown.splitlines():
        line = raw_line.rstrip("\n")
        stripped = line.strip()
        marker = fence_marker(stripped)

        if code_fence is not None:
            if marker and marker[0] == code_fence[0] and len(marker) >= len(code_fence):
                flush_code()
                code_fence = None
            else:
                code_lines.append(line)
            continue

        if marker:
            code_fence = marker
            code_lines = []
            continue

        if not stripped:
            out.append("")
            continue

        if stripped in {"---", "***", "___"}:
            out.append("<hr>")
            continue

        if line.startswith("# "):
            out.append(f"<h1>{escape(line[2:].strip())}</h1>")
        elif line.startswith("## "):
            out.append(f"<h2>{escape(line[3:].strip())}</h2>")
        elif line.startswith("### "):
            out.append(f"<h3>{escape(line[4:].strip())}</h3>")
        elif line.startswith("#### "):
            out.append(f"<h4>{escape(line[5:].strip())}</h4>")
        elif line.startswith("##### "):
            out.append(f"<h5>{escape(line[6:].strip())}</h5>")
        elif line.startswith("###### "):
            out.append(f"<h6>{escape(line[7:].strip())}</h6>")
        elif line.startswith("> "):
            out.append(f"<blockquote>{escape(line[2:].strip())}</blockquote>")
        elif line.startswith("- [ ] "):
            out.append(f"<p>☐ {escape(line[6:].strip())}</p>")
        elif line.lower().startswith("- [x] "):
            out.append(f"<p>☑ {escape(line[6:].strip())}</p>")
        elif line.startswith("- "):
            out.append(f"<p>• {escape(line[2:].strip())}</p>")
        elif line.startswith("* "):
            out.append(f"<p>• {escape(line[2:].strip())}</p>")
        else:
            out.append(f"<p>{escape(line)}</p>")

    if code_fence is not None:
        flush_code()

    return "\n".join(out)


def infer_title(markdown: str, fallback: str) -> str:
    for line in markdown.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            if title:
                return title
    return fallback


def default_html_path(markdown_path: Path) -> Path:
    return markdown_path.with_suffix(".html")


def build_html(markdown: str, title: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>{escape(title)}</title>
<style>{CSS}</style>
</head>
<body>
<main>
{render_markdown(markdown)}
</main>
</body>
</html>
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Render a Markdown review report to HTML and optionally open it in a browser.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("review_markdown", help="Path to the review Markdown file.")
    parser.add_argument("--html-path", help="Where to write the generated HTML file. Defaults to sibling .html file.")
    parser.add_argument("--no-open", action="store_true", help="Write HTML but do not open a browser.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    markdown_path = Path(args.review_markdown).expanduser().resolve()
    if not markdown_path.exists():
        print(f"present_review.py: error: review file not found: {markdown_path}", file=sys.stderr)
        return 2
    if not markdown_path.is_file():
        print(f"present_review.py: error: review path is not a file: {markdown_path}", file=sys.stderr)
        return 2

    html_path = Path(args.html_path).expanduser().resolve() if args.html_path else default_html_path(markdown_path)
    markdown = markdown_path.read_text(encoding="utf-8", errors="replace")
    title = infer_title(markdown, markdown_path.name)
    document = build_html(markdown, title)

    html_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(document, encoding="utf-8")
    print(f"HTML written: {html_path}")

    if args.no_open:
        return 0

    if not has_gui():
        print("No GUI detected; not opening browser.")
        return 0

    opened = webbrowser.open(html_path.as_uri(), new=1)
    if opened:
        print("Opened review in browser.")
    else:
        print("Could not open browser automatically; open the HTML file manually.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
