export interface UploadResponse {
  sessionId: string;
  fileName?: string;
  fileSize?: number;
  pageCount?: number;
  document: {
    fileName: string;
    fileSize: number;
    pageCount: number;
    uploadedAt: string;
  };
  excerpt: string;
  starterQuestions: string[];
  summary: string[];
}

export interface DocumentSession {
  sessionId: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  uploadedAt: string;
  excerpt: string;
  starterQuestions: string[];
  summary: string[];
  objectUrl: string;
}

export interface MessageSource {
  chunkIndex: number;
  excerpt: string;
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
  sources?: MessageSource[];
  retryQuestion?: string;
}

export interface SseEventPayload {
  content?: string;
  sources?: MessageSource[];
  error?: string;
  complete?: boolean;
}
