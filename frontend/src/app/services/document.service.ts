import {
  HttpClient,
  HttpErrorResponse,
  HttpEvent,
  HttpEventType,
  HttpResponse
} from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { BehaviorSubject, EMPTY, Observable, of, throwError } from "rxjs";
import { catchError, filter, finalize, map, switchMap, tap } from "rxjs/operators";
import { environment } from "../../environments/environment";
import {
  AsyncStatus,
  CombinedSessionResponse,
  DocumentInfo,
  DocumentSession,
  UploadProgressInfo,
  UploadResponse
} from "../models/docchat.models";

const MAX_DOCUMENTS = 5;

@Injectable({
  providedIn: "root"
})
export class DocumentService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = environment.apiBaseUrl;
  private readonly pendingUploads: File[] = [];
  private isProcessingQueue = false;

  private readonly documentSubject = new BehaviorSubject<DocumentSession | null>(null);
  private readonly uploadStatusSubject = new BehaviorSubject<AsyncStatus>("idle");
  private readonly uploadProgressSubject = new BehaviorSubject<number>(0);
  private readonly uploadTargetSubject = new BehaviorSubject<UploadProgressInfo | null>(null);
  private readonly uploadErrorSubject = new BehaviorSubject<string | null>(null);
  private readonly toastSubject = new BehaviorSubject<string | null>(null);
  private readonly sessionExpiredSubject = new BehaviorSubject<boolean>(false);

  readonly document$ = this.documentSubject.asObservable();
  readonly uploadStatus$ = this.uploadStatusSubject.asObservable();
  readonly uploadProgress$ = this.uploadProgressSubject.asObservable();
  readonly uploadTarget$ = this.uploadTargetSubject.asObservable();
  readonly uploadError$ = this.uploadErrorSubject.asObservable();
  readonly toast$ = this.toastSubject.asObservable();
  readonly sessionExpired$ = this.sessionExpiredSubject.asObservable();

  showToast(message: string): void {
    const trimmedMessage = message.trim();

    if (!trimmedMessage) {
      return;
    }

    this.toastSubject.next(trimmedMessage);
  }

  queueUpload(file: File): void {
    this.pendingUploads.push(file);
    this.processUploadQueue();
  }

  uploadDocument(file: File): void {
    this.queueUpload(file);
  }

  removeCurrentDocument(): void {
    const current = this.documentSubject.value;

    if (!current) {
      this.resetState();
      return;
    }

    const sessionIdsToDelete = current.sessionIds.map((sessionId) =>
      this.http.delete(`${this.apiBaseUrl}/api/session/${sessionId}`).pipe(catchError(() => of(null)))
    );

    sessionIdsToDelete.forEach((request) => request.subscribe());
    this.resetState();
  }

  removeDocument(sessionId: string): void {
    const current = this.documentSubject.value;

    if (!current) {
      return;
    }

    const remainingDocuments = current.documents.filter((document) => document.sessionId !== sessionId);

    if (remainingDocuments.length === current.documents.length) {
      return;
    }

    this.uploadErrorSubject.next(null);
    this.sessionExpiredSubject.next(false);

    if (!remainingDocuments.length) {
      this.http
        .delete(`${this.apiBaseUrl}/api/session/${sessionId}`)
        .pipe(
          tap(() => this.resetState()),
          catchError((error: HttpErrorResponse) => {
            this.handleDocumentMutationError(error, "Unable to remove this document right now.");
            return EMPTY;
          })
        )
        .subscribe();
      return;
    }

    this.combineSessions(remainingDocuments.map((document) => document.sessionId))
      .pipe(
        switchMap((combined) =>
          this.http.delete(`${this.apiBaseUrl}/api/session/${sessionId}`).pipe(
            tap(() => {
              const nextSession = buildDocumentSession(
                remainingDocuments,
                combined.combinedSessionId
              );
              this.documentSubject.next(nextSession);
              this.uploadStatusSubject.next("success");
            }),
            catchError((error: HttpErrorResponse) => {
              this.cleanupRemoteSession(combined.combinedSessionId);
              this.handleDocumentMutationError(error, "Unable to remove this document right now.");
              return EMPTY;
            })
          )
        ),
        catchError((error: HttpErrorResponse) => {
          this.handleDocumentMutationError(error, "Unable to rebuild the document workspace.");
          return EMPTY;
        })
      )
      .subscribe();
  }

  dismissToast(): void {
    this.toastSubject.next(null);
  }

  clearSessionExpiredBanner(): void {
    this.sessionExpiredSubject.next(false);
  }

  markSessionExpired(): void {
    this.sessionExpiredSubject.next(true);
  }

  private performUpload(file: File): Observable<DocumentSession> {
    const currentSession = this.documentSubject.value;

    if ((currentSession?.documents.length || 0) >= MAX_DOCUMENTS) {
      const message = `You can upload up to ${MAX_DOCUMENTS} documents at a time.`;
      this.uploadStatusSubject.next("error");
      this.uploadErrorSubject.next(message);
      this.showToast(message);
      return EMPTY;
    }

    this.uploadStatusSubject.next("loading");
    this.uploadProgressSubject.next(0);
    this.uploadErrorSubject.next(null);
    this.sessionExpiredSubject.next(false);
    this.uploadTargetSubject.next({
      fileName: file.name,
      fileSize: file.size,
      progress: 0
    });

    const formData = new FormData();
    formData.append("file", file);

    return this.http
      .post<UploadResponse>(`${this.apiBaseUrl}/api/upload`, formData, {
        observe: "events",
        reportProgress: true
      })
      .pipe(
        tap((event: HttpEvent<UploadResponse>) => {
          if (event.type === HttpEventType.UploadProgress) {
            const total = event.total || file.size || 1;
            const progress = Math.round((100 * event.loaded) / total);
            this.uploadProgressSubject.next(progress);
            this.uploadTargetSubject.next({
              fileName: file.name,
              fileSize: file.size,
              progress
            });
          }
        }),
        filter(
          (event: HttpEvent<UploadResponse>): event is HttpResponse<UploadResponse> =>
            event.type === HttpEventType.Response
        ),
        map((event: HttpResponse<UploadResponse>) => event.body as UploadResponse),
        switchMap((response: UploadResponse) => this.addDocument(response)),
        tap((nextSession: DocumentSession) => {
          const previousActiveSessionId = this.documentSubject.value?.activeSessionId;
          this.documentSubject.next(nextSession);
          this.uploadProgressSubject.next(100);
          this.uploadStatusSubject.next("success");
          this.uploadTargetSubject.next(null);

          if (
            previousActiveSessionId &&
            previousActiveSessionId !== nextSession.activeSessionId &&
            !nextSession.sessionIds.includes(previousActiveSessionId)
          ) {
            this.cleanupRemoteSession(previousActiveSessionId);
          }
        }),
        catchError((error: HttpErrorResponse) => {
          const message = resolveUploadError(error);
          this.uploadStatusSubject.next("error");
          this.uploadErrorSubject.next(message);
          this.uploadTargetSubject.next(null);
          this.showToast(message);

          if (error.status === 0) {
            this.showToast("Network error while uploading. Check the backend connection.");
          }

          return EMPTY;
        })
      );
  }

  private processUploadQueue(): void {
    if (this.isProcessingQueue) {
      return;
    }

    const nextFile = this.pendingUploads.shift();

    if (!nextFile) {
      return;
    }

    this.isProcessingQueue = true;
    this.performUpload(nextFile)
      .pipe(
        finalize(() => {
          this.isProcessingQueue = false;
          this.processUploadQueue();
        })
      )
      .subscribe();
  }

  private addDocument(response: UploadResponse): Observable<DocumentSession> {
    const currentDocuments = this.documentSubject.value?.documents || [];
    const nextDocuments = [
      ...currentDocuments,
      buildDocumentInfo(response)
    ];

    return this.combineSessions(nextDocuments.map((document) => document.sessionId)).pipe(
      map((combined: CombinedSessionResponse) =>
        buildDocumentSession(nextDocuments, combined.combinedSessionId)
      ),
      catchError((error: HttpErrorResponse) => {
        this.cleanupRemoteSession(response.sessionId);
        return throwError(() => error);
      })
    );
  }

  private combineSessions(sessionIds: string[]): Observable<CombinedSessionResponse> {
    return this.http.post<CombinedSessionResponse>(`${this.apiBaseUrl}/api/session/combine`, {
      sessionIds
    });
  }

  private cleanupRemoteSession(sessionId: string): void {
    this.http
      .delete(`${this.apiBaseUrl}/api/session/${sessionId}`)
      .pipe(catchError(() => EMPTY))
      .subscribe();
  }

  private handleDocumentMutationError(error: HttpErrorResponse, fallbackMessage: string): void {
    const message = resolveMutationError(error, fallbackMessage);
    this.uploadStatusSubject.next("error");
    this.uploadErrorSubject.next(message);
    this.showToast(message);

    if (error.status === 404) {
      this.sessionExpiredSubject.next(true);
    }
  }

  private resetState(): void {
    this.documentSubject.next(null);
    this.uploadStatusSubject.next("idle");
    this.uploadProgressSubject.next(0);
    this.uploadTargetSubject.next(null);
    this.uploadErrorSubject.next(null);
    this.sessionExpiredSubject.next(false);
  }
}

function buildDocumentInfo(response: UploadResponse): DocumentInfo {
  return {
    sessionId: response.sessionId,
    fileName: response.document.fileName,
    fileSize: response.document.fileSize,
    pageCount: response.document.pageCount,
    uploadedAt: response.document.uploadedAt,
    summary: response.summary,
    starterQuestions: response.starterQuestions
  };
}

function buildDocumentSession(documents: DocumentInfo[], activeSessionId: string): DocumentSession {
  return {
    sessionIds: documents.map((document) => document.sessionId),
    activeSessionId,
    documents,
    isCombined: documents.length > 1
  };
}

function resolveUploadError(error: HttpErrorResponse): string {
  if (typeof error.error?.error === "string") {
    return error.error.error;
  }

  if (error.status === 0) {
    return "Unable to reach the API. Please confirm the backend is running.";
  }

  return "Upload failed. Please try again with a valid PDF.";
}

function resolveMutationError(error: HttpErrorResponse, fallbackMessage: string): string {
  if (typeof error.error?.error === "string") {
    return error.error.error;
  }

  if (error.status === 0) {
    return "Unable to reach the API. Please confirm the backend is running.";
  }

  return fallbackMessage;
}
