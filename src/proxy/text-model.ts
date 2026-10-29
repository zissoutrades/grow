/**
 * Shared text-model route (PROTOCOL §9).
 *
 * One plain HTTPS POST to Gemini's generateContent endpoint, no SDK, one retry
 * on 5xx only. The API key comes from `GEMINI_API_KEY` and is only ever placed
 * in the `x-goog-api-key` header — it is never logged, echoed, or put in a URL.
 *
 * The default model was verified on 2026-10-28 against
 * https://ai.google.dev/gemini-api/docs/models: the models page lists
 * `gemini-3.8-flash`, `gemini-3.8-live` and `gemini-3.1-pro-preview`, but no
 * `gemini-3.8-pro` (that id appears only in one Google sample). The current
 * Pro endpoint is `gemini-3.1-pro-preview`, so that is the default;
 * `GEMINI_TEXT_MODEL` overrides it without a code change.
 */

export type TextModelFn = (prompt: string, system?: string) => Promise<string>;

export const DEFAULT_TEXT_MODEL = "gemini-3.1-pro-preview";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
// 120 s: Gemini latency variance is real (500s/"high demand" observed
// 2026-10-29 on top of thinking time) and the after-loop is async, so a longer
// cap costs nothing; the console manager caps the tool loop at 3 rounds.
const REQUEST_TIMEOUT_MS = 120_000;

export class TextModelError extends Error {
  /** HTTP status, or null when the request never reached a response. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "TextModelError";
    this.status = status;
  }
}

interface GenerateContentPart {
  readonly text?: unknown;
  readonly thought?: unknown;
}

interface GenerateContentResponse {
  readonly candidates?: ReadonlyArray<{
    readonly content?: { readonly parts?: ReadonlyArray<GenerateContentPart> };
    readonly finishReason?: unknown;
  }>;
}

/**
 * Generate one text completion. `system`, when present, becomes the request's
 * `systemInstruction`; both prompt and system are plain text.
 */
export async function generateText(prompt: string, system?: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new TextModelError("GEMINI_API_KEY is not set");
  }

  const configured = process.env.GEMINI_TEXT_MODEL;
  const model =
    configured !== undefined && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_TEXT_MODEL;

  const requestBody: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    // Gemini 3 models default to `medium` thinking on generateContent (a bare
    // "say hi" took 129 s with gemini-3.8-flash on 2026-10-29). `low` is the
    // latency-oriented level and is supported on 3.8-flash; `minimal` is not
    // (it errors on that model). Gemini 3 takes the `thinkingLevel` string
    // enum, not the 2.5-era `thinkingBudget`.
    // https://ai.google.dev/gemini-api/docs/generate-content/thinking
    generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
  };
  if (system !== undefined && system.length > 0) {
    requestBody.systemInstruction = { parts: [{ text: system }] };
  }

  const response = await postWithSingleRetry(
    `${API_ROOT}/${model}:generateContent`,
    apiKey,
    JSON.stringify(requestBody),
  );

  const body = await response.text();
  if (!response.ok) {
    throw new TextModelError(
      `text model HTTP ${response.status}: ${apiErrorMessage(body)}`,
      response.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TextModelError("text model returned a non-JSON response", response.status);
  }
  if (!isRecord(parsed)) {
    throw new TextModelError("text model returned an unexpected response shape", response.status);
  }

  const candidates = (parsed as GenerateContentResponse).candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const parts = first?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
        .filter(
          (part): part is GenerateContentPart & { text: string } =>
            typeof part.text === "string" && part.thought !== true,
        )
        .map((part) => part.text)
        .join("")
    : "";

  if (text.trim().length === 0) {
    const finishReason =
      typeof first?.finishReason === "string" ? ` (finishReason: ${first.finishReason})` : "";
    throw new TextModelError(
      `text model returned no text${finishReason}`,
      response.status,
    );
  }
  return text;
}

async function postWithSingleRetry(
  url: string,
  apiKey: string,
  body: string,
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status < 500 || attempt === 1) {
        return response;
      }
      lastError = new TextModelError(`text model HTTP ${response.status}`, response.status);
    } catch (error) {
      // Network/abort failures are not retried: only 5xx responses get the
      // single retry PROTOCOL §9 allows.
      throw new TextModelError(`text model request failed: ${networkMessage(error)}`);
    }
  }

  // Unreachable: the loop either returns a response or throws.
  throw lastError instanceof Error
    ? lastError
    : new TextModelError("text model request failed");
}

/** Extract Google's `error.message` without ever echoing the request/key. */
function apiErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = parsed.error.message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
  } catch {
    // Fall through to a bounded snippet of the raw body.
  }
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return snippet.length > 0 ? snippet : "(empty response body)";
}

function networkMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
