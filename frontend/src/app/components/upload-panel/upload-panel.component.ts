import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Output,
  ViewChild,
  computed,
  effect,
  inject,
  signal
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { toSignal } from "@angular/core/rxjs-interop";
import { MatButtonModule } from "@angular/material/button";
import { MatChipsModule } from "@angular/material/chips";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatSnackBar, MatSnackBarModule } from "@angular/material/snack-bar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { openDocchatToast } from "../toast-snackbar/toast-snackbar.component";
import { DocumentService } from "../../services/document.service";

const MAX_DOCUMENTS = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

@Component({
  selector: "app-upload-panel",
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatChipsModule,
    MatIconModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatTooltipModule
  ],
  templateUrl: "./upload-panel.component.html",
  styleUrl: "./upload-panel.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UploadPanelComponent {
  private readonly documentService = inject(DocumentService);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly document = toSignal(this.documentService.document$, { initialValue: null });
  protected readonly documents = computed(() => this.document()?.documents || []);
  protected readonly documentCount = computed(() => this.documents().length);
  protected readonly uploadStatus = toSignal(this.documentService.uploadStatus$, {
    initialValue: "idle"
  });
  protected readonly uploadProgress = toSignal(this.documentService.uploadProgress$, {
    initialValue: 0
  });
  protected readonly uploadTarget = toSignal(this.documentService.uploadTarget$, {
    initialValue: null
  });
  protected readonly toastMessage = toSignal(this.documentService.toast$, { initialValue: null });
  protected readonly isDragging = signal(false);
  protected readonly showWorkspaceHeader = computed(
    () => this.documentCount() > 0 || !!this.uploadTarget()
  );

  @Output()
  readonly questionSelected = new EventEmitter<string>();

  @Output()
  readonly documentCleared = new EventEmitter<void>();

  @ViewChild("fileInput")
  private fileInput?: ElementRef<HTMLInputElement>;

  constructor() {
    effect(() => {
      const toast = this.toastMessage();

      if (!toast) {
        return;
      }

      openDocchatToast(this.snackBar, toast);
      this.documentService.dismissToast();
    }, { allowSignalWrites: true });
  }

  protected openFilePicker(): void {
    if (this.uploadStatus() === "loading" || this.documentCount() >= MAX_DOCUMENTS) {
      return;
    }

    this.fileInput?.nativeElement.click();
  }

  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.handleFiles(input.files);
    input.value = "";
  }

  protected onDragOver(event: DragEvent): void {
    if (this.uploadStatus() === "loading" || this.documentCount() >= MAX_DOCUMENTS) {
      return;
    }

    event.preventDefault();
    this.isDragging.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    if (this.uploadStatus() === "loading" || this.documentCount() >= MAX_DOCUMENTS) {
      return;
    }

    event.preventDefault();
    this.isDragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    if (this.uploadStatus() === "loading" || this.documentCount() >= MAX_DOCUMENTS) {
      return;
    }

    event.preventDefault();
    this.isDragging.set(false);
    this.handleFiles(event.dataTransfer?.files || null);
  }

  protected removeDocument(sessionId: string): void {
    const isLastDocument = this.documents().length === 1;
    this.documentService.removeDocument(sessionId);

    if (isLastDocument) {
      this.documentCleared.emit();
    }
  }

  protected emitSuggestedQuestion(question: string): void {
    this.questionSelected.emit(question);
  }

  protected formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    return `${value.toFixed(value > 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  private handleFiles(fileList: FileList | null): void {
    if (!fileList?.length) {
      return;
    }

    const currentDocuments = this.documents();
    const availableSlots = MAX_DOCUMENTS - currentDocuments.length;

    if (availableSlots <= 0) {
      this.documentService.showToast(`You can upload up to ${MAX_DOCUMENTS} documents at a time.`);
      return;
    }

    const files = Array.from(fileList);
    const selectedKeys = new Set<string>();
    const existingKeys = new Set(
      currentDocuments.map((document) => `${document.fileName}:${document.fileSize}`)
    );
    const validFiles: File[] = [];
    const messages: string[] = [];

    for (const file of files) {
      const fileKey = `${file.name}:${file.size}`;

      if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
        messages.push(`Skipped ${file.name}: only PDF files are supported.`);
        continue;
      }

      if (file.size > MAX_FILE_SIZE) {
        messages.push(`Skipped ${file.name}: file too large. Maximum size is 10MB.`);
        continue;
      }

      if (existingKeys.has(fileKey) || selectedKeys.has(fileKey)) {
        messages.push(`Skipped ${file.name}: this PDF is already uploaded.`);
        continue;
      }

      if (validFiles.length >= availableSlots) {
        messages.push(`Only ${availableSlots} more document${availableSlots === 1 ? "" : "s"} can be added right now.`);
        break;
      }

      selectedKeys.add(fileKey);
      validFiles.push(file);
    }

    if (!validFiles.length) {
      this.documentService.showToast(messages[0] || "No valid PDF files were selected.");
      return;
    }

    if (messages.length) {
      this.documentService.showToast(messages[0]);
    }

    validFiles.forEach((file) => this.documentService.queueUpload(file));
  }
}
