import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, terminate, disableNetwork, setLogLevel, setDoc as fsSetDoc, updateDoc as fsUpdateDoc, addDoc as fsAddDoc, deleteDoc as fsDeleteDoc, getDoc as fsGetDoc, getDocs as fsGetDocs, onSnapshot as fsOnSnapshot, DocumentReference, Query, WithFieldValue, UpdateData, DocumentData } from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json';
import { useState, useEffect } from 'react';

// Silence the SDK immediately to prevent console spam during quota issues
try {
  setLogLevel('silent');
} catch (e) {}

// Initialize Firebase SDK
const app = initializeApp(firebaseConfig);

// Initialize Firestore with the specific database ID from config
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Initialize Auth
export const auth = getAuth(app);

// Quota management helpers
let quotaExceeded = typeof window !== 'undefined' && localStorage.getItem('simveritas_firestore_quota_exceeded') === 'true';
let isTerminating = false;

// Global Write Rate Limiter
let writeCountThisSession = 0;
const MAX_WRITES_PER_SESSION = 5000;
const WRITE_COOLDOWN_MS = 1000;
let lastWriteTime = 0;

export const isFirestoreQuotaExceeded = () => {
  if (typeof window === 'undefined') return false;
  // Check global flag and localStorage directly for cross-tab consistency
  if ((window as any).SIMVERITAS_FIRESTORE_QUOTA_EXCEEDED) return true;
  return localStorage.getItem('simveritas_firestore_quota_exceeded') === 'true';
};

export const clearFirestoreQuotaExceeded = () => {
  if (typeof window === 'undefined') return;
  quotaExceeded = false;
  (window as any).SIMVERITAS_FIRESTORE_QUOTA_EXCEEDED = false;
  localStorage.removeItem('simveritas_firestore_quota_exceeded');
  localStorage.removeItem('simveritas_firestore_quota_time');
  console.log('[Firebase] Firestore quota state cleared manually.');
};

export const canPerformWrite = (isCritical = false) => {
  if (isCritical) return true;           // must be FIRST — bypasses quota AND cooldown
  if (isFirestoreQuotaExceeded()) return false;
  const now = Date.now();
  if (now - lastWriteTime < WRITE_COOLDOWN_MS) return false;
  if (writeCountThisSession >= MAX_WRITES_PER_SESSION) {
    console.error('[Firebase] Write rate limit reached. Blocking non-critical writes.');
    return false;
  }
  return true;
};

export const recordWrite = () => {
  writeCountThisSession++;
  lastWriteTime = Date.now();
};

// Data sanitization to prevent Firestore 'undefined' value errors
function sanitizeData(data: any): any {
  if (data === undefined) return null;
  if (data === null || typeof data !== 'object') return data;
  if (data instanceof Date) return data;
  
  if (Array.isArray(data)) {
    return data.map(sanitizeData);
  }
  
  // Only sanitize plain objects to avoid mangling Firestore types like Timestamp or FieldValue
  if (Object.prototype.toString.call(data) !== '[object Object]') {
    return data;
  }
  
  const sanitized: any = {};
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const value = data[key];
      if (value !== undefined) {
        sanitized[key] = sanitizeData(value);
      }
    }
  }
  return sanitized;
}

// Safe Write Wrappers
export async function setDoc(
  reference: DocumentReference<any>,
  data: WithFieldValue<any>,
  options?: { merge?: boolean },
  isCritical = false
) {
  if (!canPerformWrite(isCritical)) return;
  recordWrite();
  try {
    const sanitizedData = sanitizeData(data);
    if (options?.merge) {
      return await fsSetDoc(reference, sanitizedData, { merge: true });
    }
    return await fsSetDoc(reference, sanitizedData);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, reference.path);
  }
}

export async function updateDoc(
  reference: DocumentReference<any>,
  data: UpdateData<any>,
  isCritical = false
) {
  if (!canPerformWrite(isCritical)) return;
  recordWrite();
  try {
    const sanitizedData = sanitizeData(data);
    return await fsUpdateDoc(reference, sanitizedData);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, reference.path);
  }
}

export async function addDoc(
  reference: any,
  data: WithFieldValue<any>,
  isCritical = false
) {
  if (!canPerformWrite(isCritical)) return;
  recordWrite();
  try {
    const sanitizedData = sanitizeData(data);
    return await fsAddDoc(reference, sanitizedData);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, reference.path || 'collection');
  }
}

export async function deleteDoc(
  reference: DocumentReference<any>,
  isCritical = false
) {
  if (!canPerformWrite(isCritical)) return;
  recordWrite();
  try {
    return await fsDeleteDoc(reference);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, reference.path);
  }
}

export async function getDoc(reference: DocumentReference<any>) {
  try {
    return await fsGetDoc(reference);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, reference.path);
    return null;
  }
}

export async function getDocs(query: Query<any>) {
  try {
    return await fsGetDocs(query);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'query');
    return { docs: [], empty: true };
  }
}

export function onSnapshot(reference: any, onNext: (snapshot: any) => void, onError?: (error: any) => void) {
  return fsOnSnapshot(reference, onNext, (err) => {
    const errStr = String(err);
    const isQuotaError =
      errStr.includes('resource-exhausted') ||
      errStr.includes('Quota exceeded') ||
      (err as any)?.code === 'resource-exhausted';
    if (isQuotaError) {
      setFirestoreQuotaExceeded();
    } else {
      // Do NOT re-throw — a throw here permanently kills the listener
      console.error('[Firebase] onSnapshot error (listener kept alive):', errStr);
    }
    if (onError) onError(err);
  });
}

if (typeof window !== 'undefined') {
  (window as any).SIMVERITAS_FIRESTORE_QUOTA_EXCEEDED = quotaExceeded;
  
  // Listen for storage events to sync quota state across tabs
  window.addEventListener('storage', (e) => {
    if (e.key === 'simveritas_firestore_quota_exceeded') {
      const newValue = e.newValue === 'true';
      if (newValue && !quotaExceeded) {
        quotaExceeded = true;
        (window as any).SIMVERITAS_FIRESTORE_QUOTA_EXCEEDED = true;
        console.warn('[Firebase] Firestore quota exceeded in another tab.');
        try {
          setLogLevel('silent');
        } catch (e) {}
      } else if (!newValue && quotaExceeded) {
        quotaExceeded = false;
        (window as any).SIMVERITAS_FIRESTORE_QUOTA_EXCEEDED = false;
        console.log('[Firebase] Firestore quota reset in another tab. Please refresh to reconnect.');
      }
    }
  });

  // Catch unhandled Firestore errors that might escape try-catch blocks
  window.addEventListener('unhandledrejection', (event) => {
    const errStr = String(event.reason);
    if (errStr.includes('resource-exhausted') || errStr.includes('Quota exceeded') || (event.reason as any)?.code === 'resource-exhausted') {
      console.warn('[Firebase] Unhandled quota error detected. Triggering circuit breaker.');
      setFirestoreQuotaExceeded();
    }
  });
}

// Check if quota was exceeded more than 24 hours ago and reset if so
const quotaExceededTime = typeof window !== 'undefined' ? localStorage.getItem('simveritas_firestore_quota_time') : null;
if (quotaExceeded && quotaExceededTime) {
  const lastTime = parseInt(quotaExceededTime, 10);
  if (Date.now() - lastTime > 24 * 60 * 60 * 1000) {
    quotaExceeded = false;
    if (typeof window !== 'undefined') {
      (window as any).SIMVERITAS_FIRESTORE_QUOTA_EXCEEDED = false;
      localStorage.removeItem('simveritas_firestore_quota_exceeded');
      localStorage.removeItem('simveritas_firestore_quota_time');
    }
    console.log('[Firebase] 24 hours passed since quota exceeded. Resetting quota state.');
  }
}

export const useFirestoreQuota = () => {
  const [exceeded, setExceeded] = useState(quotaExceeded);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'simveritas_firestore_quota_exceeded') {
        setExceeded(e.newValue === 'true');
      }
    };

    window.addEventListener('storage', handleStorage);
    
    // Check periodically as a fallback
    const interval = setInterval(() => {
      const current = localStorage.getItem('simveritas_firestore_quota_exceeded') === 'true';
      if (current !== exceeded) setExceeded(current);
    }, 2000);

    return () => {
      window.removeEventListener('storage', handleStorage);
      clearInterval(interval);
    };
  }, [exceeded]);

  return exceeded;
};

export const setFirestoreQuotaExceeded = async () => {
  if (typeof window === 'undefined') return;
  
  const alreadyExceeded = localStorage.getItem('simveritas_firestore_quota_exceeded') === 'true';
  
  if (alreadyExceeded) {
    return;
  }
  
  console.warn('[Firebase] Firestore write quota exceeded. Blocking further writes but keeping reads active.');
  quotaExceeded = true;
  if (typeof window !== 'undefined') {
    (window as any).SIMVERITAS_FIRESTORE_QUOTA_EXCEEDED = true;
  }
  
  // Silence the SDK to stop "maximum backoff delay" console spam
  try {
    setLogLevel('silent');
  } catch (e) {
    // Ignore
  }
  
  localStorage.setItem('simveritas_firestore_quota_exceeded', 'true');
  localStorage.setItem('simveritas_firestore_quota_time', Date.now().toString());
};

// Check on load
if (quotaExceeded) {
  console.log('[Firebase] Firestore quota was previously exceeded. Writes will be blocked.');
  try {
    setLogLevel('silent');
  } catch (e) {}
}

// Error Handling Spec for Firestore Operations
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

let lastQuotaLogTime = 0;

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errStr = String(error);
  const isQuotaError = 
    errStr.includes('resource-exhausted') || 
    errStr.includes('Quota exceeded') ||
    (error as any)?.code === 'resource-exhausted';

  if (isQuotaError) {
    const now = Date.now();
    setFirestoreQuotaExceeded();
    
    // Silence the SDK to stop "maximum backoff delay" console spam
    try {
      setLogLevel('silent');
    } catch (e) {}
    
    // Suppress repeated quota logs to prevent console spam
    if (now - lastQuotaLogTime > 30000) {
      console.error('[Firebase] Quota exceeded during', operationType, 'on', path, '. Circuit breaker active.');
      lastQuotaLogTime = now;
    }
    
    // Silent return to stop the UI from crashing but stop the operation
    return;
  }

  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  
  console.error('Firestore operation failed:', JSON.stringify(errInfo));
  return; // Do not throw — callers use .catch() which cannot safely re-throw
}

export default app;
