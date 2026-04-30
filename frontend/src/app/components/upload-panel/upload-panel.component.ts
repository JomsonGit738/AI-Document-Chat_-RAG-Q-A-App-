import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Injector,
  Output,
  ViewChild,
  afterNextRender,
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
import { DocumentService } from "../../services/document.service";

interface PdfPageLike {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
}

interface PdfDocumentLike {
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
}

interface PdfJsLike {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(source: string): PdfLoadingTaskLike;
}

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
  private readonly injector = inject(Injector);

  protected readonly document = toSignal(this.documentService.document$, { initialValue: null });
  protected readonly uploadStatus = toSignal(this.documentService.uploadStatus$, {
    initialValue: "idle"
  });
  protected readonly uploadProgress = toSignal(this.documentService.uploadProgress$, {
    initialValue: 0
  });
  protected readonly uploadError = toSignal(this.documentService.uploadError$, {
    initialValue: null
  });
  protected readonly toastMessage = toSignal(this.documentService.toast$, { initialValue: null });
  protected readonly isDragging = signal(false);
  protected readonly previewReady = signal(false);
  protected readonly previewError = signal<string | null>(null);
  protected readonly localError = signal<string | null>(null);
  protected readonly effectiveError = computed(() => this.localError() || this.uploadError());

  private renderVersion = 0;

  @Output()
  readonly questionSelected = new EventEmitter<string>();

  @Output()
  readonly documentCleared = new EventEmitter<void>();

  @ViewChild("fileInput")
  private fileInput?: ElementRef<HTMLInputElement>;

  @ViewChild("previewCanvas")
  private previewCanvas?: ElementRef<HTMLCanvasElement>;

  constructor() {
    effect(() => {
      const toast = this.toastMessage();

      if (!toast) {
        return;
      }

      this.snackBar.open(toast, "Dismiss", {
        duration: 4000,
        horizontalPosition: "end",
        verticalPosition: "bottom",
        panelClass: "docchat-snackbar"
      });
      this.documentService.dismissToast();
    }, { allowSignalWrites: true });

    effect(() => {
      const document = this.document();
      this.previewReady.set(false);
      this.previewError.set(null);
      this.renderVersion += 1;
      const currentVersion = this.renderVersion;

      if (!document?.objectUrl) {
        return;
      }

      afterNextRender(
        () => {
          void this.renderPreview(document.objectUrl, currentVersion);
        },
        { injector: this.injector }
      );
    }, { allowSignalWrites: true });
  }

  protected openFilePicker(): void {
    if (this.uploadStatus() === "loading") {
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
    if (this.uploadStatus() === "loading") {
      return;
    }

    event.preventDefault();
    this.isDragging.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    if (this.uploadStatus() === "loading") {
      return;
    }

    event.preventDefault();
    this.isDragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    if (this.uploadStatus() === "loading") {
      return;
    }

    event.preventDefault();
    this.isDragging.set(false);
    this.handleFiles(event.dataTransfer?.files || null);
  }

  protected removeDocument(): void {
    this.documentService.removeCurrentDocument();
    this.localError.set(null);
    this.previewError.set(null);
    this.documentCleared.emit();
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
    if (this.uploadStatus() === "loading") {
      return;
    }

    const file = fileList?.item(0);

    if (!file) {
      return;
    }

    this.localError.set(null);

    const currentDocument = this.document();

    if (
      currentDocument &&
      currentDocument.fileName === file.name &&
      currentDocument.fileSize === file.size
    ) {
      this.localError.set("This PDF is already uploaded.");
      return;
    }

    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      this.localError.set("Only PDF files are supported.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      this.localError.set("File too large. Maximum size is 10MB.");
      return;
    }

    this.documentService.queueUpload(file);
  }

  private async renderPreview(objectUrl: string, version: number): Promise<void> {
    try {
      const canvas = this.previewCanvas?.nativeElement;

      if (!canvas || version !== this.renderVersion) {
        return;
      }

      const pdfjs = (await import("pdfjs-dist")) as unknown as PdfJsLike;
      pdfjs.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";
      const loadedPdf = await pdfjs.getDocument(objectUrl).promise;
      const page = await loadedPdf.getPage(1);
      const viewport = page.getViewport({ scale: 0.46 });
      const context = canvas.getContext("2d");

      if (!context || version !== this.renderVersion) {
        return;
      }

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: context, viewport }).promise;

      if (version === this.renderVersion) {
        this.previewReady.set(true);
      }
    } catch (_error) {
      if (version === this.renderVersion) {
        this.previewError.set("Preview unavailable for this PDF.");
      }
    }
  }
}
