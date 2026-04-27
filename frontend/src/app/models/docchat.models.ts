export interface UploadResponse {
  sessionId: string;
  document: {
    fileName: string;
    fileSize: number;
    pageCount: number;
    uploadedAt: string;
  };
  excerpt: string;
  starterQuestions: string[];
}

export interface DocumentSession {
  sessionId: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  uploadedAt: string;
  excerpt: string;
  starterQuestions: string[];
  objectUrl: string;
}

export interface SourceChunk {
  id: number;
  label: string;
  excerpt: string;
  score: number;
}

export type MessageRole = "user" | "assistant";
export type MessageStatus = "loading" | "streaming" | "complete" | "error";
export type AsyncStatus = "idle" | "loading" | "success" | "error";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status: MessageStatus;
  sources: SourceChunk[];
  retryQuestion?: string;
}

export interface SseEventPayload {
  content?: string;
  sources?: SourceChunk[];
  error?: string;
  complete?: boolean;
}

