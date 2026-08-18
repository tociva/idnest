import { computed, Injectable, signal } from "@angular/core";

/**
 * Plain signal-based progress service (no ngrx).
 */
@Injectable({ providedIn: "root" })
export class ProgressService {
  private readonly activeRequests = signal(0);
  readonly isVisible = computed(() => this.activeRequests() > 0);

  show(): void {
    this.activeRequests.update((n) => n + 1);
  }

  hideOne(): void {
    this.activeRequests.update((n) => Math.max(0, n - 1));
  }

  hide(): void {
    this.activeRequests.set(0);
  }
}
