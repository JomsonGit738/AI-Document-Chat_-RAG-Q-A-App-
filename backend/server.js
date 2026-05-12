require("dotenv").config();

const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const multer = require("multer");
const pdf = require("pdf-parse");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 10 * 1024 * 1024);
const MAX_QUESTION_LENGTH = Number(process.env.MAX_QUESTION_LENGTH || 500);
// This flag lets .env choose the active provider without changing any frontend or API flow.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "groq").trim().toLowerCase();
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:4200")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const MAX_DOCUMENTS_PER_SESSION = 5;
const sessions = new Map();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by CORS"));
    },
  }),
);
app.use(express.json({ limit: "1mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a minute and try again.",
  },
});

app.use("/api", limiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter(_req, file, callback) {
    const isPdfMime = file.mimetype === "application/pdf";
    const isPdfName = file.originalname.toLowerCase().endsWith(".pdf");

    if (isPdfMime || isPdfName) {
      callback(null, true);
      return;
    }

    const validationError = new Error("Only PDF files are supported.");
    validationError.name = "InvalidFileTypeError";
    callback(validationError);
  },
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: sessions.size,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, async (error) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB.`,
          });
          return;
        }

        res.status(400).json({
          error: "Upload failed. Please use a valid PDF file.",
        });
        return;
      }

      if (error.name === "InvalidFileTypeError") {
        res.status(400).json({
          error: "Only PDF files are supported.",
        });
        return;
      }

      res.status(500).json({
        error: "Upload failed unexpectedly. Please try again.",
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({
        error: "No PDF file was provided.",
      });
      return;
    }

    try {
      const pageTexts = [];
      const parsed = await pdf(req.file.buffer, {
        pagerender: async (pageData) => {
          const textContent = await pageData.getTextContent({
            normalizeWhitespace: true,
            disableCombineTextItems: false,
          });
          const pageText = normalizeWhitespace(
            textContent.items.map((item) => item.str || "").join(" "),
          );

          pageTexts.push(pageText);
          return pageText;
        },
      });
      const rawText = normalizeWhitespace(pageTexts.filter(Boolean).join(" "));

      if (!rawText) {
        res.status(400).json({
          error: "This PDF does not contain selectable text.",
        });
        return;
      }

      const sessionId = crypto.randomUUID();
      const uploadedAt = new Date().toISOString();
      const chunks = buildPageAwareChunks(pageTexts, 500, 50).map(
        (chunk, index) => ({
          id: index + 1,
          label: `Chunk ${index + 1}`,
          text: chunk.text,
          pageNumber: chunk.pageNumber,
          vector: buildTermFrequency(chunk.text),
          fileName: req.file.originalname,
          originalSessionId: sessionId,
        }),
      );
      const excerpt = rawText.slice(0, 200);
      const meaningfulPages = pageTexts.filter((page) => page.trim().length > 200);
      const totalPages = meaningfulPages.length;
      const midPoint = Math.floor(totalPages / 2);
      const samplePages = [
        ...meaningfulPages.slice(0, 3),
        ...meaningfulPages.slice(midPoint, midPoint + 3),
        ...meaningfulPages.slice(-2),
      ];
      const sampleText = samplePages.join(" ").substring(0, 3000);

      sessions.set(sessionId, {
        id: sessionId,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        pageCount: parsed.numpages || 0,
        uploadedAt,
        rawText,
        chunks,
      });
      const summary = await generateDocumentSummary(sampleText);
      const starterQuestions = await generateStarterQuestions(sampleText);
      const session = sessions.get(sessionId);

      if (session) {
        session.summary = summary.bullets;
      }

      res.status(201).json({
        sessionId,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        pageCount: parsed.numpages || 0,
        document: {
          fileName: req.file.originalname,
          fileSize: req.file.size,
          pageCount: parsed.numpages || 0,
          uploadedAt,
        },
        excerpt,
        starterQuestions,
        summary,
      });
    } catch (parseError) {
      res.status(400).json({
        error:
          "Unable to read this PDF. Please upload a text-based PDF document.",
      });
    }
  });
});

app.post("/api/session/combine", (req, res) => {
  const { sessionIds } = req.body || {};

  if (!Array.isArray(sessionIds) || !sessionIds.length) {
    res.status(400).json({
      error: "sessionIds must be a non-empty array.",
    });
    return;
  }

  if (sessionIds.length > MAX_DOCUMENTS_PER_SESSION) {
    res.status(400).json({
      error: `You can combine up to ${MAX_DOCUMENTS_PER_SESSION} documents at a time.`,
    });
    return;
  }

  const uniqueSessionIds = Array.from(
    new Set(
      sessionIds.filter(
        (sessionId) => typeof sessionId === "string" && sessionId.trim(),
      ),
    ),
  );

  if (!uniqueSessionIds.length) {
    res.status(400).json({
      error: "sessionIds must contain valid session ids.",
    });
    return;
  }

  const sourceSessions = [];

  for (const sessionId of uniqueSessionIds) {
    const session = sessions.get(sessionId);

    if (!session || session.isCombined) {
      res.status(404).json({
        error: `Session not found: ${sessionId}`,
      });
      return;
    }

    sourceSessions.push(session);
  }

  const combinedSessionId = crypto.randomUUID();
  const mergedChunks = sourceSessions.flatMap((session) =>
    session.chunks.map((chunk) => ({
      ...chunk,
      fileName: chunk.fileName || session.fileName,
      originalSessionId: chunk.originalSessionId || session.id,
    })),
  );
  const chunks = mergedChunks.map((chunk, index) => ({
    ...chunk,
    id: index + 1,
    label: `Chunk ${index + 1}`,
  }));
  const documents = sourceSessions.map((session) => ({
    sessionId: session.id,
    fileName: session.fileName,
    fileSize: session.fileSize,
    pageCount: session.pageCount,
    uploadedAt: session.uploadedAt,
    summary: session.summary || [],
  }));

  sessions.set(combinedSessionId, {
    id: combinedSessionId,
    isCombined: true,
    documents,
    chunks,
  });

  res.status(201).json({
    combinedSessionId,
    documentCount: documents.length,
    totalChunks: chunks.length,
  });
});

app.post("/api/chat", async (req, res) => {
  const { question, sessionId } = req.body || {};

  if (!question || typeof question !== "string") {
    res.status(400).json({
      error: "A question is required.",
    });
    return;
  }

  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    res.status(400).json({
      error: "A question is required.",
    });
    return;
  }

  if (trimmedQuestion.length > MAX_QUESTION_LENGTH) {
    res.status(400).json({
      error: `Questions must be ${MAX_QUESTION_LENGTH} characters or fewer.`,
    });
    return;
  }

  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({
      error: "A sessionId is required.",
    });
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    res.status(404).json({
      error: "Session not found. Please re-upload your document.",
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (isSummaryIntent(trimmedQuestion)) {
    const summaryResponse = session.documents
      ? session.documents
          .map((doc) => `**${doc.fileName}**:\n${(doc.summary || []).join("\n")}`)
          .join("\n\n")
      : `**${session.fileName}**:\n${(session.summary || []).join("\n")}`;

    sendEvent(res, "chunk", {
      content: summaryResponse,
    });
    sendEvent(res, "sources", { sources: [] });
    sendEvent(res, "done", { complete: true });
    res.end();
    return;
  }

  const topChunks = rankChunks(trimmedQuestion, session.chunks).slice(0, 3);
  const sourceMetadata = topChunks.map((chunk) => ({
    chunkIndex: chunk.id,
    excerpt: truncate(chunk.text, 80),
    pageNumber: chunk.pageNumber,
    fileName: chunk.fileName || session.fileName,
  }));

  const activeProvider = getActiveProvider();

  if (!activeProvider) {
    sendEvent(res, "error", {
      error: getProviderConfigurationError(),
    });
    sendEvent(res, "done", { complete: true });
    res.end();
    return;
  }

  const systemPrompt =
    "You are a document assistant. Answer ONLY from the provided document context. If the answer isn't in the context, say so clearly. Be concise and precise.";
  const context = topChunks
    .map((chunk) => `[${chunk.label}]\n${chunk.text}`)
    .join("\n");

  try {
    // Keep the existing SSE flow intact while swapping only the underlying model provider.
    await streamChatAnswer({
      provider: activeProvider,
      systemPrompt,
      context,
      question: trimmedQuestion,
      onChunk(delta) {
        sendEvent(res, "chunk", {
          content: delta,
        });
      },
    });

    sendEvent(res, "done", { complete: true });
    sendEvent(res, "sources", {
      sources: sourceMetadata,
    });
    res.end();
  } catch (providerError) {
    console.error(
      `${activeProvider} API request failed:`,
      summarizeProviderError(providerError),
    );

    sendEvent(res, "error", {
      error: resolveProviderErrorMessage(providerError, activeProvider),
    });
    sendEvent(res, "done", { complete: true });
    sendEvent(res, "sources", {
      sources: sourceMetadata,
    });
    res.end();
  }
});

app.delete("/api/session/:id", (req, res) => {
  const sessionId = req.params.id;
  const deleted = sessions.delete(sessionId);

  if (!deleted) {
    res.status(404).json({
      error: "Session not found.",
    });
    return;
  }

  const combinedSessionIdsToDelete = [];

  for (const [id, session] of sessions.entries()) {
    if (
      session.isCombined &&
      Array.isArray(session.documents) &&
      session.documents.some((document) => document.sessionId === sessionId)
    ) {
      combinedSessionIdsToDelete.push(id);
    }
  }

  for (const combinedSessionId of combinedSessionIdsToDelete) {
    sessions.delete(combinedSessionId);
  }

  res.status(204).send();
});

app.use((error, _req, res, _next) => {
  if (error.message === "Origin not allowed by CORS") {
    res.status(403).json({
      error: "This origin is not allowed to access the API.",
    });
    return;
  }

  res.status(500).json({
    error: "Unexpected server error.",
  });
});

app.listen(PORT);

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function splitIntoChunks(text, chunkSize, overlap) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let start = 0;

  while (start < tokens.length) {
    const end = Math.min(start + chunkSize, tokens.length);
    chunks.push(tokens.slice(start, end).join(" "));

    if (end === tokens.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function buildPageAwareChunks(pageTexts, chunkSize, overlap) {
  const chunks = [];

  pageTexts.forEach((pageText, pageIndex) => {
    const normalizedPageText = normalizeWhitespace(pageText || "");

    if (!normalizedPageText) {
      return;
    }

    const pageChunks = splitIntoChunks(normalizedPageText, chunkSize, overlap);

    for (const text of pageChunks) {
      chunks.push({
        text,
        pageNumber: pageIndex + 1,
      });
    }
  });

  return chunks;
}

function buildTermFrequency(text) {
  const terms = new Map();
  const tokens = tokenize(text);

  for (const token of tokens) {
    terms.set(token, (terms.get(token) || 0) + 1);
  }

  return terms;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function rankChunks(question, chunks) {
  const queryVector = buildTermFrequency(question);
  const ranked = chunks.map((chunk) => {
    const cosineScore = cosineSimilarity(queryVector, chunk.vector);
    const overlapScore = keywordOverlap(queryVector, chunk.vector);
    const score = cosineScore * 0.7 + overlapScore * 0.3;

    return {
      ...chunk,
      score,
    };
  });

  return ranked.sort((left, right) => right.score - left.score);
}

function keywordOverlap(leftVector, rightVector) {
  const leftKeys = Array.from(leftVector.keys());

  if (!leftKeys.length) {
    return 0;
  }

  const matches = leftKeys.filter((key) => rightVector.has(key)).length;
  return matches / leftKeys.length;
}

function cosineSimilarity(leftVector, rightVector) {
  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (const value of leftVector.values()) {
    leftMagnitude += value * value;
  }

  for (const value of rightVector.values()) {
    rightMagnitude += value * value;
  }

  for (const [key, value] of leftVector.entries()) {
    dotProduct += value * (rightVector.get(key) || 0);
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);

  if (!denominator) {
    return 0;
  }

  return dotProduct / denominator;
}

async function generateStarterQuestions(excerpt) {
  const activeProvider = getActiveProvider();

  if (!excerpt || !activeProvider) {
    return [];
  }

  try {
    const prompt = `Read this document excerpt and generate exactly 3 specific questions that can be directly and completely answered from this text alone. Questions must be factual, specific, and answerable only from the provided content — not general knowledge. Return only a JSON array of 3 question strings, nothing else. Example format:
["What is X?", "How does Y work?", "What are the requirements for Z?"]

${excerpt}`;
    const rawResponse =
      activeProvider === "groq"
        ? await generateGroqJsonContent(prompt, {
            temperature: 0.4,
            maxTokens: 256,
          })
        : await generateGeminiJsonContent(prompt, {
            temperature: 0.4,
            maxTokens: 256,
          });
    const payload = parseJsonPayload(rawResponse, []);
    const questions = Array.isArray(payload)
      ? payload
          .filter((item) => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

    return questions.length === 3 ? questions : [];
  } catch (_error) {
    return [];
  }
}

async function generateDocumentSummary(excerpt) {
  const activeProvider = getActiveProvider();

  if (!activeProvider) {
    return fallbackDocumentSummary(excerpt);
  }

  try {
    const prompt = `Summarize this document in exactly 3 bullet points. Each bullet should be one clear sentence describing the main content, themes, or purpose of this document. Return only the 3 bullets, no intro text.

${excerpt}`;
    const rawResponse =
      activeProvider === "groq"
        ? await generateGroqTextContent(prompt, {
            temperature: 0.3,
            maxTokens: 320,
          })
        : await generateGeminiTextContent(prompt, {
            // Gemini behaves better for summaries with a lower temperature and stricter wording.
            temperature: 0.1,
            maxTokens: 320,
          });
    const bullets = rawResponse
      .split("\n")
      .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 3);

    return bullets.length === 3
      ? { overview: "", bullets }
      : fallbackDocumentSummary(excerpt);
  } catch (_error) {
    return fallbackDocumentSummary(excerpt);
  }
}

function getActiveProvider() {
  if (LLM_PROVIDER === "groq") {
    return groq ? "groq" : null;
  }

  if (LLM_PROVIDER === "gemini") {
    return gemini ? "gemini" : null;
  }

  return null;
}

function getProviderConfigurationError() {
  if (LLM_PROVIDER === "gemini") {
    return "The AI service is not configured yet. Add GEMINI_API_KEY on the backend or switch LLM_PROVIDER back to groq.";
  }

  if (LLM_PROVIDER === "groq") {
    return "The AI service is not configured yet. Add GROQ_API_KEY on the backend or switch LLM_PROVIDER to gemini.";
  }

  return 'The AI service is not configured yet. Set LLM_PROVIDER to "groq" or "gemini" and provide the matching API key.';
}

async function generateGroqJsonContent(
  prompt,
  { temperature, maxTokens, responseFormat } = {},
) {
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });

  return completion.choices?.[0]?.message?.content || "";
}

async function generateGeminiJsonContent(prompt, { temperature, maxTokens } = {}) {
  const model = gemini.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  });
  const result = await model.generateContent(prompt);

  return result.response.text();
}

async function generateGroqTextContent(prompt, { temperature, maxTokens } = {}) {
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature,
    max_tokens: maxTokens,
  });

  return completion.choices?.[0]?.message?.content || "";
}

async function generateGeminiTextContent(prompt, { temperature, maxTokens } = {}) {
  const model = gemini.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  });
  const result = await model.generateContent(prompt);

  return result.response.text();
}

function parseJsonPayload(rawResponse, fallbackValue) {
  if (!rawResponse || typeof rawResponse !== "string") {
    return fallbackValue;
  }

  const trimmed = rawResponse.trim();

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    // Gemini can occasionally wrap valid JSON in code fences or prepend a short note.
    // Extract the first JSON-looking object/array so the existing API flow stays stable.
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fencedMatch?.[1]?.trim() || extractJsonCandidate(trimmed);

    if (!candidate) {
      return fallbackValue;
    }

    try {
      return JSON.parse(candidate);
    } catch (_nestedError) {
      return fallbackValue;
    }
  }
}

function extractJsonCandidate(value) {
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");

  if (objectStart !== -1 && objectEnd > objectStart) {
    return value.slice(objectStart, objectEnd + 1);
  }

  const arrayStart = value.indexOf("[");
  const arrayEnd = value.lastIndexOf("]");

  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return value.slice(arrayStart, arrayEnd + 1);
  }

  return "";
}

async function streamChatAnswer({ provider, systemPrompt, context, question, onChunk }) {
  if (provider === "groq") {
    const stream = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion: ${question}`,
        },
      ],
      stream: true,
      max_tokens: 1024,
    });

    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content || "";

      if (delta) {
        onChunk(delta);
      }
    }

    return;
  }

  const model = gemini.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
    },
  });
  const result = await model.generateContentStream(
    [
      systemPrompt,
      "",
      `Context:\n${context}`,
      `Question: ${question}`,
    ].join("\n\n"),
  );

  for await (const chunk of result.stream) {
    const delta = chunk.text();

    if (delta) {
      onChunk(delta);
    }
  }
}

function fallbackStarterQuestions(excerpt) {
  const nouns = excerpt
    .split(/[.?!]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 2);
  const topic = nouns[0] || "this document";
  const secondary = nouns[1] || "the main topic";

  return [
    `What are the main takeaways from ${topic.toLowerCase()}?`,
    `Can you summarize the section about ${secondary.toLowerCase()}?`,
    "Which details in this document matter most?",
  ];
}

function isSummaryIntent(question) {
  const normalized = question.toLowerCase();

  return (
    normalized.includes("summary") ||
    normalized.includes("summarize") ||
    normalized.includes("summarise") ||
    normalized.includes("overview") ||
    normalized.includes("what is this document") ||
    normalized.includes("what are these documents") ||
    normalized.includes("what is this about")
  );
}

function fallbackDocumentSummary(excerpt) {
  const sentences = excerpt
    .split(/[.?!]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 5);

  const overview = sentences.slice(0, 2).join(". ").replace(/\s+/g, " ").trim();
  const bullets = sentences.slice(0, 4);

  while (bullets.length < 3) {
    bullets.push(
      "This document contains additional details that can be explored in chat",
    );
  }

  return {
    overview: overview
      ? `${overview}.`
      : "This document contains key details that can be explored in chat.",
    bullets: bullets.map(
      (sentence) => `${sentence.replace(/\s+/g, " ").trim()}.`,
    ),
  };
}

function sendEvent(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  const sliced = value.slice(0, maxLength + 1);
  const boundaryIndex = sliced.lastIndexOf(" ");
  const safeSlice = (
    boundaryIndex > 0
      ? sliced.slice(0, boundaryIndex)
      : value.slice(0, maxLength)
  )
    .trim()
    .replace(/[.,;:!?-]+$/g, "");

  return `${safeSlice}...`;
}

function resolveGroqErrorMessage(error, model) {
  const status = error?.status;
  const code = error?.code || error?.error?.code;
  const message = error?.message || "";

  if (status === 401) {
    return "Groq API error: the API key was rejected. Check GROQ_API_KEY in backend/.env and restart the server.";
  }

  if (status === 403) {
    return `Groq API error: access to model "${model}" was denied. Confirm your API key can use this model.`;
  }

  if (status === 429 || code === "rate_limit_exceeded") {
    return "Groq API error: quota or rate limits were hit. Check billing and usage for your API key and try again.";
  }

  if (status === 400 && message.toLowerCase().includes("model")) {
    return `Groq API error: model "${model}" was rejected. Confirm the configured Groq model is available for your API key.`;
  }

  if (status >= 500) {
    return "Groq API error: the service is having a temporary server issue. Please try again in a moment.";
  }

  return "Groq API error: the answer could not be completed right now. Check the backend terminal for the exact error.";
}

function resolveGeminiErrorMessage(error, model) {
  const status = error?.status || error?.code;
  const message = (error?.message || "").toLowerCase();

  if (status === 401 || message.includes("api key")) {
    return "Gemini API error: the API key was rejected. Check GEMINI_API_KEY in backend/.env and restart the server.";
  }

  if (status === 403 || message.includes("permission")) {
    return `Gemini API error: access to model "${model}" was denied. Confirm your API key can use this model.`;
  }

  if (status === 429 || message.includes("quota") || message.includes("rate limit")) {
    return "Gemini API error: quota or rate limits were hit. Check billing and usage for your API key and try again.";
  }

  if (status >= 500) {
    return "Gemini API error: the service is having a temporary server issue. Please try again in a moment.";
  }

  return "Gemini API error: the answer could not be completed right now. Check the backend terminal for the exact error.";
}

function resolveProviderErrorMessage(error, provider) {
  return provider === "gemini"
    ? resolveGeminiErrorMessage(error, GEMINI_MODEL)
    : resolveGroqErrorMessage(error, GROQ_MODEL);
}

function summarizeProviderError(error) {
  return {
    status: error?.status || null,
    code: error?.code || error?.error?.code || null,
    type: error?.name || null,
    message: error?.message || "Unknown provider error",
  };
}
