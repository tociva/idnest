import { esc } from "../escape";
import { layout } from "../layout";

/**
 * 200 continue page after a same-origin Kratos form POST. Meta refresh plus a
 * link — no inline JS — so Chrome ends the form-action chain here.
 */
export function renderContinue(continueUrl: string): string {
  const href = esc(continueUrl);
  return layout({
    title: "Continue · Idnest",
    headExtra: `<meta http-equiv="refresh" content="${esc(`0;url=${continueUrl}`)}" />`,
    body: `<div class="page-center">
  <main class="card">
    <p class="brand-tagline">Continue to sign in</p>
    <p><a class="btn btn-primary" href="${href}">Continue</a></p>
  </main>
</div>`,
  });
}
