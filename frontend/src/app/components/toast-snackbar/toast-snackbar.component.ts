import { CommonModule } from "@angular/common";
import { Component, inject } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import {
  MAT_SNACK_BAR_DATA,
  MatSnackBar,
  MatSnackBarConfig,
  MatSnackBarRef
} from "@angular/material/snack-bar";

type ToastTone = "info" | "warning" | "error";

interface ToastSnackbarData {
  message: string;
  icon: string;
  tone: ToastTone;
}

@Component({
  selector: "app-toast-snackbar",
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule],
  template: `
    <div class="toast-shell" [class.toast-shell--warning]="data.tone === 'warning'" [class.toast-shell--error]="data.tone === 'error'">
      <div class="toast-icon" [class.toast-icon--warning]="data.tone === 'warning'" [class.toast-icon--error]="data.tone === 'error'">
        <mat-icon>{{ data.icon }}</mat-icon>
      </div>

      <p class="toast-message">{{ data.message }}</p>

      <button
        mat-icon-button
        type="button"
        class="toast-dismiss"
        aria-label="Dismiss notification"
        (click)="dismiss()"
      >
        <mat-icon>close</mat-icon>
      </button>
    </div>
  `,
  styleUrl: "./toast-snackbar.component.css"
})
export class ToastSnackbarComponent {
  readonly data = inject<ToastSnackbarData>(MAT_SNACK_BAR_DATA);
  private readonly snackBarRef = inject(MatSnackBarRef<ToastSnackbarComponent>);

  dismiss(): void {
    this.snackBarRef.dismiss();
  }
}

export function openDocchatToast(snackBar: MatSnackBar, message: string): void {
  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    return;
  }

  const data = buildToastData(trimmedMessage);
  const config: MatSnackBarConfig<ToastSnackbarData> = {
    data,
    duration: 4500,
    horizontalPosition: "end",
    verticalPosition: "top",
    panelClass: "docchat-snackbar"
  };

  snackBar.openFromComponent(ToastSnackbarComponent, config);
}

function buildToastData(message: string): ToastSnackbarData {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("error") ||
    normalized.includes("failed") ||
    normalized.includes("unable") ||
    normalized.includes("network")
  ) {
    return {
      message,
      icon: "error_outline",
      tone: "error"
    };
  }

  if (
    normalized.includes("skip") ||
    normalized.includes("already uploaded") ||
    normalized.includes("maximum") ||
    normalized.includes("limit") ||
    normalized.includes("only pdf") ||
    normalized.includes("too large")
  ) {
    return {
      message,
      icon: "warning_amber",
      tone: "warning"
    };
  }

  return {
    message,
    icon: "info",
    tone: "info"
  };
}
