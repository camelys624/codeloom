// Modified for Codeloom: cover runtime default precedence and unchanged upstream fallbacks.
import { describe, expect, it } from "vitest";
import {
  isSupportedLocale,
  resolveLocaleFromSignals,
} from "./locale-routing";

describe("locale routing", () => {
  it("accepts only app-supported locale identifiers", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("zh-Hans")).toBe(true);
    expect(isSupportedLocale("ko")).toBe(true);
    expect(isSupportedLocale("ja")).toBe(true);
    expect(isSupportedLocale("zh")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
  });

  it("normalizes legacy landing zh cookies to the app locale", () => {
    expect(
      resolveLocaleFromSignals({
        cookieLocale: "zh",
        acceptLanguage: "en-US,en;q=0.9",
      }),
    ).toBe("zh-Hans");
  });

  it("prefers cookie locale over Accept-Language", () => {
    expect(
      resolveLocaleFromSignals({
        cookieLocale: "en",
        acceptLanguage: "zh-CN,zh;q=0.9",
      }),
    ).toBe("en");
  });

  it("prefers an explicit cookie over the configured locale and browser", () => {
    expect(
      resolveLocaleFromSignals({
        cookieLocale: "en",
        defaultLocale: "zh-Hans",
        acceptLanguage: "ja-JP",
      }),
    ).toBe("en");
  });

  it("prefers the configured locale over browser negotiation", () => {
    expect(
      resolveLocaleFromSignals({
        defaultLocale: "zh-Hans",
        acceptLanguage: "en-US",
      }),
    ).toBe("zh-Hans");
  });

  it("ignores unsupported cookies when a valid default is configured", () => {
    expect(
      resolveLocaleFromSignals({
        cookieLocale: "not_a_locale",
        defaultLocale: "zh-Hans",
        acceptLanguage: "en-US",
      }),
    ).toBe("zh-Hans");
  });

  it.each(["zh-CN", "not_a_locale", ""])(
    "preserves browser negotiation when the configured locale is invalid: %s",
    (defaultLocale) => {
      expect(
        resolveLocaleFromSignals({
          defaultLocale,
          acceptLanguage: "ja-JP",
        }),
      ).toBe("ja");
    },
  );

  it("preserves legacy cookie matching when the configured locale is invalid", () => {
    expect(
      resolveLocaleFromSignals({
        cookieLocale: "zh",
        defaultLocale: "not_a_locale",
        acceptLanguage: "en-US",
      }),
    ).toBe("zh-Hans");
  });

  it("retains the upstream fallback without usable locale signals", () => {
    expect(
      resolveLocaleFromSignals({ defaultLocale: "not_a_locale" }),
    ).toBe("en");
  });

  it("falls back to Accept-Language when no cookie is set", () => {
    expect(
      resolveLocaleFromSignals({
        acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
      }),
    ).toBe("zh-Hans");
  });

  it("matches Korean browser language signals", () => {
    expect(
      resolveLocaleFromSignals({
        acceptLanguage: "ko-KR,ko;q=0.9,en;q=0.8",
      }),
    ).toBe("ko");
  });

  it("matches Japanese browser language signals", () => {
    expect(
      resolveLocaleFromSignals({
        acceptLanguage: "ja-JP,ja;q=0.9,en;q=0.8",
      }),
    ).toBe("ja");
  });
});
