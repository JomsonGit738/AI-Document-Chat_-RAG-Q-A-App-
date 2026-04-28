require("dotenv").config();

const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const multer = require("multer");
const pdf = require("pdf-parse");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 10 * 1024 * 1024);
const MODEL = "llama-3.3-70b-versatile";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:4200")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const sessions = new Map();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by CORS"));
    }
  })
);
app.use(express.json({ limit: "1mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a minute and try again."
  }
});

app.use("/api", limiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE
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
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, async (error) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB.`
          });
          return;
        }

        res.status(400).json({
          error: "Upload failed. Please use a valid PDF file."
        });
        return;
      }

      if (error.name === "InvalidFileTypeError") {
        res.status(400).json({
          error: "Only PDF files are supported."
        });
        return;
      }

      res.status(500).json({
        error: "Upload failed unexpectedly. Please try again."
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({
        error: "No PDF file was provided."
      });
      return;
    }

    try {
      const parsed = await pdf(req.file.buffer);
      const rawText = normalizeWhitespace(parsed.text);

      if (!rawText) {
        res.status(400).json({
          error: "This PDF does not contain selectable text."
        });
        return;
      }

      const sessionId = crypto.randomUUID();
      const chunks = splitIntoChunks(rawText, 500, 50).map((text, index) => ({
        id: index + 1,
        label: `Chunk ${index + 1}`,
        text,
        vector: buildTermFrequency(text)
      }));
      const excerpt = rawText.slice(0, 200);
      const summary = await generateDocumentSummary(rawText.slice(0, 3000));
      const starterQuestions = await generateStarterQuestions(excerpt);

      sessions.set(sessionId, {
        id: sessionId,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        pageCount: parsed.numpages || 0,
        uploadedAt: new Date().toISOString(),
        rawText,
        chunks
      });

      res.status(201).json({
        sessionId,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        pageCount: parsed.numpages || 0,
        document: {
          fileName: req.file.originalname,
          fileSize: req.file.size,
          pageCount: parsed.numpages || 0,
          uploadedAt: new Date().toISOString()
        },
        excerpt,
        starterQuestions,
        summary
      });
    } catch (parseError) {
      res.status(400).json({
        error: "Unable to read this PDF. Please upload a text-based PDF document."
      });
    }
  });
});

app.post("/api/chat", async (req, res) => {
  const { question, sessionId } = req.body || {};

  if (!question || typeof question !== "string") {
    res.status(400).json({
      error: "A question is required."
    });
    return;
  }

  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({
      error: "A sessionId is required."
    });
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    res.status(404).json({
      error: "Session not found. Please re-upload your document."
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const topChunks = rankChunks(question, session.chunks).slice(0, 3);
  const sourceMetadata = topChunks.map((chunk) => ({
    chunkIndex: chunk.id,
    excerpt: truncate(chunk.text, 120)
  }));

  if (!groq) {
    sendEvent(res, "error", {
      error: "The AI service is not configured yet. Add GROQ_API_KEY on the backend."
    });
    sendEvent(res, "done", { complete: true });
    res.end();
    return;
  }

  const systemPrompt =
    "You are a document assistant. Answer ONLY from the provided document context. If the answer isn't in the context, say so clearly. Be concise and precise.";
  const context = topChunks.map((chunk) => `[${chunk.label}]\n${chunk.text}`).join("\n");

  try {
    const stream = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion: ${question}`
        }
      ],
      stream: true,
      max_tokens: 1024
    });

    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content || "";

      if (delta) {
        sendEvent(res, "chunk", {
          content: delta
        });
      }
    }

    sendEvent(res, "done", { complete: true });
    sendEvent(res, "sources", {
      sources: sourceMetadata
    });
    res.end();
  } catch (groqError) {
    console.error("Groq API request failed:", summarizeGroqError(groqError));

    sendEvent(res, "error", {
      error: resolveGroqErrorMessage(groqError, MODEL)
    });
    sendEvent(res, "done", { complete: true });
    sendEvent(res, "sources", {
      sources: sourceMetadata
    });
    res.end();
  }
});

app.delete("/api/session/:id", (req, res) => {
  const deleted = sessions.delete(req.params.id);

  if (!deleted) {
    res.status(404).json({
      error: "Session not found."
    });
    return;
  }

  res.status(204).send();
});

app.use((error, _req, res, _next) => {
  if (error.message === "Origin not allowed by CORS") {
    res.status(403).json({
      error: "This origin is not allowed to access the API."
    });
    return;
  }

  res.status(500).json({
    error: "Unexpected server error."
  });
});

app.listen(PORT, () => {
  console.log(`DocChat backend listening on port ${PORT}`);
});

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
      score
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
  if (!groq) {
    return fallbackStarterQuestions(excerpt);
  }

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            'Generate exactly 3 concise recruiter-quality document questions. Return strict JSON with a single property named "questions" that is an array of 3 strings.'
        },
        {
          role: "user",
          content: `Excerpt:\n${excerpt}`
        }
      ],
      temperature: 0.4,
      max_tokens: 256,
      response_format: {
        type: "json_object"
      }
    });
    const payload = JSON.parse(completion.choices?.[0]?.message?.content || '{"questions":[]}');
    const questions = Array.isArray(payload.questions)
      ? payload.questions.filter((item) => typeof item === "string").slice(0, 3)
      : [];

    return questions.length === 3 ? questions : fallbackStarterQuestions(excerpt);
  } catch (_error) {
    return fallbackStarterQuestions(excerpt);
  }
}

async function generateDocumentSummary(excerpt) {
  if (!groq) {
    return fallbackDocumentSummary(excerpt);
  }

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            "Summarize this document clearly and accurately for a professional reader.",
            "Focus on the main purpose, key points, and any important outcomes or requirements.",
            "Return strict JSON with two properties:",
            '- "overview": a short overview paragraph in 2 to 3 sentences.',
            '- "bullets": an array of 3 to 5 concise bullet points covering the most important details.',
            "Do not invent information. Use only the provided document text.",
            excerpt
          ].join("\n\n")
        }
      ],
      temperature: 0.3,
      max_tokens: 320,
      response_format: {
        type: "json_object"
      }
    });
    const payload = JSON.parse(
      completion.choices?.[0]?.message?.content || '{"overview":"","bullets":[]}'
    );
    const overview =
      typeof payload.overview === "string" ? payload.overview.replace(/\s+/g, " ").trim() : "";
    const bullets = Array.isArray(payload.bullets)
      ? payload.bullets
          .filter((item) => typeof item === "string")
          .map((item) => item.replace(/^\s*[-*•]\s*/, "").trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

    return overview && bullets.length >= 3
      ? { overview, bullets }
      : fallbackDocumentSummary(excerpt);
  } catch (_error) {
    return fallbackDocumentSummary(excerpt);
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
    "Which details in this document matter most?"
  ];
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
    bullets.push("This document contains additional details that can be explored in chat");
  }

  return {
    overview: overview ? `${overview}.` : "This document contains key details that can be explored in chat.",
    bullets: bullets.map((sentence) => `${sentence.replace(/\s+/g, " ").trim()}.`)
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

  return `${value.slice(0, maxLength).trim()}...`;
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

function summarizeGroqError(error) {
  return {
    status: error?.status || null,
    code: error?.code || error?.error?.code || null,
    type: error?.name || null,
    message: error?.message || "Unknown Groq API error"
  };
}
