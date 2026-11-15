"""Render root README.md into a standalone static HTML page for GitHub Pages."""

from __future__ import annotations

import os
import re
import subprocess
import urllib.parse
from pathlib import Path

_UTF8 = "utf-8"
_CSS_URL = "https://cdn.jsdelivr.net/npm/github-markdown-css@5.9.0/github-markdown.min.css"

_HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tasknest</title>
  <link rel="stylesheet" href="{css_url}">
  <style>
    body {{ margin: 0; }}
    @media (prefers-color-scheme: dark) {{ body {{ background: #0d1117; }} }}
    .markdown-body {{
      box-sizing: border-box;
      min-width: 200px;
      max-width: 980px;
      margin: 0 auto;
      padding: 45px;
    }}
    @media (max-width: 767px) {{ .markdown-body {{ padding: 15px; }} }}
  </style>
</head>
<body>
  <article class="markdown-body">
{body}
  </article>
</body>
</html>
"""


def _render_gfm(readme_path: Path) -> str:
    script = (
        "const md = await Bun.file(Bun.argv[1]).text();"
        "process.stdout.write(Bun.markdown.html(md, {"
        "tables: true, strikethrough: true, tasklists: true, autolinks: true"
        "}));"
    )
    return subprocess.check_output(["bun", "-e", script, str(readme_path)]).decode(_UTF8)


def _rewrite_relative_links(html_body: str, root: Path, repo: str, ref: str) -> str:
    def rewrite(match: re.Match[str]) -> str:
        href = match.group(1)
        if href.startswith(("http://", "https://", "mailto:", "#", "/")):
            return match.group(0)
        path_part, _, frag = href.partition("#")
        rel = urllib.parse.unquote(path_part)
        kind = "tree" if href.endswith("/") or (root / rel).is_dir() else "blob"
        target = f"https://github.com/{repo}/{kind}/{ref}/{path_part}"
        if frag:
            target = f"{target}#{frag}"
        return f'href="{target}"'

    return re.sub(r'href="([^"]+)"', rewrite, html_body)


def render_pages(
    root: Path,
    out_dir: Path | None = None,
    repo: str | None = None,
    ref: str | None = None,
) -> bool:
    """Render root README.md into dist/index.html and dist/.nojekyll."""
    resolved_repo = repo or os.environ.get("GITHUB_REPOSITORY") or "Archont561/tasknest"
    resolved_ref = ref or os.environ.get("GITHUB_REF_NAME") or "main"
    target_dir = out_dir or (root / "dist")

    rendered = _render_gfm(root / "README.md")
    body = _rewrite_relative_links(rendered, root, resolved_repo, resolved_ref)

    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / ".nojekyll").write_text("", encoding=_UTF8)
    (target_dir / "index.html").write_text(
        _HTML_TEMPLATE.format(css_url=_CSS_URL, body=body),
        encoding=_UTF8,
    )
    print(f"WROTE {target_dir / 'index.html'}")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if render_pages(Path(__file__).resolve().parent.parent) else 1)
