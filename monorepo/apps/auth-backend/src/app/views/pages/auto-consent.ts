import { esc } from "../escape";
import { layout } from "../layout";

export type AutoConsentReason =
  | "same_verified_email"
  | "trusted_first_party"
  | "remembered_authorization"
  | "verified_email_subject";

export interface AutoConsentRedirectViewModel {
  clientDisplayName: string;
  productName: string;
  redirectTo: string;
  reason: AutoConsentReason;
}

function reasonText(reason: AutoConsentReason, clientDisplayName: string): string {
  switch (reason) {
    case "same_verified_email":
      return `This was approved automatically because the identity provider returned the same verified email address as the existing account. ${clientDisplayName} uses verified email as the account identity, so no separate account-link prompt is required.`;
    case "trusted_first_party":
      return `${clientDisplayName} is configured as a trusted first-party application. The requested access is approved automatically by Idnest policy.`;
    case "remembered_authorization":
      return `This authorization was already approved for this account and application, so the authorization server allowed the consent prompt to be skipped.`;
    case "verified_email_subject":
      return `This request already carries a verified email identity and this application is configured for automatic consent.`;
  }
}

export function renderAutoConsentRedirect(vm: AutoConsentRedirectViewModel): string {
  const clientDisplayName = vm.clientDisplayName.trim() || "the application";
  const productName = vm.productName.trim() || "Idnest";
  const reason = reasonText(vm.reason, clientDisplayName);
  const headExtra = `<meta http-equiv="refresh" content="1;url=${esc(vm.redirectTo)}" />`;
  const body = `<div class="page-center">
  <main class="card">
    <header class="card-header">
      <div class="idnest-logo" aria-hidden="true">
        <span class="idnest-logo__mark"><span>✓</span></span>
        <span class="idnest-logo__text">
          <strong>${esc(productName)}</strong>
          <span>Secure sign-in</span>
        </span>
      </div>
    </header>
    <div class="alert alert-success">
      <strong class="hint-title">Access approved automatically</strong>
      <p class="hint-body">${esc(reason)}</p>
    </div>
    <p class="settings-hint">Continuing to ${esc(clientDisplayName)}…</p>
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
