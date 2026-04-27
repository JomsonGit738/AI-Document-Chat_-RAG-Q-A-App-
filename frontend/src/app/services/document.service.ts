import {
  HttpClient,
  HttpErrorResponse,
  HttpEvent,
  HttpEventType,
  HttpResponse
} from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { BehaviorSubject, EMPTY, of } from "rxjs";
import { catchError, filter, map, tap } from "rxjs/operators";
import { environment } from "../../environments/environment";
import { AsyncStatus, DocumentSession, UploadResponse } from "../models/docchat.models";

@Injectable({
  providedIn: "root"
})
export class DocumentService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = environment.apiBaseUrl;

  private readonly documentSubject = new BehaviorSubject<DocumentSession | null>(null);
  private readonly uploadStatusSubject = new BehaviorSubject<AsyncStatus>("idle");
  private readonly uploadProgressSubject = new BehaviorSubject<number>(0);
  private readonly uploadErrorSubject = new BehaviorSubject<string | null>(null);
  private readonly toastSubject = new BehaviorSubject<string | null>(null);
  private readonly sessionExpiredSubject = new BehaviorSubject<boolean>(false);

  readonly document$ = this.documentSubject.asObservable();
  readonly uploadStatus$ = this.uploadStatusSubject.asObservable();
  readonly uploadProgress$ = this.uploadProgressSubject.asObservable();
  readonly uploadError$ = this.uploadErrorSubject.asObservable();
  readonly toast$ = this.toastSubject.asObservable();
  readonly sessionExpired$ = this.sessionExpiredSubject.asObservable();

  queueUpload(file: File): void {
    this.performUpload(file).subscribe();
  }

  removeCurrentDocument(): void {
    const current = this.documentSubject.value;

    if (!current) {
      this.resetState();
      return;
    }

    this.http
      .delete(`${this.apiBaseUrl}/api/session/${current.sessionId}`)
      .pipe(
        catchError(() => of(null)),
        tap(() => this.resetState())
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

  private performUpload(file: File) {
    this.uploadStatusSubject.next("loading");
    this.uploadProgressSubject.next(0);
    this.uploadErrorSubject.next(null);
    this.sessionExpiredSubject.next(false);

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
            this.uploadProgressSubject.next(Math.round((100 * event.loaded) / total));
          }
        }),
        filter(
          (event: HttpEvent<UploadResponse>): event is HttpResponse<UploadResponse> =>
            event.type === HttpEventType.Response
        ),
        map((event: HttpResponse<UploadResponse>) => event.body as UploadResponse),
        tap((response: UploadResponse) => {
          const previousSessionId = this.documentSubject.value?.sessionId;
          this.revokeCurrentObjectUrl();
          const nextSession: DocumentSession = {
            sessionId: response.sessionId,
            fileName: response.document.fileName,
            fileSize: response.document.fileSize,
            pageCount: response.document.pageCount,
            uploadedAt: response.document.uploadedAt,
            excerpt: response.excerpt,
            starterQuestions: response.starterQuestions,
            summary: response.summary,
            objectUrl: URL.createObjectURL(file)
          };

          this.documentSubject.next(nextSession);
          this.uploadProgressSubject.next(100);
          this.uploadStatusSubject.next("success");

          if (previousSessionId && previousSessionId !== nextSession.sessionId) {
            this.cleanupRemoteSession(previousSessionId);
          }
        }),
        catchError((error: HttpErrorResponse) => {
          const message = resolveUploadError(error);
          this.uploadStatusSubject.next("error");
          this.uploadErrorSubject.next(message);

          if (error.status === 0) {
            this.toastSubject.next("Network error while uploading. Check the backend connection.");
          }

          return EMPTY;
        })
      );
  }

  private revokeCurrentObjectUrl(): void {
    const current = this.documentSubject.value;

    if (current?.objectUrl) {
      URL.revokeObjectURL(current.objectUrl);
    }
  }

  private cleanupRemoteSession(sessionId: string): void {
    this.http
      .delete(`${this.apiBaseUrl}/api/session/${sessionId}`)
      .pipe(catchError(() => EMPTY))
      .subscribe();
  }

  private resetState(): void {
    this.revokeCurrentObjectUrl();
    this.documentSubject.next(null);
    this.uploadStatusSubject.next("idle");
    this.uploadProgressSubject.next(0);
    this.uploadErrorSubject.next(null);
    this.sessionExpiredSubject.next(false);
  }
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
