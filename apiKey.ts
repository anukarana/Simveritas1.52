/**
 * Utility to retrieve the most up-to-date API key for Google Generative AI.
 * Priority: server injection → localStorage → window.aistudio → process.env
 */

const STORAGE_KEY = 'simveritas_api_key';

export const getApiKey = async (): Promise<string | null> => {
  console.log('[apiKey] getApiKey called');

  // 1. Server-injected key (Cloud Run injects via server.ts into window at request time)
  if (typeof window !== 'undefined') {
    const w = window as any;
    const injected = w.__API_KEY__ || w.__GEMINI_API_KEY__;
    if (injected) {
      console.log('[apiKey] Found key via server injection');
      try { localStorage.setItem(STORAGE_KEY, injected); } catch (e) {}
      return injected;
    }
  }

  // 2. Previously saved key in localStorage (survives page reloads)
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      console.log('[apiKey] Found key in localStorage');
      if (typeof window !== 'undefined') {
        (window as any).__API_KEY__ = saved;
        (window as any).__GEMINI_API_KEY__ = saved;
      }
      return saved;
    }
  } catch (e) {}

  // 3. Google AI Studio environment
  if (typeof window !== 'undefined' && (window as any).aistudio?.hasSelectedApiKey) {
    try {
      const hasKey = await Promise.race([
        (window as any).aistudio.hasSelectedApiKey(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
      ]).catch(() => false);

      if (hasKey) {
        const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
        if (key) {
          try { localStorage.setItem(STORAGE_KEY, key); } catch (e) {}
          return key;
        }
      }
    } catch (e) {
      console.warn('[apiKey] Error checking AI Studio key:', e);
    }
  }

  // 4. Vite build-time baked key (process.env)
  try {
    const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (key) {
      console.log('[apiKey] Found key via process.env');
      try { localStorage.setItem(STORAGE_KEY, key); } catch (e) {}
      return key;
    }
  } catch (e) {}

  console.log('[apiKey] No API key found');
  return null;
};

/**
 * Saves a manually entered API key to localStorage and window.
 */
export const saveApiKey = (key: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, key);
    if (typeof window !== 'undefined') {
      (window as any).__API_KEY__ = key;
      (window as any).__GEMINI_API_KEY__ = key;
    }
    console.log('[apiKey] Key saved to localStorage');
  } catch (e) {
    console.error('[apiKey] Failed to save key:', e);
  }
};

/**
 * Clears the saved API key from localStorage and window.
 */
export const clearApiKeyCache = (): void => {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  if (typeof window !== 'undefined') {
    delete (window as any).__API_KEY__;
    delete (window as any).__GEMINI_API_KEY__;
  }
  console.log('[apiKey] Key cleared');
};

export const getApiKeySync = (): string | null => {
  try {
    const w = window as any;
    if (w.__API_KEY__) return w.__API_KEY__;
  } catch (e) {}
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch (e) {}
  try {
    const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (key) return key;
  } catch (e) {}
  return null;
};
