import { Injectable, inject } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { environment } from "../../environments/environment";
import { ChatMessage, SourceChunk, SseEventPayload } from "../models/docchat.models";
import { DocumentService } from "./document.service";

@Injectable({
  providedIn: "root"
})
export class ChatService {
  private readonly documentService = inject(DocumentService);
  private readonly apiBaseUrl = environment.apiBaseUrl;

  private readonly messagesSubject = new BehaviorSubject<ChatMessage[]>([]);
  private readonly isStreamingSubject = new BehaviorSubject<boolean>(false);
  private readonly toastSubject = new BehaviorSubject<string | null>(null);
  private readonly activeAssistantIdSubject = new BehaviorSubject<string | null>(null);

  private abortController: AbortController | null = null;

  readonly messages$ = this.messagesSubject.asObservable();
  readonly isStreaming$ = this.isStreamingSubject.asObservable();
  readonly toast$ = this.toastSubject.asObservable();
  readonly activeAssistantId$ = this.activeAssistantIdSubject.asObservable();

  async sendMessage(question: string, sessionId: string): Promise<void> {
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion || this.isStreamingSubject.value) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedQuestion,
      createdAt: new Date().toISOString(),
      status: "complete",
      sources: []
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "loading",
      sources: [],
      retryQuestion: trimmedQuestion
    };

    this.messagesSubject.next([...this.messagesSubject.value, userMessage, assistantMessage]);
    this.activeAssistantIdSubject.next(assistantMessage.id);
    this.isStreamingSubject.next(true);

    this.abortController = new AbortController();

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({
          question: trimmedQuestion,
          sessionId
        }),
        signal: this.abortController.signal
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        const message = payload?.error || "The request could not be completed.";

        if (response.status === 404) {
          this.documentService.markSessionExpired();
        }

        this.failAssistantMessage(assistantMessage.id, message, trimmedQuestion);
        return;
      }

      if (!response.body) {
        this.failAssistantMessage(
          assistantMessage.id,
          "Streaming is unavailable in this browser session.",
          trimmedQuestion
        );
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const segments = buffer.split("\n\n");
        buffer = segments.pop() || "";

        for (const segment of segments) {
          const event = parseSseEvent(segment);

          if (event) {
            this.applySseEvent(assistantMessage.id, event.type, event.payload, trimmedQuestion);
          }
        }
      }

      this.completeAssistantMessage(assistantMessage.id);
    } catch (error: unknown) {
      if ((error as Error).name === "AbortError") {
        this.patchMessage(assistantMessage.id, (message) => ({
          ...message,
          content: message.content || "Generation stopped.",
          status: "complete"
        }));
        return;
      }

      this.toastSubject.next("Network error while streaming the response.");
      this.failAssistantMessage(
        assistantMessage.id,
        "Network error. Please retry once the connection is stable.",
        trimmedQuestion
      );
    } finally {
      this.isStreamingSubject.next(false);
      this.activeAssistantIdSubject.next(null);
      this.abortController = null;
    }
  }

  stopStreaming(): void {
    this.abortController?.abort();
  }

  clearConversation(): void {
    this.messagesSubject.next([]);
    this.isStreamingSubject.next(false);
    this.activeAssistantIdSubject.next(null);
    this.abortController = null;
  }

  retryQuestion(question: string, sessionId: string): Promise<void> {
    return this.sendMessage(question, sessionId);
  }

  dismissToast(): void {
    this.toastSubject.next(null);
  }

  private applySseEvent(
    assistantId: string,
    eventType: string,
    payload: SseEventPayload,
    question: string
  ): void {
    switch (eventType) {
      case "chunk":
        this.patchMessage(assistantId, (message) => ({
          ...message,
          content: `${message.content}${payload.content || ""}`,
          status: "streaming"
        }));
        break;
      case "sources":
        this.patchMessage(assistantId, (message) => ({
          ...message,
          sources: payload.sources || []
        }));
        break;
      case "error":
        this.toastSubject.next(payload.error || "AI response failed.");
        this.failAssistantMessage(assistantId, payload.error || "AI response failed.", question);
        break;
      case "done":
        this.completeAssistantMessage(assistantId);
        break;
      default:
        break;
    }
  }

  private failAssistantMessage(assistantId: string, error: string, question: string): void {
    this.patchMessage(assistantId, (message) => ({
      ...message,
      content: message.content || error,
      status: "error",
      retryQuestion: question
    }));
  }

  private completeAssistantMessage(assistantId: string): void {
    this.patchMessage(assistantId, (message) => ({
      ...message,
      status: message.status === "error" ? "error" : "complete"
    }));
  }

  private patchMessage(
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage
  ): void {
    this.messagesSubject.next(
      this.messagesSubject.value.map((message) =>
        message.id === messageId ? updater(message) : message
      )
    );
  }
}

function parseSseEvent(
  segment: string
): { type: string; payload: SseEventPayload } | null {
  const lines = segment
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const eventLine = lines.find((line) => line.startsWith("event:"));
  const dataLines = lines.filter((line) => line.startsWith("data:"));

  if (!eventLine || !dataLines.length) {
    return null;
  }

  const type = eventLine.replace("event:", "").trim();
  const data = dataLines.map((line) => line.replace("data:", "").trim()).join("");

  return {
    type,
    payload: JSON.parse(data) as SseEventPayload
  };
}
