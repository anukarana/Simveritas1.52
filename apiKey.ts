
/**
 * Utility to retrieve the most up-to-date API key for Google Generative AI.
 * It checks window.aistudio (if available) and falls back to process.env.
 */
export const getApiKey = async (): Promise<string | null> => {
  console.log('[apiKey] getApiKey called');
  // 1. Check window.aistudio if available (preferred in AI Studio environment)
  if (typeof window !== 'undefined' && (window as any).aistudio?.hasSelectedApiKey) {
    try {
      // Add a timeout to prevent hanging if the AI Studio bridge is unresponsive
      const hasKey = await Promise.race([
        (window as any).aistudio.hasSelectedApiKey(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
      ]).catch(() => false);
      
      console.log('[apiKey] window.aistudio.hasSelectedApiKey():', hasKey);
      if (hasKey) {
        // In AI Studio, the key is automatically injected into process.env.API_KEY
        // but we can also return it from process.env directly here.
        // We use a direct check to avoid issues with process.env object existence
        const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
        console.log('[apiKey] Key from process.env (after hasKey check):', key ? 'Found' : 'Not found');
        if (key) return key;
      }
    } catch (e) {
      console.warn('[apiKey] Error checking AI Studio key:', e);
    }
  }
  
  // 2. Fallback to process.env (for local dev or if already injected)
  try {
    const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
    console.log('[apiKey] Key from process.env (fallback):', key ? 'Found' : 'Not found');
    if (key) return key;
  } catch (e) {
    // process.env might not be defined as an object in some environments
  }
  
  console.log('[apiKey] No API key found');
  return null;
};

/**
 * Clears the cached API key if any.
 */
export const clearApiKeyCache = (): void => {
  // No-op as there is no local cache in this implementation,
  // but provided for compatibility with the requested interface.
  console.log('[apiKey] Cache cleared');
};

/**
 * Synchronous version for places where async is not possible.
 * Note: This may not be as up-to-date if window.aistudio.hasSelectedApiKey() 
 * hasn't been called/resolved recently.
 */
export const getApiKeySync = (): string | null => {
  try {
    const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (key) return key;
  } catch (e) {
    // process.env might not be defined as an object in some environments
  }
  return null;
};
