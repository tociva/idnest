import { esc } from "../escape";
import { IDNEST_LOGO } from "../icons";
import { layout } from "../layout";
import type {
  FactorSettingsNode,
  FlowHiddenInput,
  FlowMessage,
  FlowSubmitButton,
} from "./flow-controls";
import { renderFlowMessages } from "./flow-messages";
import { renderOidcForm } from "./oidc-form";

export interface SettingsViewModel {
  /** Kratos settings action URL the form POSTs to (full-page, browser -> Kratos). */
  actionUrl: string;
  /** Hidden inputs from the Kratos flow, including csrf_token. */
  hiddenInputs: FlowHiddenInput[];
  /** OIDC link/unlink submit buttons from the Kratos settings flow. */
  providers: FlowSubmitButton[];
  /** TOTP / lookup-secret enrollment nodes. */
  factorNodes: FactorSettingsNode[];
  /** Optional allowlisted app URL to leave settings without making changes. */
  returnTo?: string | null;
  /** Link/unlink guidance and errors returned by Kratos. */
  messages?: FlowMessage[];
}

function renderFactorSection(
  actionUrl: string,
  hiddenInputs: FlowHiddenInput[],
  nodes: FactorSettingsNode[],
): string {
  if (!nodes.length) return "";

  const hidden = hiddenInputs
    .map((input) => `<input type="hidden" name="${esc(input.name)}" value="${esc(input.value)}" />`)
    .join("\n        ");

  const body = nodes
    .map((node) => {
      if (node.kind === "text") {
        return `<p class="settings-hint">${esc(node.text)}</p>`;
      }
      if (node.kind === "img") {
        return `<img class="totp-qr" src="${esc(node.src)}" alt="${esc(node.alt)}" width="200" height="200" />`;
      }
      if (node.kind === "input") {
        return `<label class="field">
          <span>${esc(node.label)}</span>
          <input type="${esc(node.inputType)}" name="${esc(node.name)}" value="${esc(node.value)}"${
            node.required ? " required" : ""
          }${node.disabled ? " disabled" : ""} autocomplete="one-time-code" />
        </label>`;
      }
      return `<button type="submit" name="${esc(node.name)}" value="${esc(node.value)}" class="btn btn-primary"${
        node.disabled ? " disabled" : ""
      }>${esc(node.label)}</button>`;
    })
    .join("\n        ");

  return `<section class="settings-section">
      <h2 class="settings-heading">Authenticator app</h2>
      <p class="settings-hint">Scan the QR code with your authenticator app, then enter a code to confirm.</p>
      <form method="POST" action="${esc(actionUrl)}" class="settings-factor-form">
        ${hidden}
        ${body}
      </form>
    </section>`;
}

export function renderSettings(vm: SettingsViewModel): string {
  const backLabel = vm.returnTo?.includes("/oauth2/login/complete")
    ? "Continue sign-in"
    : "Back to app";
  const backLink = vm.returnTo
    ? `<div class="card-footer"><a href="${esc(vm.returnTo)}" class="link">${esc(backLabel)}</a></div>`
    : "";

  const factorSection = renderFactorSection(vm.actionUrl, vm.hiddenInputs, vm.factorNodes);
  const oidcSection = `<section class="settings-section">
      <h2 class="settings-heading">Linked accounts</h2>
      ${renderOidcForm({
        actionUrl: vm.actionUrl,
        hiddenInputs: vm.hiddenInputs,
        buttons: vm.providers,
        emptyText: "No social sign-in methods are available.",
      })}
    </section>`;

  const body = `<div class="page-center">
  <main class="card">
    <div class="card-header">
      ${IDNEST_LOGO}
      <p class="brand-tagline">Account settings</p>
    </div>

    <hr class="divider" />

    ${renderFlowMessages(vm.messages)}

    ${factorSection || ""}
    ${factorSection ? `<hr class="divider" />` : ""}
    ${oidcSection}

    ${backLink}
  </main>
</div>`;

  return layout({ title: "Account settings · Idnest", body });
}
