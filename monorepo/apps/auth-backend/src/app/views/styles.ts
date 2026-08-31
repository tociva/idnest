/**
 * Self-contained CSS for the server-rendered auth pages, inlined into every
 * page's <head>. Colors mapped from the design-system light semantic tokens.
 */
export const STYLES = /* css */ `
:root {
  --brand:          #2563eb;
  --brand-hover:    #1d4ed8;
  --bg-base:        #eef4fb;
  --bg-canvas:      #e3edf8;
  --bg-surface:     #f3f8fd;
  --fg-primary:     #1f2937;
  --fg-secondary:   #4b5563;
  --fg-muted:       #6b7280;
  --border-default: #b8c7d9;
  --border-subtle:  #cdd9e8;
  --border-strong:  #7f92aa;
}

*, *::before, *::after { box-sizing: border-box; }

html, body {
  height: 100%;
  margin: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  line-height: 1.5;
  color: var(--fg-primary);
  background: var(--bg-base);
}

.page-center {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: linear-gradient(160deg, var(--bg-base) 0%, var(--bg-canvas) 100%);
}

.card {
  width: 100%;
  max-width: 26rem;
  background: #ffffff;
  border: 1px solid var(--border-default);
  border-radius: 1rem;
  box-shadow:
    0 1px 3px rgba(37, 99, 235, 0.06),
    0 8px 24px -4px rgba(37, 99, 235, 0.10),
    0 20px 40px -8px rgba(37, 99, 235, 0.08);
  padding: 2.25rem 2rem;
}
.card-error { max-width: 32rem; }
.card-consent { max-width: 34rem; }
.card-legal { max-width: 36rem; }

.card-header { text-align: center; margin-bottom: 1.75rem; }

.idnest-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin: 0 auto;
}

.idnest-logo__mark {
  width: 3rem;
  height: 3rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.875rem;
  color: #ffffff;
  background: var(--brand);
  box-shadow: 0 10px 22px -10px rgba(37, 99, 235, 0.70);
}

.idnest-logo__mark span {
  font-size: 1.125rem;
  font-weight: 800;
  letter-spacing: 0;
}

.idnest-logo__text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.1;
}

.idnest-logo__text strong { font-size: 1.25rem; }
.idnest-logo__text span { font-size: 0.75rem; color: var(--fg-muted); margin-top: 0.25rem; }

.brand-tagline { font-size: 0.875rem; color: var(--fg-muted); margin: 0.75rem 0 0; }

.divider {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 0 0 1.5rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  width: 100%;
  padding: 0.6875rem 1.25rem;
  font-size: 0.9375rem;
  font-weight: 500;
  border-radius: 0.625rem;
  border: 1px solid transparent;
  cursor: pointer;
  text-decoration: none;
  transition: background 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  line-height: 1.4;
}
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.btn-sm { width: auto; padding: 0.375rem 0.875rem; font-size: 0.8125rem; }

.btn-primary { background: var(--brand); color: #fff; border-color: var(--brand); }
.btn-primary:hover { background: var(--brand-hover); border-color: var(--brand-hover); }

.btn-outline { background: #fff; color: var(--brand); border: 1px solid var(--brand); }
.btn-outline:hover { background: var(--brand); color: #fff; }

.settings-section { display: flex; flex-direction: column; gap: 0.875rem; }
.settings-heading {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--fg);
}
.settings-hint {
  margin: 0;
  font-size: 0.875rem;
  color: var(--fg-muted);
}
.settings-factor-form {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  font-size: 0.875rem;
  color: var(--fg-secondary);
}
.field input {
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  font-size: 1rem;
}
.totp-qr {
  display: block;
  margin: 0.25rem auto;
  border-radius: 0.5rem;
  background: #fff;
  padding: 0.5rem;
}

.oidc-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* Social OAuth buttons. Apple uses its required high-contrast black treatment. */
.btn-provider,
.btn-google {
  background: #ffffff;
  color: var(--fg-secondary);
  border-color: var(--border-default);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  font-weight: 500;
}
.btn-provider:hover,
.btn-google:hover {
  background: var(--bg-surface);
  border-color: var(--border-strong);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.10);
}
.btn-apple {
  min-height: 44px;
  background: #000000;
  color: #ffffff;
  border-color: #000000;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.14);
  font-weight: 500;
}
.btn-apple:hover { background: #1c1c1e; border-color: #1c1c1e; }
.provider-icon,
.google-icon,
.apple-icon { width: 18px; height: 18px; flex-shrink: 0; }
.apple-icon { color: currentColor; }

.alert { padding: 0.875rem 1rem; border-radius: 0.625rem; border: 1px solid; font-size: 0.875rem; margin-bottom: 1rem; }
.alert-error { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
.alert-warning { background: #fffbeb; border-color: #fde68a; color: #92400e; }
.alert-info { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
.alert-success { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
.flow-messages .alert:last-child { margin-bottom: 1rem; }

.link { color: var(--brand); text-decoration: underline; background: none; border: none; cursor: pointer; font: inherit; padding: 0; }
.link:hover { opacity: 0.75; }

.terms-text { font-size: 0.75rem; color: var(--fg-muted); text-align: center; margin: 1.25rem 0 0; }
.legal-copy { color: var(--fg-secondary); font-size: 0.9375rem; }
.legal-copy p { margin: 0 0 1rem; }
.legal-copy p:last-child { margin-bottom: 0; }
.legal-dialog {
  width: min(920px, calc(100vw - 2rem));
  height: min(720px, calc(100vh - 2rem));
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: 0.75rem;
  box-shadow: 0 24px 64px -24px rgba(15, 23, 42, 0.45);
}
.legal-dialog::backdrop { background: rgba(15, 23, 42, 0.48); }
.dialog-panel {
  display: grid;
  grid-template-rows: auto 1fr;
  width: 100%;
  height: 100%;
  background: #fff;
}
.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--border-subtle);
}
.dialog-header h2 { margin: 0; font-size: 1rem; }
.dialog-close {
  display: inline-grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid var(--border-subtle);
  border-radius: 0.5rem;
  background: #fff;
  color: var(--fg-secondary);
  cursor: pointer;
  font-size: 1.25rem;
  line-height: 1;
}
.dialog-close:hover { background: var(--bg-surface); }
.dialog-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

.error-title { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
.hint-title { display: block; margin-bottom: 0.25rem; }
.hint-body { margin: 0; }
.details-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.details-label { font-size: 0.8125rem; font-weight: 600; color: #374151; }
.error-pre {
  background: #f9fafb;
  border: 1px solid var(--border-subtle);
  border-radius: 0.5rem;
  padding: 0.875rem;
  font-size: 0.8125rem;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.card-footer { margin-top: 1.25rem; text-align: center; }
.recovery-panel {
  display: grid;
  gap: 0.625rem;
  margin-top: 1.25rem;
  text-align: center;
}
.recovery-hint {
  margin: 0;
  color: var(--fg-muted);
  font-size: 0.875rem;
}

.app-summary {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin-bottom: 1rem;
}
.app-summary h1 {
  font-size: 1.125rem;
  line-height: 1.25;
  margin: 0 0 0.125rem;
}
.app-summary p { margin: 0 0 0.375rem; color: var(--fg-muted); font-size: 0.875rem; }
.app-logo,
.app-logo-fallback {
  width: 48px;
  height: 48px;
  border-radius: 0.75rem;
  border: 1px solid var(--border-subtle);
  flex: 0 0 auto;
}
.app-logo { object-fit: contain; background: #fff; padding: 0.25rem; }
.app-logo-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-surface);
  color: var(--brand);
  font-weight: 700;
  font-size: 1.25rem;
}
.trust-pill {
  display: inline-flex;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  color: var(--fg-secondary);
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
}
.account-box {
  border: 1px solid var(--border-subtle);
  border-radius: 0.75rem;
  padding: 0.75rem 0.875rem;
  margin-bottom: 1rem;
}
.account-box span { display: block; color: var(--fg-muted); font-size: 0.75rem; }
.section-title { font-size: 0.875rem; margin: 0 0 0.5rem; }
.permission-list {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  list-style: none;
  margin: 0 0 1.25rem;
  padding: 0;
}
.permission-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.75rem;
  padding: 0.75rem;
}
.permission-row strong { display: block; font-size: 0.875rem; }
.permission-row p { margin: 0.125rem 0 0; color: var(--fg-muted); font-size: 0.8125rem; }
.permission-row code { color: var(--fg-muted); font-size: 0.75rem; white-space: nowrap; }
.permission-caution { border-color: #fde68a; background: #fffbeb; }
.consent-actions { margin-top: 0.625rem; }
`;
