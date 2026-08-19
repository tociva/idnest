import { esc } from "./escape";
import { STYLES } from "./styles";

/** Wrap page body markup in a full HTML document with inlined styles. */
export function layout(opts: { title: string; body: string; bodyScript?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${esc(opts.title)}</title>
  <style>${STYLES}</style>
</head>
<body>
${opts.body}
${opts.bodyScript ? `<script>${opts.bodyScript}</script>` : ""}
</body>
</html>`;
}
