import { Injectable, signal } from "@angular/core";
import type { AppToastEvent, AppToastOptions } from "./toast.model";

/**
 * Plain signal-based toast service (no ngrx).
 */
@Injectable({ providedIn: "root" })
export class ToastService {
  private nextId = 1;
  readonly events = signal<readonly AppToastEvent[]>([]);

  show(message: string, options: AppToastOptions = {}): void {
    this.events.update((prev) => [
      ...prev,
      {
        id: this.nextId++,
        message,
        tone: options.tone ?? "neutral",
        duration: options.duration,
        title: options.title,
      },
    ]);
  }

  success(message: string, options: Omit<AppToastOptions, "tone"> = {}): void {
    this.show(message, { ...options, tone: "success" });
  }

  warning(message: string, options: Omit<AppToastOptions, "tone"> = {}): void {
    this.show(message, { ...options, tone: "warning" });
  }

  danger(message: string, options: Omit<AppToastOptions, "tone"> = {}): void {
    this.show(message, { ...options, tone: "danger" });
  }

  neutral(message: string, options: Omit<AppToastOptions, "tone"> = {}): void {
    this.show(message, { ...options, tone: "neutral" });
  }

  clear(): void {
    this.events.set([]);
  }
}
