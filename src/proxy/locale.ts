/**
 * Demo locale switch (handoff 2026-11-01).
 *
 * `GROW_LOCALE=en` makes the demo path speak and write English; anything else
 * (including unset) keeps today's Russian behavior. The match is exact on
 * purpose: only the literal value `en` turns English on, so a typo or an
 * unrelated value can never half-switch the demo.
 *
 * The locale is read at session start and at request time, never cached at
 * module load: a running proxy picks up the environment it was started with,
 * and tests can exercise both branches in one process.
 */

export type Locale = "ru" | "en";

export const DEFAULT_LOCALE: Locale = "ru";

/** Map a raw `GROW_LOCALE` value to a supported locale. */
export function resolveLocale(value: string | undefined = process.env.GROW_LOCALE): Locale {
  return value === "en" ? "en" : DEFAULT_LOCALE;
}

/** The locale of the running proxy process. */
export function currentLocale(): Locale {
  return resolveLocale();
}

/**
 * Input STT language pin for Gemini Live. Russian is the existing demo pin;
 * English must transcribe child speech too, or the tutor hears garbage.
 */
export function sttLanguageCode(locale: Locale): string {
  return locale === "en" ? "en-US" : "ru-RU";
}
