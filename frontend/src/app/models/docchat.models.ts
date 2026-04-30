export interface DocumentSummary {
  overview: string;
  bullets: string[];
}

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
  summary: DocumentSummary;
}

export interface DocumentSession {
  sessionId: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  uploadedAt: string;
  excerpt: string;
  starterQuestions: string[];
  summary: DocumentSummary;
  objectUrl: string;
}

export interface MessageSource {
  chunkIndex: number;
  excerpt: string;
  pageNumber: number;
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
  type?: string;
  content?: string;
  sources?: MessageSource[];
  error?: string;
  complete?: boolean;
}
