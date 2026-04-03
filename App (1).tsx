
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { getApiKey, clearApiKeyCache } from './apiKey';
import { Scenario, SimulationConfig, TranscriptionEntry, FeedbackReport, SimulationRoomHandle, SavedReport, AnalyticsData, SimulationStatus, DashboardHandle, NCBISource, CognitiveTrait, Emotion } from './types';
import { DEFAULT_SCENARIOS, VOICE_PROFILES } from './constants';
import Dashboard from './Dashboard';
import SimulationRoom from './SimulationRoom';
import FeedbackView from './FeedbackView';
import SyncMonitor from './SyncMonitor';
import { ErrorBoundary } from './ErrorBoundary';
import { auth, db, isFirestoreQuotaExceeded, setFirestoreQuotaExceeded, clearFirestoreQuotaExceeded, handleFirestoreError, OperationType, useFirestoreQuota, setDoc, updateDoc, onSnapshot, getDoc } from './firebase';
import { User, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { doc, deleteDoc } from 'firebase/firestore';
import { io, Socket } from 'socket.io-client';
import { waitForAuth, syncUserProfile } from './authUtils';

// Bug #5: Module-level singleton channel to prevent message loss
// REMOVED: appSyncChannel now managed via useRef in App component to prevent leaks across hot reloads

const phases = [
  "Synthesizing Clinical Interaction...",
  "Cross-Referencing NCBI Evidence Base...",
  "Applying Facilitator Scoring Rubric...",
  "Generating Evidence-Based Insights...",
  "Finalizing Performance Analytics..."
];

/**
 * Aggressively strips large fields from the simulation config to ensure
 * the Firestore document stays under the 1MB limit.
 */
const stripLargeConfig = (config: SimulationConfig | null): any => {
  if (!config) return null;

  const truncateLargeText = (text?: string, limit = 2000) => {
    if (text && text.length > limit) {
      return text.substring(0, limit) + "... [TRUNCATED FOR SYNC]";
    }
    return text;
  };

  const strippedScenario = config.scenario ? {
    id: config.scenario.id,
    title: config.scenario.title,
    description: truncateLargeText(config.scenario.description, 500),
    specialties: config.scenario.specialties || [],
    isCustom: config.scenario.isCustom,
    patientProfile: {
      name: config.scenario.patientProfile.name,
      age: config.scenario.patientProfile.age,
      gender: config.scenario.patientProfile.gender,
      race: config.scenario.patientProfile.race,
      religion: config.scenario.patientProfile.religion,
      medicalHistory: truncateLargeText(config.scenario.patientProfile.medicalHistory, 1000),
      currentSymptoms: truncateLargeText(config.scenario.patientProfile.currentSymptoms, 1000)
    },
    learningObjectives: (config.scenario.learningObjectives || []).slice(0, 5).map(obj => truncateLargeText(obj, 100)),
    sourceAuthors: truncateLargeText(config.scenario.sourceAuthors, 200),
    attachedImages: (config.scenario.attachedImages || []).slice(0, 2).map(img => {
      if (img.imageUrl && img.imageUrl.length > 1000) {
        return { title: img.title, _hasLargeUrl: true };
      }
      return { title: img.title, imageUrl: img.imageUrl };
    }),
    attachedDocs: (config.scenario.attachedDocs || []).slice(0, 2).map(doc => {
      return { name: doc.name, content: truncateLargeText(doc.content, 500) };
    }),
    knowledgeBase: truncateLargeText(config.scenario.knowledgeBase, 500),
    debriefKnowledgeBase: truncateLargeText(config.scenario.debriefKnowledgeBase, 500),
    phases: (config.scenario.phases || []).slice(0, 3).map(p => ({
      id: p.id,
      label: p.label,
      triggerCondition: truncateLargeText(p.triggerCondition, 200),
      durationHint: p.durationHint,
      patientState: {
        symptoms: truncateLargeText(p.patientState.symptoms, 300),
        emotion: p.patientState.emotion,
        vitalsTrend: truncateLargeText(p.patientState.vitalsTrend, 300)
      },
      expectedLearnerActions: (p.expectedLearnerActions || []).slice(0, 5).map(a => truncateLargeText(a, 100)),
      escalationTriggers: (p.escalationTriggers || []).slice(0, 2).map(t => ({
        ifLearnerDoes: truncateLargeText(t.ifLearnerDoes, 200),
        thenPatientResponse: truncateLargeText(t.thenPatientResponse, 200),
        ifLearnerFails: truncateLargeText(t.ifLearnerFails, 200),
        thenPatientDeteriorates: truncateLargeText(t.thenPatientDeteriorates, 200)
      }))
    }))
  } : null;

  return {
    sessionTimestamp: config.sessionTimestamp,
    scenario: strippedScenario,
    voice: config.voice,
    emotion: config.emotion,
    avatarRole: config.avatarRole,
    caregiverSubRole: config.caregiverSubRole,
    language: config.language,
    communicationStyle: config.communicationStyle,
    accent: config.accent,
    visualMode: config.visualMode,
    race: config.race,
    religion: config.religion,
    avatarAge: config.avatarAge,
    gender: config.gender,
    cognitiveTraits: config.cognitiveTraits || [],
    knowledgeBase: truncateLargeText(config.knowledgeBase, 500),
    debriefKnowledgeBase: truncateLargeText(config.debriefKnowledgeBase, 500),
    facilitatorInstructions: truncateLargeText(config.facilitatorInstructions, 500),
    avatarAppearanceNotes: truncateLargeText(config.avatarAppearanceNotes, 300),
    vocalizationNotes: truncateLargeText(config.vocalizationNotes, 300)
  };
};

const App: React.FC = () => {
  const isLearnerDisplay = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    const isLearner = params.get('learner') === 'true';
    console.log('[App] isLearnerDisplay (memo):', isLearner);
    return isLearner;
  }, []);

  const appSyncChannelRef = useRef<BroadcastChannel | null>(null);
  const socketRef = useRef<Socket | null>(null);
  if (!appSyncChannelRef.current && typeof window !== 'undefined') {
    appSyncChannelRef.current = new BroadcastChannel('simveritas-sync');
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    // Initialize Socket.io
    const socket = io(window.location.origin);
    socketRef.current = socket;
    socket.on('connect', () => {
      console.log('[App] Socket connected:', socket.id);
      setIsSocketConnected(true);
      socket.emit('join-room', 'global-sync');
    });

    socket.on('disconnect', () => {
      console.log('[App] Socket disconnected');
      setIsSocketConnected(false);
    });

    socket.on('simulation-update', (data: any) => {
      if (isLearnerDisplay) {
        console.log('[App] Learner: Socket sync data received', data);
        if (data.isSimulating) {
          if (data.config) {
            setConfig(data.config);
            setIsSimulating(true);
            if (data.sessionTimestamp) setSessionTimestamp(data.sessionTimestamp);
          }
        } else {
          handleEndSimulation();
        }
      }
    });

    return () => {
      appSyncChannelRef.current?.close();
      appSyncChannelRef.current = null;
      socket.disconnect();
    };
  }, [isLearnerDisplay]);

  const [customScenarios, setCustomScenarios] = useState<Scenario[]>([]);
  const [bufferScenario, setBufferScenario] = useState<Scenario | null>(null);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(DEFAULT_SCENARIOS[0].id);
  const [savedReports, setSavedReports] = useState<SavedReport[]>([]);
  
  const analyticsData = useMemo<AnalyticsData[]>(() => {
    return savedReports.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      scenarioTitle: r.scenarioTitle,
      patientName: r.patientName,
      overallScore: r.report.overallScore || 0,
      clinicalAccuracy: r.report.clinicalAccuracy || 0,
      communicationScore: r.report.communicationScore || 0,
      evidenceBasedScore: r.report.evidenceBasedScore || 0
    }));
  }, [savedReports]);

  const [config, setConfig] = useState<SimulationConfig | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const sessionStr = localStorage.getItem('simveritas_session');
      const params = new URLSearchParams(window.location.search);
      const isLearner = params.get('learner') === 'true';
      
      if (sessionStr) {
        const session = JSON.parse(sessionStr);
        console.log(`[App] Initializing config (isLearner: ${isLearner}):`, session.isSimulating ? 'simulating' : 'not simulating');
        return session.config || null;
      }
      
      // Fallback to old keys if session not found
      const saved = localStorage.getItem('simveritas_config');
      console.log(`[App] Initializing config fallback (isLearner: ${isLearner}):`, saved ? 'found' : 'not found');
      if (saved && saved !== 'null') return JSON.parse(saved);
      
      return null;
    } catch (e) {
      console.error('[App] Failed to parse simulation session:', e);
      return null;
    }
  });

  const [isSimulating, setIsSimulating] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const sessionStr = localStorage.getItem('simveritas_session');
      const params = new URLSearchParams(window.location.search);
      const isLearner = params.get('learner') === 'true';
      
      if (sessionStr) {
        const session = JSON.parse(sessionStr);
        const isSim = !!(session.isSimulating && session.config);
        console.log(`[App] Initializing isSimulating (isLearner: ${isLearner}):`, isSim);
        return isSim;
      }
      
      // Fallback to old keys
      const sim = localStorage.getItem('simveritas_is_simulating');
      const conf = localStorage.getItem('simveritas_config');
      const isSim = sim === 'true' && !!conf && conf !== 'null';
      console.log(`[App] Initializing isSimulating fallback (isLearner: ${isLearner}):`, isSim);
      return isSim;
    } catch (e) {
      return false;
    }
  });

  const [sessionTimestamp, setSessionTimestamp] = useState<number>(() => {
    if (typeof window === 'undefined') return Date.now();
    try {
      const sessionStr = localStorage.getItem('simveritas_session');
      if (sessionStr) {
        const session = JSON.parse(sessionStr);
        return session.timestamp || Date.now();
      }
      return Date.now();
    } catch (e) {
      return Date.now();
    }
  });

  // Global Error Handling for Async Errors
  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const errStr = String(reason);
      const errStack = reason instanceof Error ? reason.stack : 'No stack trace';
      
      // Ignore benign errors
      if (errStr.includes("failed to connect to websocket") || errStr.includes("HMR")) return;
      
      console.error('[App] Unhandled Promise Rejection:', {
        reason: reason,
        message: errStr,
        stack: errStack
      });
    };

    const handleGlobalError = (event: ErrorEvent) => {
      console.error('[App] Global Error:', event.error);
    };

    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    window.addEventListener('error', handleGlobalError);

    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.removeEventListener('error', handleGlobalError);
    };
  }, []);

  const [isLocalStorageQuotaExceeded, setIsLocalStorageQuotaExceeded] = useState(false);
  const [showQuotaDetails, setShowQuotaDetails] = useState(false);

  // Listen for quota exceeded messages from other components
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'LOCAL_STORAGE_QUOTA_EXCEEDED') {
        setIsLocalStorageQuotaExceeded(true);
      }
    };
    appSyncChannelRef.current?.addEventListener('message', handleMessage);
    return () => appSyncChannelRef.current?.removeEventListener('message', handleMessage);
  }, []);

  const safeLocalStorageSetItem = useCallback((key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
      if (isLocalStorageQuotaExceeded) setIsLocalStorageQuotaExceeded(false);
    } catch (e: any) {
      if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        console.warn(`[App] LocalStorage quota exceeded for key: ${key}. Attempting cleanup...`);
        setIsLocalStorageQuotaExceeded(true);
        // Cleanup strategy: Remove all keys starting with 'sim_' that are NOT for the current session
        const currentSessionPrefix = `_${sessionTimestamp}`;
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('sim_') || k.startsWith('simveritas_')) && !k.endsWith(currentSessionPrefix)) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        
        // Try again after cleanup
        try {
          localStorage.setItem(key, value);
          setIsLocalStorageQuotaExceeded(false);
        } catch (retryErr) {
          console.error(`[App] LocalStorage quota still exceeded after cleanup for key: ${key}`, retryErr);
          setIsLocalStorageQuotaExceeded(true);
        }
      } else {
        console.error(`[App] LocalStorage error for key: ${key}`, e);
      }
    }
  }, [sessionTimestamp, isLocalStorageQuotaExceeded]);


  const currentScenarioIdRef = useRef<string | null>(config?.scenario.id || null);
  useEffect(() => {
    if (config?.scenario.id) {
      currentScenarioIdRef.current = config.scenario.id;
    }
  }, [config]);

  const [feedbackReport, setFeedbackReport] = useState<FeedbackReport | null>(null);
  const [archivedReportData, setArchivedReportData] = useState<{scenarioTitle: string, patientName: string} | null>(null);
  const [isGeneratingFeedback, setIsGeneratingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const ncbiPmidsRef = useRef<string[]>([]);
  const [notification, setNotification] = useState<{ message: string; type: 'error' | 'success' } | null>(null);
  const [loadingPhase, setLoadingPhase] = useState(0);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [isLoaded, setIsLoaded] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('learner') === 'true';
  });

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showTerminateConfirm, setShowTerminateConfirm] = useState(false);
  const [simStatus, setSimStatus] = useState<SimulationStatus>({ isLive: false, isConnecting: false, statusMsg: 'Standby', hasHistory: false });
  const [user, setUser] = useState<User | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  // Handle Firebase Auth
  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (firebaseUser) => {
      console.log('[App] Auth state changed:', firebaseUser?.email);
      setUser(firebaseUser);
      setIsAuthLoading(false);
      
      if (firebaseUser) {
        try {
          await syncUserProfile(firebaseUser);
        } catch (err) {
          console.error('[App] Error syncing user profile:', err);
        }
      }
    });

    return () => unsubscribe();
  }, []);

  const handleSignIn = async () => {
    try {
      setIsAuthLoading(true);
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      console.error('[App] Sign in error:', err);
      setNotification({ message: 'Failed to sign in. Please try again.', type: 'error' });
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setIsMenuOpen(false);
    } catch (err: any) {
      console.error('[App] Sign out error:', err);
    }
  };

  const lastAppFirestoreSyncRef = useRef<number>(0);
  const appSyncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastAppUpdateRef = useRef<number>(0);
  const prevIsSimulatingRef = useRef<boolean>(false);
  const justStartedRef = useRef(false);

  const isQuotaExceeded = useFirestoreQuota();

  // 1. Facilitator: Listen for REQUEST_APP_STATE from new learner windows
  useEffect(() => {
    if (isLearnerDisplay || !appSyncChannelRef.current) return;
    
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'REQUEST_APP_STATE') {
        console.log('[App] Facilitator: Received REQUEST_APP_STATE, broadcasting current simulation state');
        if (isSimulatingRef.current && configRef.current) {
          appSyncChannelRef.current?.postMessage({
            type: 'SIMULATION_STARTED',
            config: stripLargeConfig(configRef.current),
            timestamp: sessionTimestampRef.current
          });
        } else {
          appSyncChannelRef.current?.postMessage({ type: 'SIMULATION_ENDED' });
        }
      }
    };

    const ch = appSyncChannelRef.current;
    ch.addEventListener('message', handleMessage);
    return () => {
      ch.removeEventListener('message', handleMessage);
    };
  }, [isLearnerDisplay]);

  const syncAppToFirestore = useCallback(async (force = false) => {
    if (isLearnerDisplay) return;
    // if (!user) {
    //   console.warn('[App] Facilitator not authenticated, skipping Firestore sync');
    //   return;
    // }
    
    // Skip the duplicate write immediately after handleStartSimulation
    if (justStartedRef.current) {
      justStartedRef.current = false;
      return;
    }

    const now = Date.now();
    
    const isCriticalChange = isSimulating !== prevIsSimulatingRef.current;
    prevIsSimulatingRef.current = isSimulating;

    // If quota is exceeded, ONLY allow critical changes or forced syncs
    if (isQuotaExceeded && !force && !isCriticalChange) return;

    // Use a much shorter throttle for App-level sync (3 seconds)
    // and ALWAYS force sync on critical changes (start/stop)
    if (!force && !isCriticalChange && now - lastAppFirestoreSyncRef.current < 3000) {
      if (!appSyncTimeoutRef.current) {
        appSyncTimeoutRef.current = setTimeout(() => {
          appSyncTimeoutRef.current = null;
          syncAppToFirestore(true);
        }, 3000);
      }
      return;
    }

    lastAppFirestoreSyncRef.current = now;
    try {
      const syncDoc = doc(db, 'sync', 'simulation');
      
      const strippedConfig = stripLargeConfig(config);

      const payload = {
        isSimulating,
        config: strippedConfig,
        sessionTimestamp,
        isComplete: !!feedbackReport,
        lastUpdate: Date.now(),
        type: 'APP_STATE'
      };

      // Sync via Socket.io (Reliable, high-frequency, cross-browser, no size limit)
      if (socketRef.current) {
        socketRef.current.emit('sync-simulation', {
          ...payload,
          config: config // NO TRUNCATION FOR SOCKETS
        });
      }

      console.log('[App] Facilitator: Syncing state to Firestore', payload);
      await setDoc(syncDoc, payload, {}, true).catch(err => handleFirestoreError(err, OperationType.WRITE, 'sync/simulation'));
    } catch (err: any) {
      // Bug #8: Log, don't throw, in sync handlers
      console.error('[App] syncAppToFirestore error:', err);
    }
  }, [isSimulating, config, isLearnerDisplay, sessionTimestamp, feedbackReport, isQuotaExceeded, user]);

  // 2. Facilitator: Sync state to Firestore and localStorage
  useEffect(() => {
    if (isLearnerDisplay) return;

    // Fix 4: Remove !user guard.
    // Facilitators must be able to sync their local state to Firestore immediately
    // upon starting a simulation, even if Google sign-in hasn't completed.
    
    const sync = async () => {
      await syncAppToFirestore();
      
      // Also keep localStorage as fallback for facilitator
      const session = {
        isSimulating,
        config,
        timestamp: sessionTimestamp
      };
      safeLocalStorageSetItem('simveritas_session', JSON.stringify(session));
    };
    sync();
    
    return () => {
      if (appSyncTimeoutRef.current) clearTimeout(appSyncTimeoutRef.current);
    };
  }, [isSimulating, config, isLearnerDisplay, sessionTimestamp, feedbackReport, syncAppToFirestore]);

  const simRoomRef = useRef<SimulationRoomHandle>(null);
  const dashboardRef = useRef<DashboardHandle>(null);
  const initLinkRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isGeneratingFeedback) {
      const interval = setInterval(() => {
        setLoadingPhase((prev) => (prev + 1) % phases.length);
      }, 3000);
      return () => clearInterval(interval);
    } else {
      setLoadingPhase(0);
    }
  }, [isGeneratingFeedback, phases.length]);

  const isSimulatingRef = useRef(isSimulating);
  const configRef = useRef(config);
  const sessionTimestampRef = useRef(sessionTimestamp);

  useEffect(() => { isSimulatingRef.current = isSimulating; }, [isSimulating]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { sessionTimestampRef.current = sessionTimestamp; }, [sessionTimestamp]);

  const [isChannelReady, setIsChannelReady] = useState(false);
  const [isSocketConnected, setIsSocketConnected] = useState(false);

  // Sync simulation state for dual-screen mode
  useEffect(() => {
    if (!isLearnerDisplay || !appSyncChannelRef.current) return;

    setIsChannelReady(true);

    // 1. On mount: read localStorage synchronously
    const raw = localStorage.getItem('simveritas_session');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data.isSimulating && data.config) {
          console.log('[App] Learner: Initial sync from localStorage');
          setConfig(data.config);
          setIsSimulating(true);
          if (data.timestamp) setSessionTimestamp(data.timestamp);
        }
      } catch (err) {
        console.error('[App] Initial sync error:', err);
      }
    }

    // 2. Open ONE BroadcastChannel and keep it open
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'SIMULATION_STARTED' && e.data.config) {
        // 3. On SIMULATION_STARTED message
        console.log('[App] Learner: Synced from BroadcastChannel (STARTED)', {
          timestamp: e.data.timestamp
        });
        setConfig(e.data.config);
        setIsSimulating(true);
        if (e.data.timestamp) {
          setSessionTimestamp(e.data.timestamp);
          lastAppUpdateRef.current = e.data.timestamp;
        }
        setFeedbackReport(null);
      } else if (e.data?.type === 'SIMULATION_ENDED') {
        // 4. On SIMULATION_ENDED message
        console.log('[App] Learner: Synced from BroadcastChannel (ENDED)');
        handleEndSimulation();
      } else if (e.data?.type === 'LOCAL_STORAGE_QUOTA_EXCEEDED') {
        setIsLocalStorageQuotaExceeded(true);
      }
    };

    const ch = appSyncChannelRef.current;
    ch.addEventListener('message', handleMessage);

    // 2.5 Request state on mount with multiple retries
    console.log('[App] Learner: Sending REQUEST_APP_STATE');
    ch.postMessage({ type: 'REQUEST_APP_STATE' });
    
    const t1 = setTimeout(() => ch.postMessage({ type: 'REQUEST_APP_STATE' }), 500);
    const t2 = setTimeout(() => ch.postMessage({ type: 'REQUEST_APP_STATE' }), 2000);
    const t3 = setTimeout(() => ch.postMessage({ type: 'REQUEST_APP_STATE' }), 5000);

    // 6. Cleanup
    return () => {
      ch.removeEventListener('message', handleMessage);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      setIsChannelReady(false);
    };
  }, [isLearnerDisplay]);

  // Firestore sync for learner in App.tsx
  useEffect(() => {
    if (!isLearnerDisplay) return;

    console.log('[App] Learner: Starting Firestore sync');
    const syncDoc = doc(db, 'sync', 'simulation');
    
    // Bug #8: Log, don't throw, in onSnapshot error callback to prevent permanent detachment
    const unsubscribe = onSnapshot(syncDoc, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        console.log('[App] Learner: Firestore sync data received', {
          isSimulating: data.isSimulating,
          hasConfig: !!data.config,
          sessionTimestamp: data.sessionTimestamp,
          lastUpdate: data.lastUpdate
        });
        
        if (data.lastUpdate) {
          const currentLatency = Date.now() - data.lastUpdate;
          setLatency(currentLatency);
        }

        if (data.isSimulating !== undefined) {
          if (data.isSimulating) {
            if (data.config) {
              console.log('[App] Learner: Simulation active, setting state');
              setConfig(data.config);
              setIsSimulating(true);
              if (data.sessionTimestamp) setSessionTimestamp(data.sessionTimestamp);
            } else {
              console.warn('[App] Learner: isSimulating is true but config is missing in Firestore');
              // If we don't have config, we can't simulate.
              // But we don't want to end simulation if it's just a partial update.
            }
          } else {
            console.log('[App] Learner: Simulation ended via Firestore signal');
            handleEndSimulation();
          }
        }
      } else {
        console.warn('[App] Learner: Firestore sync doc does not exist');
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'sync/simulation');
    });

    return () => {
      unsubscribe();
    };
  }, [isLearnerDisplay]);

  const handleForceSync = async () => {
    if (!isLearnerDisplay) return;
    console.log('[App] Learner: Manual force sync requested...');
    try {
      const syncDoc = doc(db, 'sync', 'simulation');
      const snapshot = await getDoc(syncDoc);
      if (snapshot.exists()) {
        const data = snapshot.data();
        // Fix 6: Remove type === 'APP_STATE' guard.
        console.log('[App] Learner: Force sync successful', data);
        setIsSimulating(data.isSimulating);
        if (data.config) setConfig(data.config);
        if (data.sessionTimestamp) setSessionTimestamp(data.sessionTimestamp);
      } else {
        console.warn('[App] Learner: Force sync - simulation doc not found');
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'sync/simulation');
    }
  };

  const [manualApiKeyInput, setManualApiKeyInput] = useState('');
  const [apiKeyError, setApiKeyError] = useState('');

  const handleSelectKey = async () => {
    if ((window as any).aistudio) {
      await (window as any).aistudio.openSelectKey();
      const key = await getApiKey();
      if (key) { setHasApiKey(true); clearApiKeyCache(); }
      return;
    }
    // Cloud Run / standalone: use manually entered key
    const trimmed = manualApiKeyInput.trim();
    if (!trimmed) { setApiKeyError('Please enter your Gemini API key.'); return; }
    if (!trimmed.startsWith('AIza')) { setApiKeyError('Invalid key format. Gemini API keys start with "AIza".'); return; }
    (window as any).__API_KEY__ = trimmed;
    (window as any).__GEMINI_API_KEY__ = trimmed;
    setApiKeyError('');
    setHasApiKey(true);
  };

  const handleSaveScenario = (scenario: Scenario) => {
    setCustomScenarios(prev => {
      const exists = prev.find(s => s.id === scenario.id);
      if (exists) {
        return prev.map(s => s.id === scenario.id ? scenario : s);
      }
      return [scenario, ...prev];
    });
  };

  const handleDeleteScenario = (id: string) => {
    setCustomScenarios(prev => prev.filter(s => s.id !== id));
  };

  const handleStartSimulation = (newConfig: SimulationConfig) => {
    const timestamp = Date.now();
    
    safeLocalStorageSetItem('simveritas_session', JSON.stringify({
      isSimulating: true,
      config: newConfig,
      timestamp
    }));
    safeLocalStorageSetItem('simveritas_is_simulating', 'true');
    safeLocalStorageSetItem('simveritas_config', JSON.stringify(newConfig));
    
    const configWithTimestamp = { ...newConfig, sessionTimestamp: timestamp };
    setConfig(configWithTimestamp);
    setIsSimulating(true);
    setSessionTimestamp(timestamp);
    setFeedbackReport(null);
    currentScenarioIdRef.current = newConfig.scenario.id;

    // Bug #5: Use module-level singleton channel
    appSyncChannelRef.current?.postMessage({
      type: 'SIMULATION_STARTED',
      config: configWithTimestamp,
      timestamp
    });

    // Sync to Socket.io for reliable large payload delivery
    socketRef.current?.emit('sync-simulation', {
      type: 'APP_STATE',
      isSimulating: true,
      config: configWithTimestamp, // NO TRUNCATION NEEDED FOR SOCKETS
      sessionTimestamp: timestamp,
      lastUpdate: timestamp
    });

    // Sync to Firestore for cross-device/session learner sync (still truncated for safety)
    const syncDoc = doc(db, 'sync', 'simulation');
    const strippedConfig = stripLargeConfig(configWithTimestamp);
    setDoc(syncDoc, {
      type: 'APP_STATE',
      isSimulating: true,
      config: strippedConfig,
      sessionTimestamp: timestamp,
      lastUpdate: timestamp
    }, {}, true)
    .then(() => {
      justStartedRef.current = true; // FIX #4: only suppress retry if first write succeeded
      console.log('[App] Startup Firestore write succeeded.');
    })
    .catch(err => {
      // Do NOT set justStartedRef — let useEffect retry
      console.warn('[App] Startup Firestore write failed, useEffect will retry:', err);
      handleFirestoreError(err, OperationType.WRITE, 'sync/simulation');
    });
  };

  // Check API key on mount
  useEffect(() => {
    if (isLearnerDisplay) {
      // Learner tab needs no API key — unblock immediately
      setIsLoaded(true);
      setHasApiKey(false);
      return;
    }
    
    // Safety timeout for API key check
    const timeoutId = setTimeout(() => {
      if (!isLoaded) {
        console.warn('[App] API key check timed out, unblocking UI');
        setIsLoaded(true);
      }
    }, 8000);

    const checkKey = async () => {
      try {
        const key = await getApiKey();
        setHasApiKey(!!key);
      } catch (e) {
        console.error('[App] API key check failed:', e);
      } finally {
        clearTimeout(timeoutId);
        setIsLoaded(true);
      }
    };
    checkKey();
    
    return () => clearTimeout(timeoutId);
  }, [isLearnerDisplay]);

  // Close menu on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isMenuOpen && !(event.target as Element).closest('.menu-container')) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  // Global persistence handler
  useEffect(() => {
    const loadInitialData = async () => {
      // 1. Load Scenarios
      try {
        const res = await fetch('/api/scenarios');
        if (res.ok) {
          const serverScenarios = await res.json();
          if (Array.isArray(serverScenarios)) {
            const migrated = serverScenarios.map((s: any) => {
              if (s.attachedImages && s.attachedImages.length > 0 && typeof s.attachedImages[0] === 'string') {
                return {
                  ...s,
                  attachedImages: s.attachedImages.map((url: string, idx: number) => ({
                    title: `Extracted Image ${idx}`,
                    imageUrl: url
                  }))
                };
              }
              return s;
            });
            setCustomScenarios(migrated);
          }
        }
      } catch (e) {
        console.error('Failed to fetch scenarios from server, falling back to localStorage', e);
        const savedScenarios = localStorage.getItem('simveritas_custom_scenarios');
        if (savedScenarios) {
          try {
            setCustomScenarios(JSON.parse(savedScenarios));
          } catch (err) {
            console.error('Failed to parse local scenarios');
          }
        }
      }

      // 2. Load Reports
      try {
        const res = await fetch('/api/reports');
        if (res.ok) {
          const serverReports = await res.json();
          if (Array.isArray(serverReports)) {
            setSavedReports(serverReports);
          }
        }
      } catch (e) {
        console.error('Failed to fetch reports from server, falling back to localStorage', e);
        const savedReportsData = localStorage.getItem('simveritas_saved_reports');
        if (savedReportsData) {
          try {
            setSavedReports(JSON.parse(savedReportsData));
          } catch (err) {
            console.error('Failed to parse local reports');
          }
        }
      }

      // 3. Restore active session if available
      const savedSession = localStorage.getItem('simveritas_session');
      if (savedSession) {
        try {
          const data = JSON.parse(savedSession);
          if (data.isSimulating && data.config) {
            console.log('[App] Restoring active session from localStorage');
            setConfig(data.config);
            setIsSimulating(true);
            if (data.timestamp) setSessionTimestamp(data.timestamp);
          }
        } catch (e) {
          console.error('[App] Failed to restore session:', e);
        }
      }
    };

    loadInitialData();
  }, []);

  // Save scenarios to localStorage and Server
  useEffect(() => {
    // Always persist even if empty to allow deletions to stick
    safeLocalStorageSetItem('simveritas_custom_scenarios', JSON.stringify(customScenarios));
    fetch('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customScenarios)
    }).catch(err => console.error('Failed to save scenarios to server', err));
  }, [customScenarios]);

  // Save reports to localStorage and Server
  useEffect(() => {
    // Always persist even if empty to allow deletions to stick
    safeLocalStorageSetItem('simveritas_saved_reports', JSON.stringify(savedReports));
    fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savedReports)
    }).catch(err => console.error('Failed to save reports to server', err));
  }, [savedReports]);

  // Focus initLink when simulation starts
  useEffect(() => {
    if (isSimulating && !isLearnerDisplay && !simStatus.isLive) {
      setTimeout(() => {
        initLinkRef.current?.focus();
      }, 500);
    }
  }, [isSimulating, isLearnerDisplay, simStatus.isLive]);

  const trimKnowledgeBase = (kb: string, maxChars = 8000): string => {
    if (kb.length <= maxChars) return kb;
    // Take first 4000 and last 4000 chars to preserve intro and conclusions
    return kb.slice(0, 4000) + '\n\n[...content trimmed for context...]\n\n' 
           + kb.slice(-4000);
  };

  const trimHistory = (history: TranscriptionEntry[], maxEntries = 40): TranscriptionEntry[] => {
    if (history.length <= maxEntries) return history;
    // Keep the first 5 (context) and last 35 (recent) entries
    return [...history.slice(0, 5), ...history.slice(-(maxEntries - 5))];
  };

  const fetchNCBIEvidence = async (
    config: SimulationConfig
  ): Promise<string> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

    try {
      // Build a targeted clinical query from scenario data
      const symptoms = config.scenario.patientProfile.currentSymptoms
        .split('.')[0].trim();
      const specialty = config.scenario.specialties[0];
      const age = config.scenario.patientProfile.age;
      const gender = config.scenario.patientProfile.gender;
      
      // Build a clinically specific query
      const query = `${symptoms} patient age ${age} ${gender} diagnosis treatment`;
      
      const res = await fetch(
        `/api/ncbi/evidence?q=${encodeURIComponent(query)}&specialty=${encodeURIComponent(specialty)}`,
        { signal: controller.signal }
      );
      
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error('NCBI fetch failed');
      
      const data = await res.json();
      
      // Store PMIDs for source citation after feedback generation
      if (data.pmids && data.pmids.length > 0) {
        ncbiPmidsRef.current = data.pmids;
      }
      
      if (data.evidence && data.evidence.length > 100) {
        console.log('NCBI evidence fetched successfully');
        const sourceList = (data.titles || []).map((t: string, i: number) => `${i + 1}. ${t} (PMID: ${data.pmids[i]})`).join('\n');
        return `
=== LIVE EVIDENCE BASE FROM NCBI (PubMed + StatPearls) ===
Retrieved: ${new Date().toLocaleDateString()}
Specialty: ${specialty}
Clinical Query: ${query}

AVAILABLE SOURCES:
${sourceList}

${data.evidence}
=== END NCBI EVIDENCE ===
        `;
      }
      return '';
    } catch (e) {
      clearTimeout(timeoutId);
      console.warn('NCBI evidence fetch failed or timed out, proceeding without live guidelines:', e);
      return '';
    }
  };

  const fetchNCBISources = async (
    pmids: string[]
  ): Promise<NCBISource[]> => {
    if (!pmids || pmids.length === 0) return [];
    try {
      const res = await fetch(
        `/api/ncbi/sources?pmids=${pmids.slice(0, 8).join(',')}`
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.sources || [];
    } catch (e) {
      console.warn('Failed to fetch NCBI source metadata:', e);
      return [];
    }
  };

  const generateFeedback = async (history: TranscriptionEntry[], finalConfig: SimulationConfig) => {
    setIsGeneratingFeedback(true);
    setFeedbackError(null);
    const maxRetries = 3;
    let attempt = 0;

    const execute = async () => {
      try {
        // Fetch live NCBI evidence in parallel with feedback generation setup
        let ncbiEvidence = await fetchNCBIEvidence(finalConfig);
        
        // Trim NCBI evidence if it's excessively large to stay within token limits
        if (ncbiEvidence.length > 15000) {
          ncbiEvidence = ncbiEvidence.substring(0, 15000) + "\n... [Evidence truncated for token limits] ...";
        }

        const modelsToTry = ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview', 'gemini-flash-latest'];
        const currentModel = modelsToTry[Math.min(attempt, modelsToTry.length - 1)];
        
        const apiKey = await getApiKey();
        if (!apiKey) throw new Error("No API Key available");
        
        const ai = new GoogleGenAI({ apiKey });
        const clinicalHistory = trimHistory(history.filter(h => h.role !== 'facilitator'));
        
        console.log(`Synthesizing feedback using model: ${currentModel} (Attempt ${attempt + 1})`);
        
        const prompt = `
          Analyze the clinical encounter between a learner and ${finalConfig.scenario.patientProfile.name}.
          
          LEARNING OBJECTIVES (Checklist for assessment):
          ${finalConfig.scenario.learningObjectives.map(obj => `- ${obj}`).join('\n')}
          
          MANDATORY SCORING RUBRIC - ZERO TOLERANCE FOR OMISSION:
          ${trimKnowledgeBase(finalConfig.debriefKnowledgeBase || "")}

          RUBRIC ENFORCEMENT RULES:
          1. You MUST assess EVERY numbered item or criterion in the rubric above.
          2. For each criterion: state whether it was MET, PARTIALLY MET, or MISSED.
          3. If a criterion was not attempted by the learner, it counts as MISSED and MUST appear in improvements.
          4. The overallScore MUST mathematically reflect the percentage of rubric criteria that were fully MET.
          5. If no rubric is provided, use current evidence-based guidelines for ${finalConfig.scenario.specialties.join(', ')}.
          6. Cite the specific rubric line or guideline for every clinicalAnalysis entry.

          ${ncbiEvidence ? `
          LIVE EVIDENCE BASE (auto-fetched from NCBI PubMed + StatPearls):
          ${ncbiEvidence}

          INSTRUCTIONS FOR EVIDENCE-BASED EVALUATION:
          1. Cross-reference every learner action against the above evidence.
          2. If learner followed current guidelines: note it as a strength with the specific guideline reference.
          3. If learner deviated from guidelines: note it as an improvement with the correct evidence-based action cited.
          4. In clinicalAnalysis, add which guideline or study supports your assessment of each action.
          5. If rubric AND NCBI evidence both exist, use the rubric as the primary scoring framework and NCBI evidence as supporting context.

          EVIDENCE HIERARCHY (MANDATORY — follow this order strictly):
          Priority 1 — Society Practice Guidelines 
            (AHA, ACC, ASCO, AAP, ACEP, IDSA, AAN, ACOG, ADA, etc.)
          Priority 2 — National Clinical Guidelines 
            (NICE, CDC, NIH, WHO, USPSTF, AHRQ)
          Priority 3 — Consensus Statements and Joint Guidelines
          Priority 4 — Meta-Analyses and Systematic Reviews
          Priority 5 — Individual Clinical References

          CITATION FORMAT RULES (MANDATORY):
          1. In every clinicalAnalysis entry, the guidelineReference field 
             MUST follow this EXACT format:
             "[Full Official Guideline Name] — PMID [number]"
             Example: "2023 AHA/ACC Chest Pain Guidelines — PMID 36334838"
             Example: "NICE Guideline NG185: Acute Coronary Syndromes — PMID 34714612"
             Example: "CDC Clinical Guidelines for Sepsis Management — PMID 33769999"

          2. If multiple sources are available, ALWAYS cite the 
             highest-authority source first (Society > National > Consensus).

          3. The sourceTypeBadge field must contain EXACTLY one of:
             "Society Practice Guideline"
             "National Clinical Guideline" 
             "Consensus Statement"
             "Clinical Practice Guideline"
             "Meta-Analysis"
             "Systematic Review"
             "Clinical Reference"

          4. NEVER fabricate a PMID. If you are uncertain of the exact PMID
             from the evidence provided, write "See PubMed" instead of 
             inventing a number.

          5. evidenceBasedScore must specifically reflect how closely the 
             learner followed the HIGHEST AUTHORITY source available 
             (Priority 1 or 2 above). Do not average against lower-tier 
             sources if a society guideline exists.

          AUTHORITATIVE EVIDENCE BASE:
          ${ncbiEvidence}

          ${finalConfig.debriefKnowledgeBase ? `
          FACILITATOR RUBRIC (use alongside guidelines above):
          ${trimKnowledgeBase(finalConfig.debriefKnowledgeBase)}
          ` : ''}
          ` : `
          EVALUATION GUIDELINES:
          Use standard evidence-based clinical practice guidelines and medical consensus for ${finalConfig.scenario.specialties.join(', ')}.
          `}

          CLINICAL CONTEXT:
          - Patient: ${finalConfig.scenario.patientProfile.name} (${finalConfig.scenario.patientProfile.age} ${finalConfig.scenario.patientProfile.gender})
          - Medical History: ${finalConfig.scenario.patientProfile.medicalHistory}
          - Current Presentation: ${finalConfig.scenario.patientProfile.currentSymptoms}
          - Specialties Involved: ${finalConfig.scenario.specialties.join(', ')}
          ${finalConfig.cognitiveTraits && finalConfig.cognitiveTraits.length > 0 ? `- Behavioral Traits: ${finalConfig.cognitiveTraits.join(', ')}` : ''}

          TRANSCRIPT (US English):
          ${clinicalHistory.map(h => `${h.role === 'user' ? 'Learner' : 'Participant'}: ${h.text}`).join('\n')}

          TASK:
          Provide a structured clinical debrief in US English. 
          In the 'clinicalAnalysis' section, you MUST explicitly assess each of the Learning Objectives listed above as individual entries.
          Focus on medical accuracy, clinical reasoning, and therapeutic communication.

          RULES:
          1. Professional tense: Actions in PAST TENSE; medical consensus in PRESENT TENSE.
          2. Format: Strict JSON matching the requested schema.
          3. Tone: Constructive, professional, and empathetic.
        `;

        const result = await ai.models.generateContent({
          model: currentModel, 
          contents: [{ parts: [{ text: prompt }] }],
          config: {
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
              improvements: { type: Type.ARRAY, items: { type: Type.STRING } },
              clinicalAnalysis: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    action: { type: Type.STRING },
                    appropriateness: { type: Type.STRING },
                    explanation: { type: Type.STRING },
                    guidelineReference: { type: Type.STRING, description: "EXACT format: [Guideline Name] — PMID [number]" },
                    sourceTypeBadge: { type: Type.STRING, description: "One of: Society Practice Guideline, National Clinical Guideline, Consensus Statement, Clinical Practice Guideline, Meta-Analysis, Systematic Review, Clinical Reference" }
                  },
                  required: ["action", "appropriateness", "explanation", "guidelineReference", "sourceTypeBadge"]
                }
              },
              overallScore: { type: Type.NUMBER },
              clinicalAccuracy: { type: Type.NUMBER },
              communicationScore: { type: Type.NUMBER },
              evidenceBasedScore: { type: Type.NUMBER, description: "0-100, measures how closely learner followed uploaded guidelines vs general medical knowledge" },
              keyInsights: { type: Type.ARRAY, items: { type: Type.STRING } },
              evidenceSources: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    pmid: { type: Type.STRING },
                    title: { type: Type.STRING },
                    sourceType: { type: Type.STRING }
                  },
                  required: ["pmid", "title"]
                }
              },
            },
            required: ["summary", "strengths", "improvements", "clinicalAnalysis", "overallScore", "clinicalAccuracy", "communicationScore", "evidenceBasedScore", "keyInsights", "evidenceSources"]
          }
        }
      });

        if (!result.text) throw new Error("Empty response from AI model");
        const jsonText = result.text.replace(/```json\n?|```/g, '').trim();
        const parsedReport = JSON.parse(jsonText);

        // Extract PMIDs that the AI actually cited
        const citedPmids = new Set<string>();
        const validPmids = new Set(ncbiPmidsRef.current);
        
        // Scan clinicalAnalysis for PMIDs in guidelineReference
        if (Array.isArray(parsedReport.clinicalAnalysis)) {
          parsedReport.clinicalAnalysis.forEach((item: any) => {
            const match = item.guidelineReference?.match(/PMID\s*(\d+)/i);
            if (match) {
              const pmid = match[1];
              // Only include if it was in our original search results to prevent hallucinations
              if (validPmids.has(pmid)) {
                citedPmids.add(pmid);
              }
            }
          });
        }

        // Also check evidenceSources array from AI for valid PMIDs
        if (Array.isArray(parsedReport.evidenceSources)) {
          parsedReport.evidenceSources.forEach((s: any) => {
            if (s.pmid && validPmids.has(s.pmid)) {
              citedPmids.add(s.pmid);
            }
          });
        }

        // Use cited PMIDs if available, otherwise fallback to search results
        const pmidsToFetch = citedPmids.size > 0 
          ? Array.from(citedPmids) 
          : ncbiPmidsRef.current;

        // Fetch source citations in background 
        const sources = await fetchNCBISources(pmidsToFetch);
        
        // Final filter: ensure the report only includes sources we successfully fetched
        const fetchedPmids = new Set(sources.map(s => s.pmid));
        
        setFeedbackReport({ 
          ...parsedReport,
          evidenceSources: sources,
          // Clean up clinicalAnalysis references if they point to PMIDs we couldn't fetch
          clinicalAnalysis: (parsedReport.clinicalAnalysis || []).map((item: any) => {
            const match = item.guidelineReference?.match(/PMID\s*(\d+)/i);
            if (match && !fetchedPmids.has(match[1])) {
              return { ...item, guidelineReference: item.guidelineReference.split(' - PMID')[0] };
            }
            return item;
          })
        });
        ncbiPmidsRef.current = []; // Reset for next session
        setIsSimulating(false);
        setIsGeneratingFeedback(false);
      } catch (err: any) {
        const errStr = JSON.stringify(err) || err?.toString() || "";
        const errMessage = err?.message || "";
        const errStatus = err?.status || err?.error?.code || err?.code || (err?.error ? JSON.parse(JSON.stringify(err.error)).code : null);
        
        const isRetryable = errStr.includes("503") || 
                      errMessage.includes("503") || 
                      errStatus === 503 || 
                      errStr.includes("500") ||
                      errMessage.includes("500") ||
                      errStatus === 500 ||
                      errStr.includes("UNAVAILABLE") || 
                      errMessage.includes("UNAVAILABLE") || 
                      errStr.includes("INTERNAL") ||
                      errMessage.includes("INTERNAL") ||
                      errStr.includes("high demand") || 
                      errMessage.includes("high demand") ||
                      errStr.includes("overloaded");
        
        const modelsToTry = ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview', 'gemini-flash-latest'];
        const currentModel = modelsToTry[Math.min(attempt, modelsToTry.length - 1)];

        if (isRetryable && attempt < maxRetries) {
          attempt++;
          const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);
          console.warn(`Model ${currentModel} busy (Attempt ${attempt}). Retrying in ${Math.round(delay)}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return execute();
        }

        console.error(err);
        const isKeyError = errStr.includes("entity was not found") || 
                           errStr.includes("PERMISSION_DENIED") || 
                           errStr.includes("403") || 
                           errStatus === 403 || 
                           errMessage.toLowerCase().includes("permission");

        if (isKeyError && (window as any).aistudio) {
          (window as any).aistudio.openSelectKey();
        }
        
        setFeedbackError('Feedback synthesis failed. Your interaction history has been saved locally. Please try to finalize again in a few moments.');
        setIsSimulating(false);
        setIsGeneratingFeedback(false);
      }
    };

    await execute();
  };

  const handleEndSimulation = useCallback((history?: TranscriptionEntry[], finalConfig?: SimulationConfig) => {
    const timestamp = Date.now();
    
    // Clear any active timers/intervals
    if (appSyncTimeoutRef.current) {
      clearTimeout(appSyncTimeoutRef.current);
      appSyncTimeoutRef.current = null;
    }

    safeLocalStorageSetItem('simveritas_session', JSON.stringify({ isSimulating: false, config: null, timestamp }));
    safeLocalStorageSetItem('simveritas_is_simulating', 'false');
    localStorage.removeItem('simveritas_config');

    if (!isLearnerDisplay) {
      appSyncChannelRef.current?.postMessage({ type: 'SIMULATION_ENDED' });

      // Sync to Socket.io
      socketRef.current?.emit('sync-simulation', {
        type: 'APP_STATE',
        isSimulating: false,
        config: null,
        lastUpdate: timestamp
      });

      // Sync to Firestore for cross-device/session learner sync
      const syncDoc = doc(db, 'sync', 'simulation');
      setDoc(syncDoc, {
        type: 'APP_STATE',
        isSimulating: false,
        config: null,
        lastUpdate: timestamp
      }, {}, true).catch(err => {
        handleFirestoreError(err, OperationType.WRITE, 'sync/simulation');
      });

      // Clear room-specific Firestore documents on termination
      const roomStateDoc = doc(db, 'sync', 'room_state');
      const roomAssetsDoc = doc(db, 'sync', 'room_assets');
      const roomRequestsDoc = doc(db, 'sync', 'room_requests');
      
      deleteDoc(roomStateDoc).catch(() => {});
      deleteDoc(roomAssetsDoc).catch(() => {});
      deleteDoc(roomRequestsDoc).catch(() => {});
    }

    console.log('[App] handleEndSimulation called. History length:', history?.length);
    
    const scenarioId = finalConfig?.scenario.id || configRef.current?.scenario.id || currentScenarioIdRef.current;
    const sessionTimestamp = finalConfig?.sessionTimestamp || configRef.current?.sessionTimestamp;
    
    if (scenarioId) {
      console.log('[App] Explicitly clearing scenario data on termination:', scenarioId);
      
      if (sessionTimestamp) {
        localStorage.removeItem(`sim_history_${scenarioId}_${sessionTimestamp}`);
        localStorage.removeItem(`sim_transcripts_${scenarioId}_${sessionTimestamp}`);
        localStorage.removeItem(`sim_state_${scenarioId}_${sessionTimestamp}`);
        localStorage.removeItem(`sim_assets_${scenarioId}_${sessionTimestamp}`);
        localStorage.removeItem(`sim_avatar_${scenarioId}_${sessionTimestamp}`);
        localStorage.removeItem(`sim_base_identity_${scenarioId}_${sessionTimestamp}`);
        localStorage.removeItem(`simveritas_room_state_${sessionTimestamp}`);
      }
    }
    
    setIsSimulating(false);
    setConfig(null);
    setSimStatus({ isLive: false, isConnecting: false, statusMsg: 'Standby', hasHistory: false });

    if (!isLearnerDisplay && history && history.length > 0 && finalConfig) {
      console.log('[App] Proceeding to generate feedback.');
      generateFeedback(history, finalConfig).catch(err => {
        console.error('[App] Uncaught error in generateFeedback:', err);
      });
    } else {
      console.log('[App] No history or config, clearing state immediately.');
      setArchivedReportData(null);
    }
  }, [isLearnerDisplay]);

  // Risk: No tab-close signal.
  // If the facilitator's tab closes or crashes, the simulation state remains "true" in Firestore.
  // We add a beforeunload listener to signal termination.
  useEffect(() => {
    if (!isSimulating || isLearnerDisplay) return;

    const handleBeforeUnload = () => {
      // FIX #8: Write to localStorage and Firestore to signal simulation termination
      const timestamp = Date.now();
      safeLocalStorageSetItem('simveritas_session', JSON.stringify({ isSimulating: false, lastUpdate: timestamp }));
      
      const syncDoc = doc(db, 'sync', 'simulation');
      setDoc(syncDoc, { type: 'APP_STATE', isSimulating: false, lastUpdate: timestamp }, {}, true).catch(err => handleFirestoreError(err, OperationType.WRITE, 'sync/simulation'));
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isSimulating, isLearnerDisplay]);

  const handleSaveReport = (report: SavedReport) => {
    setSavedReports(prev => [report, ...prev]);
    setFeedbackReport(null);
    setConfig(null);
  };

  const handleDeleteReport = (id: string) => {
    setSavedReports(prev => prev.filter(r => r.id !== id));
  };

  return (
    <ErrorBoundary>
      <div id="app-root" className="h-screen w-screen flex flex-col bg-slate-950 overflow-hidden text-slate-100 font-sans print:h-auto print:overflow-visible print:bg-white">
      {(!isLoaded || (isAuthLoading && !isLearnerDisplay)) ? (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-slate-400 font-medium">Initializing SimVeritas...</p>
          </div>
        </div>
      ) : (
        <>
          {/* Quota Notices */}
          {(isQuotaExceeded || isLocalStorageQuotaExceeded) && (
            <div className="bg-amber-500/10 border-b border-amber-500/20 px-8 py-2 flex items-center justify-center gap-3 backdrop-blur-md">
              <i className="fas fa-triangle-exclamation text-amber-500 text-xs"></i>
              <p className="text-[10px] font-bold text-amber-200 uppercase tracking-widest">
                {isQuotaExceeded && isLocalStorageQuotaExceeded 
                  ? "Multiple Quotas Exceeded (Firestore & LocalStorage)." 
                  : isQuotaExceeded 
                    ? "Firestore Quota Exceeded. Real-time sync disabled." 
                    : "LocalStorage Quota Exceeded. Session persistence limited."}
                <button 
                  onClick={() => setShowQuotaDetails(true)}
                  className="ml-2 underline opacity-60 hover:opacity-100 transition-opacity"
                >
                  View Details
                </button>
              </p>
              <div className="flex gap-2">
                {isQuotaExceeded && (
                  <button 
                    onClick={() => {
                      localStorage.removeItem('simveritas_firestore_quota_exceeded');
                      localStorage.removeItem('simveritas_firestore_quota_time');
                      window.location.reload();
                    }}
                    className="px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 rounded-lg text-[9px] font-black uppercase tracking-widest transition-colors"
                  >
                    Retry Firestore
                  </button>
                )}
                {isLocalStorageQuotaExceeded && (
                  <button 
                    onClick={() => {
                      // Force a more aggressive cleanup
                      const keysToRemove: string[] = [];
                      for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        if (k && (k.startsWith('sim_') || k.startsWith('simveritas_'))) {
                          keysToRemove.push(k);
                        }
                      }
                      if (confirm("This will clear all local simulation data to free up space. Active session data may be lost. Proceed?")) {
                        keysToRemove.forEach(k => localStorage.removeItem(k));
                        setIsLocalStorageQuotaExceeded(false);
                        window.location.reload();
                      }
                    }}
                    className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-200 rounded-lg text-[9px] font-black uppercase tracking-widest transition-colors"
                  >
                    Clear Local Data
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Quota Details Modal */}
          {showQuotaDetails && (
            <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-xl z-[1000] flex items-center justify-center p-6">
              <div className="max-w-2xl w-full bg-slate-900 border border-white/10 rounded-[2.5rem] p-10 shadow-[0_40px_100px_rgba(0,0,0,0.8)] animate-fade-in overflow-y-auto max-h-[90vh]">
                <div className="flex justify-between items-start mb-8">
                  <div>
                    <h2 className="text-2xl font-black text-white uppercase tracking-tighter">Quota & Limits Details</h2>
                    <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mt-1">System Resource Status</p>
                  </div>
                  <button 
                    onClick={() => setShowQuotaDetails(false)}
                    className="p-2 hover:bg-white/5 rounded-xl transition-colors"
                  >
                    <i className="fas fa-times text-slate-400"></i>
                  </button>
                </div>

                <div className="space-y-8">
                  {/* Firestore Section */}
                  <div className={`p-6 rounded-3xl border ${isQuotaExceeded ? 'bg-amber-500/5 border-amber-500/20' : 'bg-white/5 border-white/10'}`}>
                    <div className="flex items-center gap-3 mb-4">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isQuotaExceeded ? 'bg-amber-500/20 text-amber-500' : 'bg-emerald-500/20 text-emerald-500'}`}>
                        <i className="fas fa-database"></i>
                      </div>
                      <div>
                        <h3 className="font-black uppercase tracking-widest text-sm text-white">Firestore Database</h3>
                        <p className={`text-[10px] font-bold uppercase ${isQuotaExceeded ? 'text-amber-500' : 'text-emerald-500'}`}>
                          {isQuotaExceeded ? 'Quota Exceeded' : 'Healthy'}
                        </p>
                      </div>
                    </div>
                    <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
                      <p>Firestore is used for real-time synchronization between the Facilitator and Learner displays, and for cross-session persistence.</p>
                      <div className="bg-black/20 p-4 rounded-2xl space-y-2">
                        <p className="font-bold text-white text-[10px] uppercase tracking-widest">Spark Plan Limits (Daily):</p>
                        <ul className="list-disc ml-4 space-y-1 opacity-80">
                          <li>Reads: 50,000</li>
                          <li>Writes: 20,000</li>
                          <li>Deletes: 20,000</li>
                        </ul>
                      </div>
                      <p className="text-[10px] italic opacity-60">Note: These limits reset daily at midnight US Pacific Time. Real-time features will automatically resume when quota is available.</p>
                    </div>
                  </div>

                  {/* LocalStorage Section */}
                  <div className={`p-6 rounded-3xl border ${isLocalStorageQuotaExceeded ? 'bg-red-500/5 border-red-500/20' : 'bg-white/5 border-white/10'}`}>
                    <div className="flex items-center gap-3 mb-4">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isLocalStorageQuotaExceeded ? 'bg-red-500/20 text-red-500' : 'bg-blue-500/20 text-blue-500'}`}>
                        <i className="fas fa-hard-drive"></i>
                      </div>
                      <div>
                        <h3 className="font-black uppercase tracking-widest text-sm text-white">Browser LocalStorage</h3>
                        <p className={`text-[10px] font-bold uppercase ${isLocalStorageQuotaExceeded ? 'text-red-500' : 'text-blue-500'}`}>
                          {isLocalStorageQuotaExceeded ? 'Quota Exceeded' : 'Healthy'}
                        </p>
                      </div>
                    </div>
                    <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
                      <p>LocalStorage is used for immediate session persistence and offline recovery. It is a browser-enforced limit per website.</p>
                      <div className="bg-black/20 p-4 rounded-2xl space-y-2">
                        <p className="font-bold text-white text-[10px] uppercase tracking-widest">Typical Browser Limits:</p>
                        <ul className="list-disc ml-4 space-y-1 opacity-80">
                          <li>Storage Size: ~5MB to 10MB</li>
                          <li>Scope: Per Origin (this URL)</li>
                        </ul>
                      </div>
                      <p className="text-[10px] italic opacity-60">Tip: If you frequently hit this limit, try clearing old reports from the Outcomes Registry or using the "Clear Local Data" tool above.</p>
                    </div>
                  </div>
                </div>

                <button 
                  onClick={() => setShowQuotaDetails(false)}
                  className="w-full mt-10 py-4 bg-white/5 hover:bg-white/10 text-white rounded-2xl font-black uppercase tracking-[0.2em] text-[10px] transition-all"
                >
                  Close Details
                </button>
              </div>
            </div>
          )}

          {/* Notification Banner */}
          {notification && (
            <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[100] w-full max-w-xl animate-slide-down px-4">
              <div className={`p-4 rounded-2xl shadow-2xl border flex items-center justify-between gap-4 ${
                notification.type === 'error' ? 'bg-red-500/90 border-red-500/20 text-white' : 'bg-emerald-500/90 border-emerald-500/20 text-white'
              } backdrop-blur-xl`}>
                <div className="flex items-center gap-3">
                  <i className={`fas ${notification.type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'}`}></i>
                  <p className="text-sm font-bold">{notification.message}</p>
                </div>
                <button 
                  onClick={() => setNotification(null)}
                  className="p-1 hover:bg-white/20 rounded-lg transition-colors"
                >
                  <i className="fas fa-times"></i>
                </button>
              </div>
            </div>
          )}
      <header id="main-header" className={`bg-slate-900/80 backdrop-blur-md border-b border-white/5 px-8 py-4 flex items-center sticky top-0 z-50 shrink-0 print:hidden ${isLearnerDisplay ? 'justify-between' : ''}`}>
        <div className="flex-1 flex items-center gap-4">
          <div className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white p-3 rounded-2xl shadow-lg shadow-blue-500/20">
            <i className="fas fa-microchip text-xl"></i>
          </div>
          <div className="hidden sm:block">
            <h1 className="text-xl font-black text-white tracking-tight leading-none">SimVeritas 1.52</h1>
            {!isLearnerDisplay && (
              <div className="flex flex-col mt-1.5">
                <p className="text-[10px] text-blue-400 font-black uppercase tracking-[0.2em] opacity-80">Hybrid Neural Clinical Engine</p>
                <p className="text-[9px] font-black text-orange-500 uppercase tracking-widest mt-0.5">By Hemanth Lingadevaru</p>
              </div>
            )}
          </div>
        </div>
        
        {isSimulating && (
          <div className="flex-1 flex justify-center">
            {isLearnerDisplay ? (
              <div className="flex flex-col items-center">
                <h1 className="text-xl font-black text-white tracking-tight leading-none">Clinical Simulation</h1>
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mt-1.5">Live Session</p>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <span className="text-xs font-bold text-white uppercase tracking-tight text-center leading-none">Secured Clinical Simulation Environment</span>
                <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest mt-1.5">Active Encounter</span>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 flex justify-end items-center gap-6">
          {isSimulating && !isLearnerDisplay && (
            <div className="flex items-center gap-2">

              {/* GROUP 1: Session State — Primary action, left-most */}
              <div className="flex items-center">
                {!simStatus.isLive ? (
                  <button
                    ref={initLinkRef}
                    onClick={() => simRoomRef.current?.startLiveSession(true)}
                    disabled={simStatus.isConnecting}
                    className={`
                      px-6 py-3 rounded-xl font-black uppercase tracking-widest 
                      text-[10px] transition-all active:scale-95 disabled:opacity-50 
                      flex items-center gap-2 min-h-[44px] border outline-none
                      focus:ring-4 focus:ring-blue-500/50
                      ${!simStatus.isLive && !simStatus.isConnecting
                        ? 'bg-blue-600 text-white border-blue-400/20 hover:bg-blue-500 shadow-lg shadow-blue-500/20 animate-[pulse-ring_2s_ease-in-out_infinite]'
                        : 'bg-blue-600 text-white border-blue-400/20 hover:bg-blue-500 shadow-lg shadow-blue-500/20'
                      }
                    `}
                  >
                    {simStatus.isConnecting
                      ? <i className="fas fa-spinner animate-spin"></i>
                      : <i className="fas fa-link"></i>
                    }
                    {simStatus.isConnecting
                      ? 'Linking...'
                      : simStatus.hasHistory ? 'Resume Link' : 'Initialize Link'
                    }
                  </button>
                ) : (
                  <button
                    onClick={() => simRoomRef.current?.stopLiveSession()}
                    className="px-6 py-3 bg-red-600 text-white rounded-xl font-black 
                               uppercase tracking-widest text-[10px] shadow-lg 
                               hover:bg-red-500 transition-all active:scale-95 
                               border border-red-400/20 flex items-center gap-2 min-h-[44px]"
                  >
                    <i className="fas fa-link-slash"></i>
                    Disconnect
                  </button>
                )}
              </div>

              {/* Divider */}
              <div className="w-px h-8 bg-white/10 mx-1"></div>

              {/* GROUP 2: Secondary Actions */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const timestamp = Date.now();
                    safeLocalStorageSetItem('simveritas_session', JSON.stringify({
                      isSimulating: true,
                      config,
                      timestamp
                    }));
                    safeLocalStorageSetItem('simveritas_is_simulating', 'true');
                    safeLocalStorageSetItem('simveritas_config', JSON.stringify(config));
                    const url = new URL(window.location.href);
                    url.searchParams.set('learner', 'true');
                    window.open(url.toString(), '_blank');
                  }}
                  className="px-4 py-2.5 bg-white/5 hover:bg-emerald-600/10 
                             border border-white/10 hover:border-emerald-500/30 
                             rounded-xl text-slate-300 hover:text-emerald-400 
                             text-[10px] font-black uppercase tracking-widest 
                             transition-all active:scale-95 flex items-center gap-2 
                             min-h-[44px]"
                  title="Open Learner Display in new tab"
                >
                  <i className="fas fa-display text-xs"></i>
                  <span className="hidden lg:inline">Learner View</span>
                </button>

                <button
                  onClick={() => {
                    console.log('[App] Facilitator: Manual App Sync');
                    syncAppToFirestore(true);
                    if (config) {
                      const ch = new BroadcastChannel('simveritas-app-sync');
                      ch.postMessage({ type: 'SIMULATION_STARTED', config, timestamp: sessionTimestamp });
                      ch.close();
                    }
                    simRoomRef.current?.syncLearner();
                  }}
                  className="px-4 py-2.5 bg-white/5 hover:bg-white/10 
                             border border-white/10 rounded-xl text-slate-400 
                             hover:text-white text-[10px] font-black uppercase 
                             tracking-widest transition-all active:scale-95 
                             flex items-center gap-2 min-h-[44px]"
                  title="Force sync simulation state to learner display"
                >
                  <i className="fas fa-sync-alt text-xs"></i>
                  <span className="hidden lg:inline">Sync</span>
                </button>
              </div>

              {/* Divider */}
              <div className="w-px h-8 bg-white/10 mx-1"></div>

              {/* GROUP 3: Overflow / Destructive */}
              <div className="relative menu-container">
                <button
                  onClick={() => setIsMenuOpen(!isMenuOpen)}
                  className={`p-3 rounded-xl border transition-all active:scale-95 
                              min-h-[44px] min-w-[44px] flex items-center justify-center 
                              ${isMenuOpen
                                ? 'bg-slate-700 text-white border-white/20'
                                : 'bg-slate-800 text-slate-400 border-white/5 hover:text-white hover:bg-slate-700'
                              }`}
                >
                  <i className="fas fa-ellipsis-v px-1 text-sm"></i>
                </button>

                {isMenuOpen && (
                  <div className="absolute right-0 mt-3 w-64 bg-slate-900 border 
                                  border-white/10 rounded-2xl 
                                  shadow-[0_20px_50px_rgba(0,0,0,0.5)] z-[100] 
                                  overflow-hidden animate-fade-in">
                    <div className="p-2 space-y-1">

                      {/* Non-destructive actions */}
                      <button
                        onClick={() => { setIsMenuOpen(false); simRoomRef.current?.finalize(); }}
                        className="w-full px-5 py-4 text-left text-blue-400 
                                   hover:bg-blue-500/10 rounded-xl font-black text-[10px] 
                                   uppercase tracking-widest flex items-center gap-4 
                                   transition-all group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center 
                                        justify-center group-hover:bg-blue-500/20 transition-colors">
                          <i className="fas fa-file-signature"></i>
                        </div>
                        Finalize Encounter
                      </button>

                      <button
                        onClick={() => { setIsMenuOpen(false); simRoomRef.current?.restart(); }}
                        className="w-full px-5 py-4 text-left text-orange-400 
                                   hover:bg-orange-500/10 rounded-xl font-black text-[10px] 
                                   uppercase tracking-widest flex items-center gap-4 
                                   transition-all group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center 
                                        justify-center group-hover:bg-orange-500/20 transition-colors">
                          <i className="fas fa-rotate-right"></i>
                        </div>
                        Restart Simulation
                      </button>

                      {/* Separator before destructive zone */}
                      <div className="h-px bg-white/5 mx-2 my-1" />
                      <p className="px-5 pb-1 text-[8px] font-black text-red-500/50 
                                    uppercase tracking-widest">
                        Danger Zone
                      </p>

                      <button
                        onClick={() => { setIsMenuOpen(false); setShowTerminateConfirm(true); }}
                        className="w-full px-5 py-4 text-left text-red-400 
                                   hover:bg-red-500/10 rounded-xl font-black text-[10px] 
                                   uppercase tracking-widest flex items-center gap-4 
                                   transition-all group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center 
                                        justify-center group-hover:bg-red-500/20 transition-colors">
                          <i className="fas fa-power-off"></i>
                        </div>
                        Terminate Link
                      </button>

                      <div className="h-px bg-white/5 mx-2" />

                      <button
                        onClick={handleSignOut}
                        className="w-full px-5 py-4 text-left text-slate-400 
                                   hover:bg-white/5 rounded-xl font-black text-[10px] 
                                   uppercase tracking-widest flex items-center gap-4 
                                   transition-all group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center 
                                        justify-center group-hover:bg-white/10 transition-colors">
                          <i className="fas fa-right-from-bracket"></i>
                        </div>
                        Sign Out
                      </button>

                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {!isSimulating && !isLearnerDisplay && (
            <div className="flex items-center gap-4">
              {!user && !isAuthLoading && (
                <button
                  onClick={handleSignIn}
                  className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase tracking-[0.2em] rounded-xl transition-all active:scale-95 shadow-lg shadow-blue-900/20 border border-blue-400/20"
                >
                  Sign In
                </button>
              )}
              
              <div className="relative group">
                <button
                  onClick={() => dashboardRef.current?.openArchive()}
                  className="relative w-10 h-10 flex items-center justify-center bg-slate-900/50 hover:bg-blue-500/10 border border-white/5 hover:border-blue-500/30 rounded-xl transition-all active:scale-95 shadow-lg"
                  aria-label="Outcomes Registry"
                >
                  <i className="fas fa-box-archive text-slate-400 group-hover:text-blue-400 transition-colors text-sm"></i>
                  {savedReports.length > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] bg-gradient-to-br from-blue-400 to-blue-600 text-white text-[9px] font-black rounded-full flex items-center justify-center px-1 shadow-lg shadow-blue-500/40 border-2 border-slate-950">
                      {savedReports.length > 99 ? '99+' : savedReports.length}
                    </span>
                  )}
                </button>
                <div className="absolute top-full right-0 mt-2 px-3 py-1.5 bg-slate-800 border border-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-all duration-200 shadow-xl z-[300] translate-y-1 group-hover:translate-y-0">
                  Outcomes Registry
                  <div className="absolute -top-1 right-3 w-2 h-2 bg-slate-800 border-l border-t border-white/10 rotate-45"></div>
                </div>
              </div>
      
          </div>
        )}
      </div>
    </header>

      <main id="main-content" className="flex-1 relative min-h-0 bg-slate-950 print:h-auto print:overflow-visible print:bg-white print:static">
        {isAuthLoading ? (
          <div className="absolute inset-0 bg-slate-950 z-[500] flex flex-col items-center justify-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-slate-400 font-black uppercase tracking-[0.2em] text-[10px]">Authenticating...</p>
          </div>
        ) : false && !user ? (
          <div id="auth-overlay" className="absolute inset-0 bg-slate-950 z-[400] flex flex-col items-center justify-center p-12 text-center">
            <div className="max-w-md space-y-8 animate-fade-in">
              <div className="bg-blue-500/10 p-8 rounded-[2.5rem] border border-blue-500/20 inline-block mb-4 shadow-2xl shadow-blue-500/10">
                <i className="fas fa-shield-halved text-5xl text-blue-400"></i>
              </div>
              <h1 className="text-4xl font-black text-white uppercase tracking-tighter leading-none">SimVeritas <span className="text-blue-500">1.52</span></h1>
              <p className="text-slate-400 text-sm leading-relaxed max-w-xs mx-auto">
                Secure clinical simulation environment. Please sign in with your institutional Google account to access the neural synthesis link.
              </p>
              <button 
                onClick={handleSignIn}
                className="w-full py-5 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-[0.2em] text-xs shadow-2xl shadow-blue-500/30 hover:bg-blue-500 transition-all active:scale-95 flex items-center justify-center gap-4"
              >
                <i className="fab fa-google text-lg"></i>
                Sign In with Google
              </button>
              <p className="text-[10px] text-slate-600 font-black uppercase tracking-widest">
                Protected by SimVeritas Security Protocol
              </p>
            </div>
          </div>
        ) : (
          <>
            {!hasApiKey && !isLearnerDisplay && (
              <div id="api-key-overlay" className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl z-[200] flex flex-col items-center justify-center p-12 text-center">
            <div className="max-w-md space-y-8">
              <div className="bg-blue-500/10 p-6 rounded-3xl border border-blue-500/20 inline-block mb-4">
                <i className="fas fa-key text-4xl text-blue-400"></i>
              </div>
              <h2 className="text-3xl font-black text-white uppercase tracking-tighter">API Authentication Required</h2>
              <p className="text-slate-400 text-sm leading-relaxed">
                SimVeritas 1.52 requires a paid Google Cloud project API key for high-fidelity neural synthesis and real-time clinical audio.
              </p>
              <div className="bg-slate-900 p-4 rounded-2xl border border-white/5 text-left">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mb-2">Instructions</p>
                <ol className="text-[11px] text-slate-300 space-y-2 list-decimal ml-4">
                  <li>Ensure your project has <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="text-blue-400 underline">billing enabled</a>.</li>
                  {isLearnerDisplay ? (
                    <li>Please select an API key in the <strong>Main App window</strong> and then reload this page.</li>
                  ) : (
                    <li>Click the button below to select your API key.</li>
                  )}
                </ol>
              </div>
              {!isLearnerDisplay && (
                <div className="space-y-3">
                  <input
                    type="password"
                    value={manualApiKeyInput}
                    onChange={e => { setManualApiKeyInput(e.target.value); setApiKeyError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleSelectKey()}
                    placeholder="Paste your Gemini API key (AIza...)"
                    className="w-full px-4 py-3 bg-slate-800 border border-white/10 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                  {apiKeyError && <p className="text-red-400 text-xs">{apiKeyError}</p>}
                  <button
                    onClick={handleSelectKey}
                    className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black uppercase tracking-[0.2em] text-xs shadow-2xl shadow-blue-500/20 hover:bg-blue-500 transition-all active:scale-95"
                  >
                    Activate API Key
                  </button>
                  <p className="text-slate-500 text-[10px]">Get your key at <a href="https://aistudio.google.com/apikey" target="_blank" className="text-blue-400 underline">aistudio.google.com/apikey</a></p>
                </div>
              )}
            </div>
          </div>
        )}

        {isGeneratingFeedback && (
          <div id="feedback-generation-overlay" className="absolute inset-0 bg-slate-950/98 backdrop-blur-3xl z-[100] flex flex-col items-center justify-center p-12 text-center">
            {!feedbackError ? (
              <>
                <div className="relative mb-10">
                  <div className="w-24 h-24 border-[4px] border-white/5 border-t-blue-500 rounded-full animate-spin"></div>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <i className="fas fa-dna text-2xl text-blue-400 animate-pulse"></i>
                  </div>
                </div>
                <h2 className="text-2xl font-black text-white uppercase tracking-tighter mb-4">Synthesizing Clinical Outcomes</h2>
                <div className="flex flex-col items-center gap-2">
                  <p className="text-blue-400 font-black text-[10px] uppercase tracking-[0.25em] h-6">
                    {phases[loadingPhase]}
                  </p>
                  <div className="w-48 h-1 bg-white/5 rounded-full mt-6 overflow-hidden">
                    <div 
                      className="h-full bg-blue-500 transition-all duration-1000 ease-out shadow-[0_0_12px_rgba(59,130,246,0.5)]" 
                      style={{ width: `${((loadingPhase + 1) / phases.length) * 100}%` }}
                    ></div>
                  </div>
                </div>
              </>
            ) : (
              <div className="max-w-md animate-fade-in">
                <div className="w-20 h-20 bg-red-500/10 rounded-3xl flex items-center justify-center text-red-500 mb-8 mx-auto border border-red-500/20">
                  <i className="fas fa-triangle-exclamation text-3xl"></i>
                </div>
                <h2 className="text-2xl font-black text-white uppercase tracking-tighter mb-4">Synthesis Failed</h2>
                <p className="text-slate-400 text-sm leading-relaxed mb-10">
                  {feedbackError}
                </p>
                <button 
                  onClick={() => {
                    setIsGeneratingFeedback(false);
                    setFeedbackError(null);
                  }}
                  className="w-full py-4 bg-slate-800 text-white rounded-2xl font-black uppercase tracking-[0.2em] text-[10px] hover:bg-slate-700 transition-all active:scale-95 border border-white/5"
                >
                  Return to Dashboard
                </button>
              </div>
            )}
          </div>
        )}

        {showTerminateConfirm && (
          <div id="terminate-confirmation-overlay" className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl z-[200] flex items-center justify-center p-6">
            <div className="max-w-md w-full bg-slate-900 border border-white/10 rounded-[2.5rem] p-10 shadow-[0_40px_100px_rgba(0,0,0,0.8)] animate-fade-in">
              <div className="w-20 h-20 bg-red-500/10 rounded-3xl flex items-center justify-center text-red-500 mb-8 mx-auto border border-red-500/20">
                <i className="fas fa-triangle-exclamation text-3xl"></i>
              </div>
              <h2 className="text-2xl font-black text-white uppercase tracking-tighter text-center mb-4">Terminate Encounter?</h2>
              <p className="text-slate-400 text-sm text-center leading-relaxed mb-10">
                You are about to terminate this clinical link. All unsaved interaction data will be permanently purged. This action cannot be reversed.
              </p>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => {
                    setShowTerminateConfirm(false);
                    if (simRoomRef.current) {
                      simRoomRef.current.terminate();
                    } else {
                      handleEndSimulation();
                    }
                  }}
                  className="w-full py-4 bg-red-600 text-white rounded-2xl font-black uppercase tracking-[0.2em] text-[10px] shadow-2xl shadow-red-500/20 hover:bg-red-500 transition-all active:scale-95"
                >
                  Confirm Termination
                </button>
                <button 
                  onClick={() => setShowTerminateConfirm(false)}
                  className="w-full py-4 bg-white/5 text-slate-400 rounded-2xl font-black uppercase tracking-[0.2em] text-[10px] hover:bg-white/10 hover:text-white transition-all active:scale-95"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {isSimulating && config ? (
          <div className="h-full print:hidden">
            {!isLoaded ? (
              <div className="flex items-center justify-center h-full bg-slate-950">
                <div className="text-center">
                  <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                  <p className="text-slate-400 font-medium font-mono tracking-wider uppercase text-[10px]">Initializing Clinical AI Link...</p>
                </div>
              </div>
            ) : (
              <SimulationRoom 
                key={`${config.scenario.id}-${sessionTimestamp}`}
                ref={simRoomRef} 
                config={config} 
                onEnd={handleEndSimulation} 
                onStatusChange={setSimStatus}
                isLearnerDisplay={isLearnerDisplay}
                socket={socketRef.current}
              />
            )}
          </div>
        ) : isGeneratingFeedback ? (
          <div className="flex flex-col items-center justify-center h-full bg-slate-950 text-white p-12 text-center">
            <div className="w-20 h-20 bg-emerald-500/10 rounded-3xl flex items-center justify-center text-emerald-400 mb-8 border border-emerald-500/20 animate-spin">
              <i className="fas fa-circle-notch text-3xl"></i>
            </div>
            <h2 className="text-2xl font-black uppercase tracking-tighter mb-4">Synthesizing Feedback</h2>
            <p className="text-slate-400 text-sm max-w-md leading-relaxed">
              Our clinical AI is analyzing the simulation performance and generating a structured debrief. This may take a few moments...
            </p>
          </div>
        ) : isLearnerDisplay ? (
          <div className="flex flex-col items-center justify-center h-full bg-slate-950 text-white p-12 text-center">
            <div className={`w-20 h-20 rounded-3xl flex items-center justify-center mb-8 border transition-all ${isQuotaExceeded ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse'}`}>
              <i className={`fas ${isQuotaExceeded ? 'fa-triangle-exclamation' : 'fa-display'} text-3xl`}></i>
            </div>
            <h2 className="text-2xl font-black uppercase tracking-tighter mb-4">
              {isQuotaExceeded ? 'Connection Limited' : 'Waiting for Simulation'}
            </h2>
            <p className="text-slate-400 text-sm max-w-md leading-relaxed mb-10">
              {isQuotaExceeded 
                ? 'The simulation network is currently at capacity. Real-time updates may be delayed. Please contact your facilitator.' 
                : 'This display is ready to receive a clinical simulation. Please start a simulation from the facilitator dashboard to begin.'}
            </p>
            
            <div className="flex flex-col items-center gap-4 bg-white/5 p-8 rounded-[2.5rem] border border-white/10 max-w-sm w-full backdrop-blur-xl">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isSocketConnected ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]' : 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]'}`}></div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                  {isSocketConnected ? 'Socket Status: Connected' : 'Socket Status: Disconnected'}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isChannelReady ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]'}`}></div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                  {isQuotaExceeded ? 'Link Status: Quota Exceeded' : isChannelReady ? 'Link Status: Active' : 'Link Status: Connecting...'}
                </span>
              </div>
              <button 
                onClick={handleForceSync}
                className="w-full px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-black uppercase tracking-[0.2em] rounded-2xl transition-all border border-emerald-400/20 active:scale-95 shadow-xl shadow-emerald-900/20"
              >
                Force Cloud Sync
              </button>
              <button 
                onClick={() => window.location.reload()}
                className="w-full px-8 py-4 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-black uppercase tracking-[0.2em] rounded-2xl transition-all border border-white/5 active:scale-95 shadow-xl"
              >
                Refresh Page
              </button>
              {isQuotaExceeded && (
                <button 
                  onClick={() => clearFirestoreQuotaExceeded()}
                  className="w-full px-8 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[9px] font-black uppercase tracking-[0.2em] rounded-xl transition-all border border-red-500/20 active:scale-95"
                >
                  Reset Connection
                </button>
              )}
              <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest">
                Click if display does not update automatically
              </p>
            </div>
            
            <SyncMonitor 
              isQuotaExceeded={isQuotaExceeded} 
              user={user} 
              isChannelReady={isChannelReady} 
              lastUpdate={lastAppUpdateRef.current} 
              latency={latency}
            />
          </div>
        ) : feedbackReport ? (
          <div 
            key={archivedReportData ? `archive-${archivedReportData.scenarioTitle}` : 'live-report'}
            className="h-full overflow-y-auto bg-slate-950 custom-scrollbar print:h-auto print:overflow-visible print:bg-white relative z-10"
          >
            <FeedbackView 
              report={feedbackReport} 
              config={config}
              scenarioTitle={archivedReportData?.scenarioTitle}
              patientName={archivedReportData?.patientName}
              onReset={() => {
                setFeedbackReport(null);
                setConfig(null);
                setArchivedReportData(null);
              }} 
              onSave={(report) => handleSaveReport(report)}
            />
          </div>
        ) : (
          <div className="h-full print:hidden">
            <Dashboard 
              ref={dashboardRef}
              onStart={handleStartSimulation} 
              customScenarios={customScenarios} 
              onSaveScenario={handleSaveScenario} 
              onDeleteScenario={handleDeleteScenario}
              bufferScenario={bufferScenario}
              setBufferScenario={setBufferScenario}
              selectedScenarioId={selectedScenarioId}
              setSelectedScenarioId={setSelectedScenarioId}
              savedReports={savedReports}
              analyticsData={analyticsData}
              onDeleteReport={handleDeleteReport}
              onViewReport={(r) => {
                if (!r || !r.report) return;
                setIsGeneratingFeedback(false);
                setIsSimulating(false);
                setConfig(null);
                // Use a functional update to ensure we have the latest state and force a re-render
                setFeedbackReport({ ...r.report });
                setArchivedReportData({ scenarioTitle: r.scenarioTitle, patientName: r.patientName });
                // Ensure we are at the top of the page
                window.scrollTo(0, 0);
              }}
              hasApiKey={hasApiKey}
              onSelectKey={handleSelectKey}
            />
          </div>
        )}
        </>
        )}
      </main>
    </>
  )}
</div>
    </ErrorBoundary>
  );
};

export default App;
