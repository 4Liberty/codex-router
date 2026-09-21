import { MESSAGES } from "./messages.mjs";

const STORAGE_KEY = "codex-router-language";

export const LANGUAGE_OPTIONS = [
  { id: "en", label: "English", locale: "en-US" },
  { id: "zh-CN", label: "简体中文", locale: "zh-CN" },
  { id: "zh-TW", label: "繁體中文（台灣）", locale: "zh-TW" },
  { id: "ar", label: "العربية", locale: "ar", dir: "rtl" },
  { id: "hi", label: "हिन्दी", locale: "hi-IN" },
  { id: "ja", label: "日本語", locale: "ja-JP" },
  { id: "ko", label: "한국어", locale: "ko-KR" },
  { id: "es", label: "Español", locale: "es-ES" },
];

let currentLanguage = detectLanguage();

export function availableLanguages() {
  return LANGUAGE_OPTIONS.map((option) => ({ ...option }));
}

export function translationKeys() {
  return Object.fromEntries(Object.entries(MESSAGES).map(([language, messages]) => [language, Object.keys(messages)]));
}

export function getLanguage() {
  return currentLanguage;
}

export function getLocale() {
  return LANGUAGE_OPTIONS.find((option) => option.id === currentLanguage)?.locale || "en-US";
}

export function setLanguage(language) {
  const next = LANGUAGE_OPTIONS.some((option) => option.id === language) ? language : "en";
  currentLanguage = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // Storage can be unavailable in a restricted webview or test environment.
  }
  return currentLanguage;
}

export function t(key, values = {}) {
  const messages = MESSAGES[currentLanguage] || MESSAGES.en;
  const message = Object.hasOwn(messages, key) ? messages[key] : Object.hasOwn(MESSAGES.en, key) ? MESSAGES.en[key] : String(key);
  return String(message).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token);
}

export function applyTranslations(root = globalThis.document) {
  if (!root) return;
  const documentElement = root.documentElement || root;
  if (documentElement?.setAttribute) {
    documentElement.setAttribute("lang", currentLanguage);
    documentElement.setAttribute(
      "dir",
      LANGUAGE_OPTIONS.find((option) => option.id === currentLanguage)?.dir || "ltr",
    );
  }
  if (root.title !== undefined) root.title = t("app.title");
  root.querySelectorAll?.("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  root.querySelectorAll?.("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  root.querySelectorAll?.("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  });
  root.querySelectorAll?.("[data-i18n-title]").forEach((element) => {
    element.setAttribute("title", t(element.dataset.i18nTitle));
  });
}

function detectLanguage() {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (LANGUAGE_OPTIONS.some((option) => option.id === stored)) return stored;
  } catch {
    // Ignore unavailable storage and use the system language.
  }
  return resolveLanguage(globalThis.navigator?.language);
}

// A declared script wins over region; preference IDs stay backwards compatible.
export function resolveLanguage(value) {
  const parts = typeof value === "string" ? value.trim().replaceAll("_", "-").toLowerCase().split("-") : [];
  if (parts[0] === "zh") {
    if (parts.includes("hant")) return "zh-TW";
    if (parts.includes("hans")) return "zh-CN";
    return parts.some((part) => ["tw", "hk", "mo"].includes(part)) ? "zh-TW" : "zh-CN";
  }
  return LANGUAGE_OPTIONS.some((option) => option.id === parts[0]) ? parts[0] : "en";
}
