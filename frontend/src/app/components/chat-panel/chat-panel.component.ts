import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  ViewChild,
  afterNextRender,
  computed,
  effect,
  inject,
  signal
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { toSignal } from "@angular/core/rxjs-interop";
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from "@angular/forms";
import { CdkTextareaAutosize, TextFieldModule } from "@angular/cdk/text-field";
import { animate, style, transition, trigger } from "@angular/animations";
import { MatButtonModule } from "@angular/material/button";
import { MatChipsModule } from "@angular/material/chips";
import { MatIconModule } from "@angular/material/icon";
import { MatSnackBar, MatSnackBarModule } from "@angular/material/snack-bar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { openDocchatToast } from "../toast-snackbar/toast-snackbar.component";
import { ChatMessage, MessageSource } from "../../models/docchat.models";
import { ChatService } from "../../services/chat.service";
import { DocumentService } from "../../services/document.service";

interface AssistantContentBlock {
  type: "paragraph" | "list";
  items: string[];
}

@Component({
  selector: "app-chat-panel",
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TextFieldModule,
    MatButtonModule,
    MatChipsModule,
    MatIconModule,
    MatSnackBarModule,
    MatTooltipModule
  ],
  templateUrl: "./chat-panel.component.html",
  styleUrl: "./chat-panel.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger("messageEnter", [
      transition(":enter", [
        style({ opacity: 0, transform: "translateY(12px)" }),
        animate("150ms ease-out", style({ opacity: 1, transform: "translateY(0)" }))
      ])
    ])
  ]
})
export class ChatPanelComponent {
  private readonly documentService = inject(DocumentService);
  private readonly chatService = inject(ChatService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly injector = inject(Injector);

  protected readonly document = toSignal(this.documentService.document$, { initialValue: null });
  protected readonly messages = toSignal(this.chatService.messages$, { initialValue: [] });
  protected readonly isStreaming = toSignal(this.chatService.isStreaming$, { initialValue: false });
  protected readonly activeAssistantId = toSignal(this.chatService.activeAssistantId$, {
    initialValue: null
  });
  protected readonly sessionExpired = toSignal(this.documentService.sessionExpired$, {
    initialValue: false
  });
  protected readonly toastMessage = toSignal(this.chatService.toast$, { initialValue: null });
  protected readonly showEmptyState = computed(() => !this.document());
  protected readonly activeTab = signal<"summary" | "chat">("chat");
  protected readonly selectedSummarySessionId = signal<string | null>(null);
  protected readonly summaryDocuments = computed(() => this.document()?.documents || []);
  protected readonly selectedSummaryDocument = computed(() => {
    const documents = this.summaryDocuments();
    const selectedId = this.selectedSummarySessionId();

    return (
      documents.find((item) => item.sessionId === selectedId) ||
      documents[0] ||
      null
    );
  });
  protected readonly selectedSummaryDocumentId = computed(
    () => this.selectedSummaryDocument()?.sessionId || null
  );
  protected readonly showQuestionCards = computed(
    () => !!this.document() && this.activeTab() === "chat" && this.messages().length === 0
  );
  protected readonly exampleQuestions = computed(() => {
    const document = this.document();
    const generated =
      document?.documents.flatMap((item) => item.starterQuestions).filter(Boolean) ?? [];
    const fallback = [
      "Summarize the executive highlights in this document.",
      "Which deadlines, milestones, or dates matter most?",
      "What risks, assumptions, or caveats are called out?",
      "What actions or decisions does this document recommend?"
    ];

    return Array.from(new Set([...generated, ...fallback])).slice(0, 4);
  });
  protected readonly questionForm = new FormGroup({
    question: new FormControl("", {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(500)]
    })
  });
  protected readonly copiedMessageId = signal<string | null>(null);
  protected readonly openSourceMessageIds = signal<string[]>([]);

  @ViewChild("scrollViewport")
  private scrollViewport?: ElementRef<HTMLDivElement>;
  @ViewChild("composerTextarea")
  private composerTextarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild(CdkTextareaAutosize)
  private composerAutosize?: CdkTextareaAutosize;
  private previousDocumentIds = "";

  constructor() {
    effect(() => {
      const document = this.document();
      const documentIds = document?.sessionIds.join("|") || "";

      if (!documentIds) {
        this.activeTab.set("chat");
        this.selectedSummarySessionId.set(null);
        this.previousDocumentIds = "";
        return;
      }

      if (this.previousDocumentIds && this.previousDocumentIds !== documentIds) {
        const previousDocumentIds = new Set(this.previousDocumentIds.split("|").filter(Boolean));
        const addedDocument = document?.documents.find(
          (item) => !previousDocumentIds.has(item.sessionId)
        );

        this.chatService.clearConversation();

        if (addedDocument && document) {
          this.chatService.addSystemMessage(
            `New document added: ${addedDocument.fileName} — now chatting across ${document.documents.length} documents`
          );
        }
      }

      if (this.previousDocumentIds !== documentIds) {
        this.activeTab.set("summary");
      }

      const documents = document?.documents || [];
      const selectedId = this.selectedSummarySessionId();

      if (!documents.some((item) => item.sessionId === selectedId)) {
        this.selectedSummarySessionId.set(documents[0]?.sessionId || null);
      }

      this.previousDocumentIds = documentIds;
    }, { allowSignalWrites: true });

    effect(() => {
      this.messages();
      this.isStreaming();

      afterNextRender(
        () => {
          const viewport = this.scrollViewport?.nativeElement;

          if (viewport) {
            viewport.scrollTo({
              top: viewport.scrollHeight,
              behavior: "smooth"
            });
          }
        },
        { injector: this.injector }
      );
    });

    effect(() => {
      const toast = this.toastMessage();

      if (!toast) {
        return;
      }

      openDocchatToast(this.snackBar, toast);
      this.chatService.dismissToast();
    }, { allowSignalWrites: true });
  }

  protected get questionControl(): FormControl<string> {
    return this.questionForm.controls.question;
  }

  protected get currentCharacterCount(): number {
    return this.questionControl.value.length;
  }

  async submitSuggestedQuestion(question: string): Promise<void> {
    this.activeTab.set("chat");
    this.questionControl.setValue(question);
    await this.sendCurrentQuestion();
  }

  protected async sendCurrentQuestion(): Promise<void> {
    const session = this.document();

    if (!session || this.questionControl.invalid || this.isStreaming()) {
      return;
    }

    const value = this.questionControl.value.trim();

    if (!value) {
      return;
    }

    this.questionForm.reset({ question: "" });
    this.resetComposerHeight();
    await this.chatService.sendMessage(value, session.activeSessionId);
  }

  protected onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void this.sendCurrentQuestion();
    }
  }

  protected onComposerPaste(event: ClipboardEvent): void {
    const clipboardText = event.clipboardData?.getData("text") ?? "";

    if (!clipboardText) {
      return;
    }

    const textarea = event.target as HTMLTextAreaElement | null;
    const currentValue = this.questionControl.value;
    const selectionStart = textarea?.selectionStart ?? currentValue.length;
    const selectionEnd = textarea?.selectionEnd ?? currentValue.length;
    const selectedLength = Math.max(0, selectionEnd - selectionStart);
    const remaining = 500 - (currentValue.length - selectedLength);

    if (remaining <= 0) {
      event.preventDefault();
      return;
    }

    if (clipboardText.length <= remaining) {
      return;
    }

    event.preventDefault();

    const truncatedText = clipboardText.slice(0, remaining);
    const nextValue =
      currentValue.slice(0, selectionStart) +
      truncatedText +
      currentValue.slice(selectionEnd);

    this.questionControl.setValue(nextValue);

    queueMicrotask(() => {
      if (!textarea) {
        this.resetComposerHeight();
        return;
      }

      const nextCursor = selectionStart + truncatedText.length;
      textarea.setSelectionRange(nextCursor, nextCursor);
      this.resetComposerHeight();
    });
  }

  protected stopStreaming(): void {
    this.chatService.stopStreaming();
  }

  protected selectTab(tab: "summary" | "chat"): void {
    this.activeTab.set(tab);
  }

  protected selectSummaryDocument(sessionId: string): void {
    this.selectedSummarySessionId.set(sessionId);
  }

  protected async retryMessage(question: string | undefined): Promise<void> {
    const session = this.document();

    if (!session || !question) {
      return;
    }

    await this.chatService.retryQuestion(question, session.activeSessionId);
  }

  protected clearExpiredSession(): void {
    this.documentService.removeCurrentDocument();
    this.documentService.clearSessionExpiredBanner();
    this.chatService.clearConversation();
  }

  protected trackSource(index: number, source: MessageSource): string {
    return `${source.fileName}:${source.pageNumber}:${source.chunkIndex}:${index}`;
  }

  protected isAssistantStreaming(message: ChatMessage): boolean {
    return this.activeAssistantId() === message.id && this.isStreaming() && message.role === "assistant";
  }

  protected async copyMessage(message: ChatMessage): Promise<void> {
    if (!message.content.trim()) {
      return;
    }

    await navigator.clipboard.writeText(message.content);
    this.copiedMessageId.set(message.id);

    window.setTimeout(() => {
      if (this.copiedMessageId() === message.id) {
        this.copiedMessageId.set(null);
      }
    }, 1200);
  }

  protected toggleSources(messageId: string): void {
    this.openSourceMessageIds.update((ids) =>
      ids.includes(messageId) ? ids.filter((id) => id !== messageId) : [...ids, messageId]
    );
  }

  protected isSourcesOpen(messageId: string): boolean {
    return this.openSourceMessageIds().includes(messageId);
  }

  private resetComposerHeight(): void {
    afterNextRender(
      () => {
        const textarea = this.composerTextarea?.nativeElement;

        if (textarea) {
          textarea.style.height = "auto";
        }

        this.composerAutosize?.resizeToFitContent(true);
      },
      { injector: this.injector }
    );
  }

  protected formatAssistantContent(content: string): string {
    return content
      .replace(/\n{2,}/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  protected parseAssistantContent(content: string): AssistantContentBlock[] {
    const normalized = this.formatAssistantContent(content);

    if (!normalized) {
      return [];
    }

    const lines = normalized.split("\n");
    const blocks: AssistantContentBlock[] = [];
    let paragraphBuffer: string[] = [];
    let listBuffer: string[] = [];

    const flushParagraph = (): void => {
      if (!paragraphBuffer.length) {
        return;
      }

      blocks.push({
        type: "paragraph",
        items: [paragraphBuffer.join(" ").trim()]
      });
      paragraphBuffer = [];
    };

    const flushList = (): void => {
      if (!listBuffer.length) {
        return;
      }

      blocks.push({
        type: "list",
        items: [...listBuffer]
      });
      listBuffer = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line) {
        flushParagraph();
        flushList();
        continue;
      }

      if (this.isListLine(line)) {
        flushParagraph();
        listBuffer.push(line.replace(/^((\*|-|•)\s+|\d+\.\s+)/, "").trim());
        continue;
      }

      flushList();
      paragraphBuffer.push(line);
    }

    flushParagraph();
    flushList();

    return blocks;
  }

  private isListLine(line: string): boolean {
    return /^((\*|-|•)\s+|\d+\.\s+)/.test(line);
  }
}
