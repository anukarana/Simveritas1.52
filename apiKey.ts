/**
 * Utility to retrieve the most up-to-date API key for Google Generative AI.
 * Checks window.__API_KEY__ (injected by server), window.aistudio, then process.env.
 */
export const getApiKey = async (): Promise<string | null> => {
  console.log('[apiKey] getApiKey called');

  // 1. Check window.__API_KEY__ — injected by server.ts at request time (Cloud Run)
  if (typeof window !== 'undefined') {
    const w = window as any;
    const injected = w.__API_KEY__ || w.__GEMINI_API_KEY__;
    if (injected) {
      console.log('[apiKey] Found key via window injection');
      return injected;
    }
  }

  // 2. Check window.aistudio (Google AI Studio environment)
  if (typeof window !== 'undefined' && (window as any).aistudio?.hasSelectedApiKey) {
    try {
      const hasKey = await Promise.race([
        (window as any).aistudio.hasSelectedApiKey(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
      ]).catch(() => false);

      console.log('[apiKey] window.aistudio.hasSelectedApiKey():', hasKey);
      if (hasKey) {
        const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
        if (key) return key;
      }
    } catch (e) {
      console.warn('[apiKey] Error checking AI Studio key:', e);
    }
  }

  // 3. Fallback to process.env (baked in at Vite build time)
  try {
    const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
    console.log('[apiKey] Key from process.env:', key ? 'Found' : 'Not found');
    if (key) return key;
  } catch (e) {
    // process.env might not be defined
  }

  console.log('[apiKey] No API key found');
  return null;
};

export const clearApiKeyCache = (): void => {
  console.log('[apiKey] Cache cleared');
};

export const getApiKeySync = (): string | null => {
  try {
    const w = window as any;
    const injected = w.__API_KEY__ || w.__GEMINI_API_KEY__;
    if (injected) return injected;
  } catch (e) {}
  try {
    const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (key) return key;
  } catch (e) {}
  return null;
};
