import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type Schema,
} from "@google/generative-ai";

/**
 * Single entry point for every LLM call in the app. Tries Gemini first and, on
 * any failure (quota 429, safety block, bad JSON, network), retries the same
 * request on Groq. Returns null only if every configured provider failed, so
 * callers keep their existing "null means show an error" handling.
 *
 * Env: GEMINI_API_KEY, GEMINI_MODEL (default gemini-3.6-flash),
 *      GROQ_API_KEY, GROQ_MODEL (default openai/gpt-oss-120b),
 *      GROQ_VISION_MODEL (default qwen/qwen3.8-27b -- the only model on this
 *      account whose input_modalities include "image", confirmed against
 *      Groq's live /v1/models list).
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TIMEOUT_MS = 30_000;

// Crime-related text can trip Gemini's default safety filters and fail
// silently. Loosen (not disable) them for legitimate police-platform use.
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

type BaseOptions = {
  /** System instruction. */
  system: string;
  /** User prompt / content. */
  prompt: string;
  /** Log prefix, e.g. "generateFirDraft". */
  label: string;
};

type Provider<T> = { name: string; run: () => Promise<T> };

async function runProviders<T>(label: string, providers: Provider<T>[]): Promise<T | null> {
  if (providers.length === 0) {
    console.error(`[${label}] No LLM provider is configured (set GEMINI_API_KEY and/or GROQ_API_KEY).`);
    return null;
  }
  for (const provider of providers) {
    try {
      return await provider.run();
    } catch (err) {
      console.error(`[${label}] ${provider.name} failed:`, err);
    }
  }
  return null;
}

// ---------- Gemini ----------

async function geminiGenerate(opts: BaseOptions, schema?: Schema): Promise<string> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: opts.system,
    safetySettings: SAFETY_SETTINGS,
    ...(schema
      ? { generationConfig: { responseMimeType: "application/json", responseSchema: schema } }
      : {}),
  });

  const result = await model.generateContent(opts.prompt);

  const candidate = result.response.candidates?.[0];
  if (candidate && candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(
      `Generation did not finish normally (finishReason=${candidate.finishReason}, safetyRatings=${JSON.stringify(candidate.safetyRatings)})`
    );
  }

  const text = result.response.text().trim();
  if (!text) throw new Error("Gemini returned empty text.");
  return text;
}

type ImageOptions = {
  /** System instruction. */
  system: string;
  /** User prompt / question about the image. */
  prompt: string;
  /** Log prefix, e.g. "readPlateWithAI". */
  label: string;
  /** Raw base64 image data, no "data:...;base64," prefix. */
  imageBase64: string;
  /** e.g. "image/jpeg". */
  mimeType: string;
};

async function geminiGenerateFromImage(opts: ImageOptions, schema: Schema): Promise<string> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: opts.system,
    safetySettings: SAFETY_SETTINGS,
    generationConfig: { responseMimeType: "application/json", responseSchema: schema },
  });

  const result = await model.generateContent([
    { inlineData: { mimeType: opts.mimeType, data: opts.imageBase64 } },
    opts.prompt,
  ]);

  const candidate = result.response.candidates?.[0];
  if (candidate && candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(
      `Generation did not finish normally (finishReason=${candidate.finishReason}, safetyRatings=${JSON.stringify(candidate.safetyRatings)})`
    );
  }

  const text = result.response.text().trim();
  if (!text) throw new Error("Gemini returned empty text.");
  return text;
}

// ---------- Groq ----------

// Gemini's Schema uses upper-case type names, `nullable`, and `format: "enum"`;
// convert it to plain JSON Schema so Groq's model can follow it.
function toJsonSchema(schema: Schema): Record<string, unknown> {
  const s = schema as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const type = typeof s.type === "string" ? s.type.toLowerCase() : undefined;
  if (type) out.type = s.nullable ? [type, "null"] : type;
  if (typeof s.description === "string") out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (s.properties && typeof s.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, Schema>).map(([k, v]) => [k, toJsonSchema(v)])
    );
  }
  if (s.items) out.items = toJsonSchema(s.items as Schema);
  if (Array.isArray(s.required)) out.required = s.required;
  return out;
}

// Groq's JSON mode requires a top-level object, so a non-object schema (e.g.
// an array) gets wrapped as { result: ... } here and unwrapped by
// unwrapGroqJsonContent below -- shared by both the text and image Groq
// callers rather than duplicated in each.
function buildGroqJsonSystem(system: string, schema: Schema): { system: string; wrapped: boolean } {
  let jsonSchema = toJsonSchema(schema);
  let wrapped = false;
  if (jsonSchema.type !== "object") {
    wrapped = true;
    jsonSchema = { type: "object", properties: { result: jsonSchema }, required: ["result"] };
  }
  return {
    system:
      system +
      `\n\nRespond with a single JSON object that matches this JSON Schema exactly. Output JSON only, no prose.\n${JSON.stringify(jsonSchema)}`,
    wrapped,
  };
}

function unwrapGroqJsonContent(content: string, wrapped: boolean): string {
  if (!wrapped) return content;
  const parsed = JSON.parse(content) as { result?: unknown };
  if (parsed.result === undefined) throw new Error("Groq JSON missing wrapped `result` field.");
  return JSON.stringify(parsed.result);
}

async function groqGenerate(opts: BaseOptions, schema?: Schema): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY as string;

  let system = opts.system;
  let wrapped = false;
  if (schema) {
    ({ system, wrapped } = buildGroqJsonSystem(system, schema));
  }

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: schema ? 0.2 : 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: opts.prompt },
      ],
      ...(schema ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Groq returned empty content.");

  return unwrapGroqJsonContent(content, wrapped);
}

async function groqGenerateFromImage(opts: ImageOptions, schema: Schema): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY as string;
  const { system, wrapped } = buildGroqJsonSystem(opts.system, schema);

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: opts.prompt },
            {
              type: "image_url",
              image_url: { url: `data:${opts.mimeType};base64,${opts.imageBase64}` },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Groq returned empty content.");

  return unwrapGroqJsonContent(content, wrapped);
}

// ---------- Public API ----------

function textProviders(opts: BaseOptions): Provider<string>[] {
  const providers: Provider<string>[] = [];
  if (process.env.GEMINI_API_KEY) providers.push({ name: "Gemini", run: () => geminiGenerate(opts) });
  if (process.env.GROQ_API_KEY) providers.push({ name: "Groq", run: () => groqGenerate(opts) });
  return providers;
}

function jsonProviders<T>(opts: BaseOptions, schema: Schema): Provider<T>[] {
  const providers: Provider<T>[] = [];
  if (process.env.GEMINI_API_KEY) {
    providers.push({
      name: "Gemini",
      run: async () => JSON.parse(await geminiGenerate(opts, schema)) as T,
    });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: "Groq",
      run: async () => JSON.parse(await groqGenerate(opts, schema)) as T,
    });
  }
  return providers;
}

/** Free-form text. Returns trimmed, non-empty text or null if every provider failed. */
export async function generateText(opts: BaseOptions): Promise<string | null> {
  return runProviders(opts.label, textProviders(opts));
}

/** Structured output matching `schema`. Returns the parsed value or null if every provider failed. */
export async function generateJson<T>(opts: BaseOptions & { schema: Schema }): Promise<T | null> {
  return runProviders(opts.label, jsonProviders<T>(opts, opts.schema));
}

/**
 * Structured output from an image + prompt. Same Gemini-first, Groq-fallback
 * behavior as generateJson, but Gemini gets the image as inlineData and Groq
 * gets it as an OpenAI-style image_url data URL on GROQ_VISION_MODEL (the
 * text-only GROQ_MODEL can't accept image input). Returns null if every
 * provider failed.
 */
export async function generateFromImage<T>(
  opts: ImageOptions & { schema: Schema }
): Promise<T | null> {
  const providers: Provider<T>[] = [];
  if (process.env.GEMINI_API_KEY) {
    providers.push({
      name: "Gemini",
      run: async () => JSON.parse(await geminiGenerateFromImage(opts, opts.schema)) as T,
    });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: "Groq",
      run: async () => JSON.parse(await groqGenerateFromImage(opts, opts.schema)) as T,
    });
  }
  return runProviders(opts.label, providers);
}
