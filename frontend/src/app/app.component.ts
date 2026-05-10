import { ChangeDetectionStrategy, Component, ViewChild, inject } from "@angular/core";
import { ChatPanelComponent } from "./components/chat-panel/chat-panel.component";
import { UploadPanelComponent } from "./components/upload-panel/upload-panel.component";
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
  private readonly chatService = inject(ChatService);

  @ViewChild(ChatPanelComponent)
  private chatPanel?: ChatPanelComponent;

  protected handleSuggestedQuestion(question: string): void {
    this.chatPanel?.submitSuggestedQuestion(question);
  }

  protected handleDocumentCleared(): void {
    this.chatService.clearConversation();
  }
}
