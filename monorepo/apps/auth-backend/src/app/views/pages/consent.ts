import type { HydraClientTrustTier, PublicAuthRecovery } from "@idnest/shared-types";
import { esc } from "../escape";
import { IDNEST_LOGO } from "../icons";
import { layout } from "../layout";

export interface ConsentPermission {
  scope: string;
  label: string;
  description: string;
  caution?: boolean;
}

export interface ConsentViewModel {
  clientName: string;
  clientDomain?: string;
  logoUri?: string;
  policyUri?: string;
  tosUri?: string;
  email: string;
  trustTier: HydraClientTrustTier;
  permissions: ConsentPermission[];
  acceptToken: string;
  rejectToken: string;
  consentChallenge: string;
  reason?: string;
}

const trustLabel = (tier: HydraClientTrustTier): string =>
  tier === "first_party" ? "Idnest verified" : tier === "partner" ? "Partner app" : "Third-party app";

export function permissionForScope(scope: string): ConsentPermission {
  switch (scope) {
    case "openid":
      return { scope, label: "Sign you in", description: "Confirm your account identity." };
    case "profile":
      return { scope, label: "View your profile", description: "Read your name and basic profile details." };
    case "email":
      return { scope, label: "View your email", description: "Read your email address and verification status." };
    case "offline_access":
      return {
        scope,
        label: "Keep me signed in on this device",
        description: "Use refresh access so you do not need to sign in repeatedly.",
        caution: true,
      };
    default:
      return { scope, label: scope, description: "This app requested a custom permission.", caution: true };
  }
}

function hostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function legalDialog(id: string, title: string, uri: string | undefined): string {
  if (!uri) return "";
  return `<dialog class="legal-dialog" id="${esc(id)}" aria-label="${esc(title)}">
    <div class="dialog-panel">
      <header class="dialog-header">
        <h2>${esc(title)}</h2>
        <form method="dialog">
          <button class="dialog-close" type="submit" aria-label="Close ${esc(title)}">&times;</button>
        </form>
      </header>
      <iframe class="dialog-frame" src="${esc(uri)}" title="${esc(title)}"></iframe>
    </div>
  </dialog>`;
}

const dialogScript = /* js */ `
document.querySelectorAll("[data-dialog-target]").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    const dialog = document.getElementById(trigger.getAttribute("data-dialog-target"));
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
  });
});
document.querySelectorAll("dialog.legal-dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});
`;

export function renderConsent(vm: ConsentViewModel): string {
  const logo = vm.logoUri
    ? `<img class="app-logo" src="${esc(vm.logoUri)}" alt="" />`
    : `<div class="app-logo-fallback">${esc(vm.clientName.slice(0, 1).toUpperCase())}</div>`;
  const permissions = vm.permissions
    .map(
      (p) => `<li class="permission-row${p.caution ? " permission-caution" : ""}">
        <div>
          <strong>${esc(p.label)}</strong>
          <p>${esc(p.description)}</p>
        </div>
        <code>${esc(p.scope)}</code>
      </li>`,
    )
    .join("");
  const policyLinks = [
    vm.policyUri ? `<button type="button" class="link" data-dialog-target="privacy-dialog">Privacy Policy</button>` : "",
    vm.tosUri ? `<button type="button" class="link" data-dialog-target="terms-dialog">Terms</button>` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const dialogs = `${legalDialog("privacy-dialog", "Privacy Policy", vm.policyUri)}${legalDialog("terms-dialog", "Terms", vm.tosUri)}`;
  const reason = vm.reason ? `<div class="alert alert-warning">${esc(vm.reason)}</div>` : "";

  const body = `<div class="page-center">
  <main class="card card-consent">
    <div class="card-header">
      ${IDNEST_LOGO}
      <p class="brand-tagline">Review access</p>
    </div>

    ${reason}

    <section class="app-summary">
      ${logo}
      <div>
        <h1>${esc(vm.clientName)}</h1>
        <p>${esc(vm.clientDomain ?? hostOf(vm.policyUri) ?? "OAuth client")}</p>
        <span class="trust-pill">${esc(trustLabel(vm.trustTier))}</span>
      </div>
    </section>

    <div class="account-box">
      <span>Signed in as</span>
      <strong>${esc(vm.email || "Unknown account")}</strong>
    </div>

    <h2 class="section-title">This app wants to</h2>
    <ul class="permission-list">${permissions}</ul>

    <form method="post" action="/consent/accept" class="consent-actions">
      <input type="hidden" name="consent_challenge" value="${esc(vm.consentChallenge)}" />
      <input type="hidden" name="token" value="${esc(vm.acceptToken)}" />
      <button class="btn btn-primary" type="submit">Allow access</button>
    </form>
    <form method="post" action="/consent/reject" class="consent-actions">
      <input type="hidden" name="consent_challenge" value="${esc(vm.consentChallenge)}" />
      <input type="hidden" name="token" value="${esc(vm.rejectToken)}" />
      <button class="btn btn-outline" type="submit">Deny</button>
    </form>

    ${policyLinks ? `<p class="terms-text">${policyLinks}</p>` : ""}
  </main>
</div>
${dialogs}`;

  return layout({ title: `Authorize ${vm.clientName} · Idnest`, body, bodyScript: dialogScript });
}

export function renderAccessDenied(vm: {
  clientName: string;
  email: string;
  reason: string;
  switchAccountUrl?: string;
  recovery?: PublicAuthRecovery;
}): string {
  const switchAccountAction = vm.switchAccountUrl
    ? `<div class="consent-actions">
      <a class="btn btn-primary" href="${esc(vm.switchAccountUrl)}">Use a different account</a>
    </div>`
    : "";
  const retryAction =
    vm.recovery?.kind === "application_home"
      ? `<div class="consent-actions">
      <a class="btn btn-outline" href="${esc(vm.recovery.homeUrl)}">Try again</a>
    </div>`
      : "";
  const body = `<div class="page-center">
  <main class="card card-error">
    <div class="card-header">
      ${IDNEST_LOGO}
      <p class="brand-tagline">Access denied</p>
    </div>
    <div class="alert alert-error">${esc(vm.reason)}</div>
    <p class="hint-body">
      ${esc(vm.clientName)} is not enabled for ${esc(vm.email || "this account")}. Contact an administrator to grant access.
    </p>
    ${switchAccountAction}
    ${retryAction}
  </main>
</div>`;
  return layout({ title: "Access denied · Idnest", body });
}
