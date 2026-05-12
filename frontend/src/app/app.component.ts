import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ChatPanelComponent } from "./components/chat-panel/chat-panel.component";
import { UploadPanelComponent } from "./components/upload-panel/upload-panel.component";
import { ChatService } from "./services/chat.service";
import { DocumentService } from "./services/document.service";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [UploadPanelComponent, ChatPanelComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  private readonly chatService = inject(ChatService);
  private readonly documentService = inject(DocumentService);
  private readonly document = toSignal(this.documentService.document$, { initialValue: null });
  private readonly uploadTarget = toSignal(this.documentService.uploadTarget$, { initialValue: null });

  protected readonly isHeaderCollapsible = computed(
    () => !!this.document()?.documents?.length || !!this.uploadTarget()
  );

  @ViewChild(ChatPanelComponent)
  private chatPanel?: ChatPanelComponent;

  protected handleSuggestedQuestion(question: string): void {
    this.chatPanel?.submitSuggestedQuestion(question);
  }

  protected handleDocumentCleared(): void {
    this.chatService.clearConversation();
  }
}
