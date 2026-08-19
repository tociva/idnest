import { layout } from "../layout";
import { IDNEST_LOGO } from "../icons";
import type { FlowHiddenInput, FlowSubmitButton } from "./flow-controls";
import { renderOidcForm } from "./oidc-form";

export interface LoginViewModel {
  /** Kratos login action URL the form POSTs to (full-page, browser → Kratos). */
  actionUrl: string;
  /** Hidden inputs from the Kratos flow, including csrf_token. */
  hiddenInputs: FlowHiddenInput[];
  /** OIDC provider submit buttons from the Kratos flow. */
  providers: FlowSubmitButton[];
}

/**
 * The login page posts a normal browser form to Kratos, which then redirects to
 * the selected upstream provider. No client-side JS required — Kratos needs a
 * real navigation, not XHR.
 */
export function renderLogin(vm: LoginViewModel): string {
  const body = `<div class="page-center">
  <main class="card">
    <div class="card-header">
      ${IDNEST_LOGO}
      <p class="brand-tagline">Sign in to continue</p>
    </div>

    <hr class="divider" />

    ${renderOidcForm({
      actionUrl: vm.actionUrl,
      hiddenInputs: vm.hiddenInputs,
      buttons: vm.providers,
      emptyText: "No sign-in providers are available.",
    })}

    <p class="terms-text">
      By signing in, you agree to our
      <a href="/terms" class="link">Terms &amp; Conditions</a>
      and
      <a href="/privacy" class="link">Privacy Policy</a>.
    </p>
  </main>
</div>`;

  return layout({ title: "Sign in · Idnest", body });
}
