import { ChangeDetectionStrategy, Component, ViewChild, effect, inject } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ChatPanelComponent } from "./components/chat-panel/chat-panel.component";
import { UploadPanelComponent } from "./components/upload-panel/upload-panel.component";
import { DocumentService } from "./services/document.service";
import { ChatService } from "./services/chat.service";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [UploadPanelComponent, ChatPanelComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  private readonly documentService = inject(DocumentService);
  private readonly chatService = inject(ChatService);
  private previousSessionId: string | null = null;

  protected readonly documentSession = toSignal(this.documentService.document$, {
    initialValue: null
  });

  @ViewChild(ChatPanelComponent)
  private chatPanel?: ChatPanelComponent;

  constructor() {
    effect(() => {
      const sessionId = this.documentSession()?.sessionId ?? null;

      if (this.previousSessionId && sessionId && this.previousSessionId !== sessionId) {
        this.chatService.clearConversation();
      }

      this.previousSessionId = sessionId;
    });
  }

  protected handleSuggestedQuestion(question: string): void {
    this.chatPanel?.submitSuggestedQuestion(question);
  }

  protected handleDocumentCleared(): void {
    this.chatService.clearConversation();
  }
}
