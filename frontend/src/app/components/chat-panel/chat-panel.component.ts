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
import { TextFieldModule } from "@angular/cdk/text-field";
import { animate, style, transition, trigger } from "@angular/animations";
import { MatButtonModule } from "@angular/material/button";
import { MatChipsModule } from "@angular/material/chips";
import { MatIconModule } from "@angular/material/icon";
import { MatSnackBar, MatSnackBarModule } from "@angular/material/snack-bar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { ChatMessage, MessageSource } from "../../models/docchat.models";
import { ChatService } from "../../services/chat.service";
import { DocumentService } from "../../services/document.service";

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
  protected readonly showQuestionCards = computed(
    () => !!this.document() && this.activeTab() === "chat" && this.messages().length === 0
  );
  protected readonly exampleQuestions = computed(() => {
    const document = this.document();
    const generated = document?.starterQuestions ?? [];
    const fallback = [
      "Summarize the executive highlights in this document.",
      "Which deadlines, milestones, or dates matter most?",
      "What risks, assumptions, or caveats are called out?",
      "What actions or decisions does this document recommend?"
    ];

    return Array.from(new Set([...generated, ...fallback])).slice(0, 4);
  });
  protected readonly latestAssistantMessageWithSources = computed(() => {
    const messages = this.messages();

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];

      if (message.role === "assistant" && message.sources?.length) {
        return message;
      }
    }

    return null;
  });

  protected readonly questionForm = new FormGroup({
    question: new FormControl("", {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(500)]
    })
  });
  protected readonly sourceModal = signal<{
    messageId: string;
    sources: MessageSource[];
  } | null>(null);
  protected readonly copiedMessageId = signal<string | null>(null);

  @ViewChild("scrollViewport")
  private scrollViewport?: ElementRef<HTMLDivElement>;
  private previousSessionId: string | null = null;

  constructor() {
    effect(() => {
      const sessionId = this.document()?.sessionId ?? null;

      if (!sessionId) {
        this.activeTab.set("chat");
        this.sourceModal.set(null);
        this.previousSessionId = null;
        return;
      }

      if (this.previousSessionId !== sessionId) {
        this.activeTab.set("summary");
        this.sourceModal.set(null);
      }

      this.previousSessionId = sessionId;
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

      this.snackBar.open(toast, "Dismiss", {
        duration: 4000,
        horizontalPosition: "end",
        verticalPosition: "bottom",
        panelClass: "docchat-snackbar"
      });
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
    await this.chatService.sendMessage(value, session.sessionId);
  }

  protected onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void this.sendCurrentQuestion();
    }
  }

  protected stopStreaming(): void {
    this.chatService.stopStreaming();
  }

  protected selectTab(tab: "summary" | "chat"): void {
    this.activeTab.set(tab);
  }

  protected async retryMessage(question: string | undefined): Promise<void> {
    const session = this.document();

    if (!session || !question) {
      return;
    }

    await this.chatService.retryQuestion(question, session.sessionId);
  }

  protected clearExpiredSession(): void {
    this.documentService.removeCurrentDocument();
    this.documentService.clearSessionExpiredBanner();
    this.chatService.clearConversation();
    this.sourceModal.set(null);
  }

  protected isAssistantStreaming(message: ChatMessage): boolean {
    return this.activeAssistantId() === message.id && this.isStreaming() && message.role === "assistant";
  }

  protected openSourcesModal(message: ChatMessage): void {
    if (!message.sources?.length) {
      return;
    }

    this.sourceModal.set({
      messageId: message.id,
      sources: message.sources
    });
  }

  protected closeSourcesModal(): void {
    this.sourceModal.set(null);
  }

  protected openLatestSourcesModal(): void {
    const message = this.latestAssistantMessageWithSources();

    if (message) {
      this.openSourcesModal(message);
    }
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

  protected formatAssistantContent(content: string): string {
    return content
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }
}
