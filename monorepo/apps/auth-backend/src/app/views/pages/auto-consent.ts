import { esc } from "../escape";
import { layout } from "../layout";

export interface AutoConsentRedirectViewModel {
  clientDisplayName: string;
  productName: string;
  redirectTo: string;
}

export function renderAutoConsentRedirect(vm: AutoConsentRedirectViewModel): string {
  const clientDisplayName = vm.clientDisplayName.trim() || "the application";
  const productName = vm.productName.trim() || "Idnest";
  const brandInitial = productName.charAt(0).toUpperCase() || "I";
  const headExtra = `<meta http-equiv="refresh" content="1;url=${esc(vm.redirectTo)}" />`;
  const body = `<div class="page-center">
  <main class="card">
    <header class="card-header">
      <div class="idnest-logo" aria-hidden="true">
        <span class="idnest-logo__mark"><span>${esc(brandInitial)}</span></span>
        <span class="idnest-logo__text">
          <strong>${esc(productName)}</strong>
          <span>Secure sign-in</span>
        </span>
      </div>
    </header>
    <div class="auto-consent-status" role="status" aria-live="polite">
      <span class="auto-consent-spinner" aria-hidden="true"></span>
      <h1 class="auto-consent-title">Completing sign-in</h1>
      <p class="settings-hint">Taking you to ${esc(clientDisplayName)}…</p>
      <div class="auto-consent-progress" role="progressbar" aria-label="Continuing sign-in"></div>
    </div>
    <p class="settings-hint">
      If you are not redirected automatically,
      <a href="${esc(vm.redirectTo)}">continue to ${esc(clientDisplayName)}</a>.
    </p>
  </main>
</div>`;

  return layout({
    title: `Continuing to ${clientDisplayName} · ${productName}`,
    headExtra,
    body,
  });
}
