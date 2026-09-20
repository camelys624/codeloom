// Modified for Codeloom: allow a runtime web default without overriding explicit locale choices.
import {
  matchLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@multica/core/i18n";

export const MULTICA_LOCALE_HEADER = "x-multica-locale";

export function isSupportedLocale(
  value: string | null,
): value is SupportedLocale {
  return (
    value !== null &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function resolveLocaleFromSignals({
  cookieLocale = null,
  defaultLocale = null,
  acceptLanguage,
}: {
  cookieLocale?: string | null;
  defaultLocale?: string | null;
  acceptLanguage?: string | null;
}): SupportedLocale {
  if (isSupportedLocale(defaultLocale)) {
    return isSupportedLocale(cookieLocale) ? cookieLocale : defaultLocale;
  }

  const candidates: string[] = [];
  if (cookieLocale) candidates.push(cookieLocale);

  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0]?.trim();
    if (tag) candidates.push(tag);
  }

  return matchLocale(candidates);
}
