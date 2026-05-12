import { Injectable } from "@angular/core";
import { jsPDF } from "jspdf";
import { ChatMessage, DocumentInfo, MessageSource } from "../models/docchat.models";

interface ChatExportBlock {
  question: string;
  answer: string;
  sources: MessageSource[];
}

@Injectable({
  providedIn: "root"
})
export class ExportService {
  private readonly pageWidth = 210;
  private readonly pageHeight = 297;
  private readonly margin = 20;
  private readonly contentWidth = this.pageWidth - this.margin * 2;
  private readonly headerHeight = 16;
  private readonly footerHeight = 12;
  private readonly lineHeight = 6;
  private readonly blockSpacing = 10;
  private readonly colors = {
    indigo: [45, 92, 58] as const,
    dark: [61, 52, 39] as const,
    muted: [111, 103, 92] as const,
    divider: [213, 205, 191] as const
  };

  exportChatAsPDF(messages: ChatMessage[], documents: DocumentInfo[]): void {
    const blocks = this.buildBlocks(messages);

    if (!blocks.length) {
      return;
    }

    const doc = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4"
    });
    const now = new Date();
    const exportDate = this.formatDate(now);
    const exportTimestamp = this.formatTimestamp(now);
    const fileDate = this.formatFileDate(now);
    let cursorY = this.drawPageHeader(doc, exportDate);

    cursorY = this.drawDocumentInfo(doc, documents, exportTimestamp, cursorY);

    for (const block of blocks) {
      cursorY = this.drawBlock(doc, block, cursorY, exportDate);
    }

    this.drawFooters(doc);
    doc.save(`docchat-export-${fileDate}.pdf`);
  }

  private buildBlocks(messages: ChatMessage[]): ChatExportBlock[] {
    const blocks: ChatExportBlock[] = [];
    let pendingQuestion: ChatMessage | null = null;

    for (const message of messages) {
      if (message.role === "user") {
        pendingQuestion = message;
        continue;
      }

      if (message.role !== "assistant" || !pendingQuestion) {
        continue;
      }

      const question = pendingQuestion.content.trim();
      const answer = message.content.trim();

      if (question && answer) {
        blocks.push({
          question,
          answer,
          sources: message.sources ?? []
        });
      }

      pendingQuestion = null;
    }

    return blocks;
  }

  private drawPageHeader(doc: jsPDF, exportDate: string): number {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(...this.colors.indigo);
    doc.text("DocChat", this.margin, this.margin);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...this.colors.muted);
    doc.text(exportDate, this.pageWidth - this.margin, this.margin, { align: "right" });

    const dividerY = this.margin + 6;
    doc.setDrawColor(...this.colors.indigo);
    doc.setLineWidth(0.4);
    doc.line(this.margin, dividerY, this.pageWidth - this.margin, dividerY);

    return dividerY + 8;
  }

  private drawDocumentInfo(
    doc: jsPDF,
    documents: DocumentInfo[],
    exportTimestamp: string,
    startY: number
  ): number {
    let cursorY = startY;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...this.colors.muted);
    doc.text("Document(s):", this.margin, cursorY);
    cursorY += this.lineHeight;

    doc.setTextColor(...this.colors.dark);
    const fileNames = documents.length
      ? documents.map((document) => document.fileName)
      : ["Document information unavailable"];

    for (const fileName of fileNames) {
      const lines = doc.splitTextToSize(fileName, this.contentWidth) as string[];
      doc.text(lines, this.margin, cursorY);
      cursorY += lines.length * this.lineHeight;
    }

    doc.setTextColor(...this.colors.muted);
    doc.text(`Exported at: ${exportTimestamp}`, this.margin, cursorY);
    cursorY += this.lineHeight;

    doc.setDrawColor(...this.colors.divider);
    doc.setLineWidth(0.3);
    doc.line(this.margin, cursorY, this.pageWidth - this.margin, cursorY);

    return cursorY + 8;
  }

  private drawBlock(doc: jsPDF, block: ChatExportBlock, startY: number, exportDate: string): number {
    let cursorY = startY;
    const availableHeight = this.pageHeight - this.margin - this.footerHeight;

    const ensureSpace = (requiredHeight: number): void => {
      if (cursorY + requiredHeight <= availableHeight) {
        return;
      }

      doc.addPage();
      cursorY = this.drawPageHeader(doc, exportDate);
    };

    const questionLines = this.splitLines(doc, `[Q] ${block.question}`, 11, "bold");
    const answerLines = this.splitLines(doc, block.answer, 10, "normal");
    const minimumAnswerLines = Math.min(answerLines.length, 2);
    const questionIntroHeight =
      questionLines.length * this.lineHeight + 4 + minimumAnswerLines * this.lineHeight;

    // Keep the question label with the start of its answer, but let the rest flow across pages.
    ensureSpace(questionIntroHeight);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...this.colors.indigo);
    doc.text(questionLines, this.margin, cursorY);
    cursorY += questionLines.length * this.lineHeight + 4;

    for (const line of answerLines) {
      ensureSpace(this.lineHeight);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(...this.colors.dark);
      doc.text(line, this.margin, cursorY);
      cursorY += this.lineHeight;
    }

    cursorY += 4;

    if (block.sources.length) {
      ensureSpace(this.lineHeight);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...this.colors.muted);
      doc.text("Sources:", this.margin, cursorY);
      cursorY += this.lineHeight;

      for (const source of block.sources) {
        const sourceLines = this.splitLines(doc, this.formatSource(source), 8, "italic");

        for (const line of sourceLines) {
          ensureSpace(this.lineHeight);
          doc.setFont("helvetica", "italic");
          doc.setFontSize(8);
          doc.setTextColor(...this.colors.muted);
          doc.text(line, this.margin, cursorY);
          cursorY += this.lineHeight;
        }
      }

      cursorY += 4;
    }

    ensureSpace(4);
    doc.setDrawColor(...this.colors.divider);
    doc.setLineWidth(0.3);
    doc.line(this.margin, cursorY, this.pageWidth - this.margin, cursorY);

    return cursorY + this.blockSpacing;
  }

  private drawFooters(doc: jsPDF): void {
    const pageCount = doc.getNumberOfPages();

    for (let page = 1; page <= pageCount; page += 1) {
      doc.setPage(page);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...this.colors.muted);
      doc.text(`Page ${page} of ${pageCount}`, this.pageWidth / 2, this.pageHeight - 8, {
        align: "center"
      });
    }
  }

  private splitLines(
    doc: jsPDF,
    text: string,
    fontSize: number,
    fontStyle: "bold" | "normal" | "italic"
  ): string[] {
    doc.setFont("helvetica", fontStyle);
    doc.setFontSize(fontSize);
    return doc.splitTextToSize(text, this.contentWidth) as string[];
  }

  private formatSource(source: MessageSource): string {
    const excerpt = source.excerpt.trim() ? `"${source.excerpt.trim()}"` : '"Source excerpt unavailable"';
    return `Chunk #${source.chunkIndex} — ${excerpt} — Page ${source.pageNumber} — ${source.fileName}`;
  }

  private formatDate(date: Date): string {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    }).format(date);
  }

  private formatTimestamp(date: Date): string {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  private formatFileDate(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
