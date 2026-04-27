import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  ViewChild,
  afterNextRender,
  computed,
  effect,
  inject
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
import { ChatMessage } from "../../models/docchat.models";
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
  protected readonly showQuestionCards = computed(
    () => !!this.document() && this.messages().length === 0
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

  protected readonly questionForm = new FormGroup({
    question: new FormControl("", {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(500)]
    })
  });

  @ViewChild("scrollViewport")
  private scrollViewport?: ElementRef<HTMLDivElement>;

  constructor() {
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
  }

  protected isAssistantStreaming(message: ChatMessage): boolean {
    return this.activeAssistantId() === message.id && this.isStreaming() && message.role === "assistant";
  }
}
