import { DOCUMENT, NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import type {
  KratosFlow,
  KratosUiNode,
  KratosUiText,
  PublicAuthContext,
  PublicAuthRecovery,
} from "@idnest/shared-types";
import { AuthApiService } from "./auth-api.service";
import { loginFlowErrorMessage } from "./auth-flow-errors";
import { isLoginFlowRedirectResponse } from "./auth-flow-response";
import { AuthRecoveryComponent } from "./auth-recovery.component";
import { BrandService } from "./brand.service";

@Component({
  selector: "idnest-auth-page",
  template: `
    <div class="auth-page">
      <main class="auth-card" aria-live="polite">
        @if (loading()) {
          <div class="loading-state" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <span>Preparing secure sign-in…</span>
          </div>
        } @else if (error()) {
          <section class="error-state">
            <div class="brand-mark" aria-hidden="true">I</div>
            <h1>Sign-in unavailable</h1>
            <p>{{ error() }}</p>
            <idnest-auth-recovery [recovery]="recovery()" />
          </section>
        } @else if (flow() && context()) {
          <header class="brand-header">
            @if (brandLogo() && !logoFailed()) {
              <picture>
                @if (darkBrandLogo()) {
                  <source media="(prefers-color-scheme: dark)" [srcset]="darkBrandLogo()" />
                }
                <img
                  class="brand-logo"
                  [src]="brandLogo()"
                  [alt]="context()!.brand.displayName"
                  (error)="logoFailed.set(true)"
                />
              </picture>
            } @else {
              <div class="brand-wordmark">
                <span class="brand-mark" aria-hidden="true">{{ brandInitial() }}</span>
                <strong>{{ context()!.brand.productName }}</strong>
              </div>
            }
            <h1>{{ context()!.brand.loginHeading }}</h1>
            <p>{{ context()!.brand.loginDescription }}</p>
          </header>

          @if (flow()!.ui.messages?.length) {
            <div class="flow-messages" role="alert">
              @for (message of flow()!.ui.messages; track message.id ?? $index) {
                <p [class.message-error]="message.type === 'error'">{{ message.text }}</p>
              }
            </div>
          }

          @if (illustrationUrl()) {
            <img class="brand-illustration" [src]="illustrationUrl()" alt="" />
          }

          @if (enrollmentUrl() && !hasInteractiveNodes()) {
            <section class="enrollment-state">
              <p>
                This application requires a second authentication factor. Set up an
                authenticator app, then continue sign-in.
              </p>
              <a class="auth-button" [href]="enrollmentUrl()">Set up authenticator</a>
            </section>
          } @else {
            <form
              class="auth-form"
              [attr.action]="flow()!.ui.action"
              [attr.method]="flow()!.ui.method"
            >
              @for (node of flow()!.ui.nodes; track nodeKey(node, $index)) {
                @if (isHidden(node)) {
                  <input
                    type="hidden"
                    [attr.name]="node.attributes.name"
                    [attr.value]="nodeValue(node)"
                  />
                } @else if (isSubmit(node)) {
                  <button
                    class="auth-button"
                    [class.provider-button]="node.group === 'oidc'"
                    [attr.data-provider]="node.group === 'oidc' ? providerId(node) : null"
                    type="submit"
                    [attr.name]="node.attributes.name"
                    [attr.value]="nodeValue(node)"
                    [disabled]="node.attributes.disabled === true"
                  >
                    @if (node.group === "oidc") {
                      @switch (providerId(node)) {
                        @case ("apple") {
                          <svg
                            class="provider-icon apple-icon"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path
                              fill="currentColor"
                              d="M16.365 1.43c0 1.14-.423 2.181-1.269 3.12-.982 1.082-2.075 1.705-3.244 1.606-.136-1.088.39-2.246 1.174-3.111.861-.956 2.33-1.686 3.339-1.615zM20.18 17.21c-.56 1.29-.829 1.864-1.55 3.003-1.006 1.546-2.42 3.474-4.176 3.489-1.56.014-1.963-1.012-4.081-1.001-2.119.011-2.56 1.018-4.123 1.004-1.756-.016-3.094-1.754-4.1-3.301-2.812-4.32-3.108-9.39-1.373-12.083 1.233-1.913 3.18-3.034 5.011-3.034 1.866 0 3.039 1.024 4.583 1.024 1.497 0 2.408-1.027 4.568-1.027 1.635 0 3.367.89 4.596 2.427-4.04 2.214-3.383 7.986.645 9.499z"
                            />
                          </svg>
                        }
                        @case ("google") {
                          <svg
                            class="provider-icon google-icon"
                            viewBox="0 0 48 48"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path
                              fill="#ea4335"
                              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                            />
                            <path
                              fill="#4285f4"
                              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                            />
                            <path
                              fill="#fbbc05"
                              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                            />
                            <path
                              fill="#34a853"
                              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                            />
                          </svg>
                        }
                        @default {
                          <span class="provider-dot" aria-hidden="true"></span>
                        }
                      }
                    }
                    <span>{{ nodeLabel(node) }}</span>
                  </button>
                  <ng-container
                    [ngTemplateOutlet]="messages"
                    [ngTemplateOutletContext]="{ values: node.messages ?? [], messageId: null }"
                  />
                } @else if (isInput(node)) {
                  <label class="auth-field" [attr.for]="nodeInputId($index)">
                    <span>{{ nodeLabel(node) }}</span>
                    <input
                      [attr.id]="nodeInputId($index)"
                      [attr.type]="inputType(node)"
                      [attr.name]="node.attributes.name"
                      [attr.value]="nodeValue(node)"
                      [attr.autocomplete]="node.attributes.autocomplete ?? null"
                      [required]="node.attributes.required === true"
                      [disabled]="node.attributes.disabled === true"
                      [attr.aria-invalid]="hasErrors(node) ? 'true' : null"
                      [attr.aria-describedby]="
                        node.messages?.length ? nodeMessageId($index) : null
                      "
                      [checked]="
                        (inputType(node) === 'checkbox' || inputType(node) === 'radio') &&
                        node.attributes.value === true
                      "
                    />
                  </label>
                  <ng-container
                    [ngTemplateOutlet]="messages"
                    [ngTemplateOutletContext]="{
                      values: node.messages ?? [],
                      messageId: nodeMessageId($index)
                    }"
                  />
                }
              }
            </form>
          }

          <button type="button" class="cancel-link" [disabled]="cancelling()" (click)="cancel()">
            {{ isSettingsReauth() ? "Back to settings" : "Cancel and return" }}
          </button>

          <footer class="legal-footer">
            @if (context()!.brand.supportUrl) {
              <a [href]="context()!.brand.supportUrl">Support</a>
            }
            @if (context()!.brand.privacyUrl) {
              <a [href]="context()!.brand.privacyUrl">Privacy</a>
            }
            @if (context()!.brand.termsUrl) {
              <a [href]="context()!.brand.termsUrl">Terms</a>
            }
          </footer>
        }
      </main>
    </div>

    <ng-template #messages let-values="values" let-messageId="messageId">
      <div [attr.id]="messageId">
        @for (message of asMessages(values); track message.id ?? $index) {
          <p class="field-message" [class.message-error]="message.type === 'error'">
            {{ message.text }}
          </p>
        }
      </div>
    </ng-template>
  `,
  imports: [NgTemplateOutlet, AuthRecoveryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AuthApiService);
  private readonly brands = inject(BrandService);
  private readonly document = inject(DOCUMENT);

  readonly loading = signal(true);
  readonly cancelling = signal(false);
  readonly error = signal("");
  readonly recovery = signal<PublicAuthRecovery | null>(null);
  readonly flow = signal<KratosFlow | null>(null);
  readonly context = signal<PublicAuthContext | null>(null);
  readonly logoFailed = signal(false);

  async ngOnInit(): Promise<void> {
    const flowId = this.route.snapshot.queryParamMap.get("flow");
    if (!flowId) {
      this.loading.set(false);
      this.error.set("This sign-in link is incomplete. Return to the application and try again.");
      this.recovery.set({ kind: "request_context_unavailable" });
      return;
    }
    try {
      const response = await this.api.loginFlowContext(flowId);
      if (isLoginFlowRedirectResponse(response)) {
        window.location.assign(response.redirectTo);
        return;
      }
      this.flow.set(response.flow);
      this.context.set(response.context);
      this.recovery.set(response.context.recovery);
      this.brands.apply(response.context.brand);
      window.setTimeout(() => {
        const firstInvalid = this.document.querySelector<HTMLElement>('[aria-invalid="true"]');
        firstInvalid?.focus();
      });
    } catch (error) {
      this.error.set(loginFlowErrorMessage(error));
      this.recovery.set(this.api.recoveryFromError(error));
    } finally {
      this.loading.set(false);
    }
  }

  brandLogo(): string {
    const brand = this.context()?.brand;
    return brand?.logoLightUrl || brand?.logoCompactUrl || "";
  }

  darkBrandLogo(): string {
    return this.context()?.brand.logoDarkUrl || "";
  }

  illustrationUrl(): string {
    return this.brands.safeAssetUrl(this.context()?.brand.illustrationUrl);
  }

  enrollmentUrl(): string {
    return this.context()?.secondaryFactorEnrollmentUrl || "";
  }

  isSettingsReauth(): boolean {
    return this.context()?.purpose === "settings_reauth";
  }

  hasInteractiveNodes(): boolean {
    return (this.flow()?.ui.nodes ?? []).some(
      (node) => this.isSubmit(node) || this.isInput(node),
    );
  }

  brandInitial(): string {
    return this.context()?.brand.productName.trim().charAt(0).toUpperCase() || "I";
  }

  nodeKey(node: KratosUiNode, index: number): string {
    return `${node.group}:${node.attributes.name ?? node.type}:${String(node.attributes.value ?? "")}:${index}`;
  }

  nodeInputId(index: number): string {
    return `kratos-node-${index}`;
  }

  nodeMessageId(index: number): string {
    return `kratos-node-${index}-messages`;
  }

  nodeValue(node: KratosUiNode): string {
    const value = node.attributes.value;
    return typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
      ? String(value)
      : "";
  }

  providerId(node: KratosUiNode): string {
    return node.group === "oidc" ? this.nodeValue(node).trim().toLowerCase() : "";
  }

  nodeLabel(node: KratosUiNode): string {
    const label = node.meta?.label?.text;
    if (node.attributes.name === "provider") {
      const provider = this.providerId(node);
      const providerName = provider === "apple"
        ? "Apple"
        : provider === "google"
          ? "Google"
          : this.nodeValue(node);
      if (label) {
        return provider === "apple"
          ? label.replace(/\bapple\b/gi, providerName)
          : provider === "google"
            ? label.replace(/\bgoogle\b/gi, providerName)
            : label;
      }
      return `Continue with ${providerName}`;
    }
    return label || this.nodeValue(node) || node.attributes.name || "Continue";
  }

  isHidden(node: KratosUiNode): boolean {
    return node.attributes.type === "hidden";
  }

  isSubmit(node: KratosUiNode): boolean {
    return node.attributes.type === "submit";
  }

  isInput(node: KratosUiNode): boolean {
    return node.type === "input" && !this.isHidden(node) && !this.isSubmit(node);
  }

  inputType(node: KratosUiNode): string {
    const type = node.attributes.type;
    return ["email", "password", "text", "tel", "number", "checkbox", "radio"].includes(type ?? "")
      ? String(type)
      : "text";
  }

  hasErrors(node: KratosUiNode): boolean {
    return (node.messages ?? []).some((message) => message.type === "error");
  }

  asMessages(value: unknown): KratosUiText[] {
    return Array.isArray(value) ? value as KratosUiText[] : [];
  }

  async cancel(): Promise<void> {
    if (this.cancelling()) return;
    if (this.isSettingsReauth()) {
      window.location.assign(this.context()?.settingsResumeUrl || "/settings");
      return;
    }
    const transactionId = this.context()?.transactionId;
    if (!transactionId) return;
    this.cancelling.set(true);
    try {
      const response = await this.api.rejectLogin(transactionId);
      window.location.assign(response.redirectTo);
    } catch {
      this.error.set("Unable to cancel this sign-in request safely.");
      this.recovery.set(this.context()?.recovery ?? null);
      this.cancelling.set(false);
    }
  }
}
