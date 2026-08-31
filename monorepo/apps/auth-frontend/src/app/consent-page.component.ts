import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import type { PublicAuthRecovery } from "@idnest/shared-types";
import { AuthApiService, type ConsentContextResponse } from "./auth-api.service";
import { AuthRecoveryComponent } from "./auth-recovery.component";
import { BrandService } from "./brand.service";

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "View your basic profile",
  email: "View your email address",
  offline_access: "Keep me signed in on this device",
};

@Component({
  selector: "idnest-consent-page",
  template: `
    <div class="auth-page">
      <main class="auth-card consent-card" aria-live="polite">
        @if (loading()) {
          <div class="loading-state" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading access request…</span>
          </div>
        } @else if (error()) {
          <section class="error-state">
            <div class="brand-mark" aria-hidden="true">I</div>
            <h1>Access request unavailable</h1>
            <p>{{ error() }}</p>
            <idnest-auth-recovery [recovery]="recovery()" />
          </section>
        } @else if (context()) {
          <header class="brand-header">
            <div class="brand-wordmark">
              <span class="brand-mark" aria-hidden="true">{{ brandInitial() }}</span>
              <strong>{{ context()!.brand.productName }}</strong>
            </div>
            <h1>{{ context()!.brand.consentHeading }}</h1>
            <p>{{ context()!.client.displayName }} is requesting access.</p>
          </header>

          <section class="permission-list" aria-label="Requested permissions">
            @for (scope of context()!.requestedScopes; track scope) {
              <div class="permission-item">
                <span class="permission-check" aria-hidden="true">✓</span>
                <div>
                  <strong>{{ scopeLabel(scope) }}</strong>
                  <small>{{ scope }}</small>
                </div>
              </div>
            }
          </section>

          <div class="consent-actions">
            <button class="auth-button" type="button" [disabled]="busy()" (click)="decide('accept')">
              Allow access
            </button>
            <button class="auth-button secondary-button" type="button" [disabled]="busy()" (click)="decide('reject')">
              Deny
            </button>
          </div>

          <footer class="legal-footer">
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
  `,
  imports: [AuthRecoveryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsentPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AuthApiService);
  private readonly brands = inject(BrandService);

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly recovery = signal<PublicAuthRecovery | null>(null);
  readonly context = signal<ConsentContextResponse | null>(null);

  async ngOnInit(): Promise<void> {
    const transactionId = this.route.snapshot.queryParamMap.get("transaction");
    if (!transactionId) {
      this.error.set("This access request is incomplete.");
      this.recovery.set({ kind: "request_context_unavailable" });
      this.loading.set(false);
      return;
    }
    try {
      const context = await this.api.consentContext(transactionId);
      this.context.set(context);
      this.recovery.set(context.recovery);
      this.brands.apply(context.brand);
    } catch (error) {
      this.error.set("This access request has expired. Return to the application and try again.");
      this.recovery.set(this.api.recoveryFromError(error));
    } finally {
      this.loading.set(false);
    }
  }

  brandInitial(): string {
    return this.context()?.brand.productName.trim().charAt(0).toUpperCase() || "I";
  }

  scopeLabel(scope: string): string {
    return SCOPE_LABELS[scope] ?? `Use the ${scope} permission`;
  }

  async decide(action: "accept" | "reject"): Promise<void> {
    const context = this.context();
    if (!context || this.busy()) return;
    this.busy.set(true);
    try {
      const token = action === "accept" ? context.acceptToken : context.rejectToken;
      const response = await this.api.consentAction(context.transactionId, action, token);
      window.location.assign(response.redirectTo);
    } catch (error) {
      this.error.set("The access decision could not be completed safely.");
      this.recovery.set(this.api.recoveryFromError(error) ?? context.recovery);
      this.busy.set(false);
    }
  }
}
