
import React, { useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic } from 'lucide-react';
import { GoogleGenAI, Type, Modality, LiveServerMessage } from '@google/genai';
import { getApiKey } from './apiKey';
import { SimulationConfig, ScenarioPhase, TranscriptionEntry, Emotion, ClinicalAsset, SimulationRoomHandle, CommunicationStyle, SimulationStatus } from './types';
import { EMOTION_PROFILES, EMOTIONS, ACCENTS, COMMUNICATION_STYLES, VOICE_PROFILES, LANGUAGES, COGNITIVE_TRAITS } from './constants';
import { db, auth, isFirestoreQuotaExceeded, setFirestoreQuotaExceeded, clearFirestoreQuotaExceeded, handleFirestoreError, OperationType, useFirestoreQuota, setDoc, updateDoc, onSnapshot, getDoc } from './firebase';
import { doc, DocumentData } from 'firebase/firestore';
import { waitForAuth } from './authUtils';

async function compressImage(base64: string, maxWidth = 800, quality = 0.8, iteration = 0): Promise<string> {
  // Prevent infinite recursion
  if (iteration > 3) return base64;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      // Force resize if larger than maxWidth
      if (width > maxWidth) {
        height = (maxWidth / width) * height;
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64);
        return;
      }
      
      // Fill background with white (for JPEGs with transparency)
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      
      // Use jpeg for better compression
      const compressed = canvas.toDataURL('image/jpeg', quality);
      
      // Firestore limit is 1MB. Base64 is ~1.37x binary size. 
      // 1MB binary is ~1.4M chars. We target < 800K chars to be very safe.
      if (compressed.length > 800000 && iteration < 3) {
        console.log(`[SimulationRoom] Image still too large (${compressed.length}), retrying with lower quality...`);
        resolve(compressImage(compressed, Math.floor(maxWidth * 0.8), quality * 0.7, iteration + 1));
      } else {
        resolve(compressed);
      }
    };
    img.onerror = () => {
      console.error('[SimulationRoom] compressImage: Failed to load image');
      resolve(base64);
    };
    img.src = base64;
  });
}

// Optimized helper functions for base64 encoding/decoding
function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64.replace(/\s/g, ''));
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  try {
    // Ensure we have an even number of bytes for Int16
    const length = Math.floor(data.length / 2);
    // Use the underlying buffer but be careful with alignment and length
    const dataInt16 = new Int16Array(data.buffer, data.byteOffset, length);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
      }
    }
    return buffer;
  } catch (e) {
    console.error('Failed to decode audio data:', e);
    // Return an empty buffer to avoid breaking the playback chain
    return ctx.createBuffer(numChannels, 1, sampleRate);
  }
}

function getNumericAge(age: number | string): number {
  if (typeof age === 'number') return age;
  const parts = age.trim().toLowerCase().split(' ');
  const value = parseFloat(parts[0]);
  if (isNaN(value)) return 0;
  if (parts.includes('day') || parts.includes('days')) return value / 365;
  if (parts.includes('week') || parts.includes('weeks')) return value / 52;
  if (parts.includes('month') || parts.includes('months')) return value / 12;
  return value; // Assume years if no unit or 'year'
}

function mergeClinicalAssets(incoming: ClinicalAsset[] = [], current: ClinicalAsset[] = [], cache: Record<string, string> = {}): ClinicalAsset[] {
  const map = new Map<string, ClinicalAsset>();
  
  const getPriority = (a: ClinicalAsset) => {
    const statusPriority = { 'released': 4, 'rejected': 3, 'pending_review': 2, 'ordered': 1 };
    return statusPriority[a.status] || 0;
  };

  // 1. Add all incoming (canonical from facilitator)
  incoming.forEach(a => {
    // If it's stripped but we have it in cache, restore it
    if (!a.imageUrl && a._hasLargeUrl && cache[a.id]) {
      map.set(a.id, { ...a, imageUrl: cache[a.id], _hasLargeUrl: false });
    } else {
      map.set(a.id, a);
    }
  });
  
  // 2. Add local assets to ensure they don't disappear during sync lag
  current.forEach(a => {
    const existing = map.get(a.id);
    if (!existing) {
      // Keep local assets that haven't reached the server yet
      // This includes both learner orders and facilitator manual releases
      map.set(a.id, a);
    } else {
      // If it IS in the map, the version with higher status wins, or if status is same, incoming wins (canonical)
      if (getPriority(a) > getPriority(existing)) {
        map.set(a.id, a);
      } else {
        // Incoming (existing) is canonical, but if it's stripped and we have it locally, preserve it
        if (!existing.imageUrl && a.imageUrl && existing._hasLargeUrl) {
          map.set(a.id, { ...existing, imageUrl: a.imageUrl, _hasLargeUrl: false });
        }
      }
    }
  });
  
  return Array.from(map.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

interface SimulationRoomProps {
  config: SimulationConfig;
  onEnd: (history: TranscriptionEntry[], finalConfig: SimulationConfig) => void;
  onStatusChange?: (status: SimulationStatus) => void;
  isLearnerDisplay?: boolean;
  socket?: any; // Socket.io client instance
}

  const VoiceVisualizer = ({ 
    activeUserTranscript, 
    activeModelTranscript, 
    micActivity,
    speakerRole,
    patientName,
    isFacilitatorOverlay = false
  }: { 
    activeUserTranscript: string; 
    activeModelTranscript: string; 
    micActivity: number;
    speakerRole: 'user' | 'model' | 'none';
    patientName?: string;
    isFacilitatorOverlay?: boolean;
  }) => {
    const [displayTranscript, setDisplayTranscript] = useState('');
    const [isSpeaking, setIsSpeaking] = useState(false);
    const transcriptTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll transcript to bottom
    useEffect(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, [displayTranscript]);

    // Update display transcript based on who is speaking
    useEffect(() => {
      if (speakerRole === 'user') {
        // User transcript is displayed immediately as it arrives in chunks
        setDisplayTranscript(activeUserTranscript);
        setIsSpeaking(true);
        if (transcriptTimeoutRef.current) clearTimeout(transcriptTimeoutRef.current);
      } else if (speakerRole === 'model') {
        setIsSpeaking(true);
        if (transcriptTimeoutRef.current) clearTimeout(transcriptTimeoutRef.current);
        
        // Typewriter effect for model to match speech speed (~20 chars/sec)
        const targetText = activeModelTranscript;
        if (targetText.length > displayTranscript.length) {
          const timer = setTimeout(() => {
            setDisplayTranscript(targetText.slice(0, displayTranscript.length + 1));
          }, 50); // 50ms per character = 20 chars/sec
          return () => clearTimeout(timer);
        } else if (targetText.length < displayTranscript.length) {
          // If the target text is shorter (e.g. reset or new turn), update immediately
          setDisplayTranscript(targetText);
        }
      } else {
        // Fallback or hold logic when no one is actively speaking
        const text = activeModelTranscript || activeUserTranscript;
        if (text) {
          setDisplayTranscript(text);
          setIsSpeaking(true);
          if (transcriptTimeoutRef.current) clearTimeout(transcriptTimeoutRef.current);
        } else {
          // Hold the last transcript for 5 seconds before clearing
          if (transcriptTimeoutRef.current) clearTimeout(transcriptTimeoutRef.current);
          transcriptTimeoutRef.current = setTimeout(() => {
            setDisplayTranscript('');
            setIsSpeaking(false);
          }, 5000);
        }
      }
    }, [activeUserTranscript, activeModelTranscript, speakerRole, displayTranscript.length]);

    // Also consider it "speaking" if there's significant mic activity
    const hasActivity = isSpeaking || micActivity > 0.05;

    return (
      <div className={`${isFacilitatorOverlay ? 'relative w-full' : 'fixed bottom-20 left-1/2 -translate-x-1/2 w-full max-w-xl px-4'} z-50 pointer-events-none`}>
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-slate-950/90 backdrop-blur-xl border border-white/10 rounded-2xl p-3 shadow-[0_10px_40px_rgba(0,0,0,0.5)] overflow-hidden relative"
        >
          {/* Informatics Grid Background */}
          <div className="absolute inset-0 opacity-5 pointer-events-none" 
               style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '15px 15px' }}></div>
          
          <div className="flex items-start gap-4 relative z-10">
            {/* Status Indicator Panel */}
            <div className="flex flex-col items-center gap-2 shrink-0">
              <div className="relative flex items-center justify-center w-10 h-10">
                <motion.div
                  animate={{
                    scale: hasActivity ? [1, 1.2, 1] : 1,
                    opacity: hasActivity ? [0.2, 0.4, 0.2] : 0.1,
                  }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className={`absolute inset-0 rounded-full ${speakerRole === 'model' ? 'bg-blue-500' : 'bg-emerald-500'}`}
                />
                <div className={`relative z-10 w-7 h-7 rounded-lg flex items-center justify-center transform rotate-12 ${speakerRole === 'model' ? 'bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.4)]' : 'bg-emerald-600 shadow-[0_0_15px_rgba(5,150,105,0.4)]'}`}>
                  {speakerRole === 'model' ? (
                    <div className="flex gap-0.5 -rotate-12">
                      {[1, 2, 3].map((i) => (
                        <motion.div
                          key={i}
                          animate={{ height: hasActivity ? [4, 12, 4] : 4 }}
                          transition={{ duration: 0.4, repeat: Infinity, delay: i * 0.1 }}
                          className="w-1 bg-white rounded-full"
                        />
                      ))}
                    </div>
                  ) : (
                    <Mic className="w-3.5 h-3.5 text-white -rotate-12" />
                  )}
                </div>
              </div>
            </div>

            {/* Transcript Content Area */}
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest ${
                    speakerRole === 'model' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 
                    speakerRole === 'user' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 
                    'bg-slate-800 text-slate-500'
                  }`}>
                    {speakerRole === 'model' ? (patientName || 'Patient') : speakerRole === 'user' ? 'Provider' : 'System'}
                  </div>
                </div>
                
                {hasActivity && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[7px] font-mono text-red-500 animate-pulse font-bold uppercase tracking-widest">Live</span>
                    <div className="w-1 h-1 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
                  </div>
                )}
              </div>

              <div 
                ref={scrollRef}
                className="max-h-16 overflow-y-auto pr-2 custom-scrollbar pointer-events-auto"
              >
                <p className={`text-white text-sm font-medium leading-relaxed tracking-tight ${speakerRole === 'model' ? 'font-serif italic' : 'font-sans'}`}>
                  {displayTranscript || (hasActivity ? 'Processing stream...' : 'Awaiting input...')}
                </p>
              </div>
            </div>

            {/* Waveform Informatics */}
            <div className="flex items-center gap-1 h-8 self-center px-3 border-l border-white/5">
              {[...Array(8)].map((_, i) => (
                <motion.div
                  key={i}
                  animate={{ 
                    height: hasActivity ? [3, (micActivity * 40 * (0.3 + Math.random() * 0.7)) + 3, 3] : 3,
                    opacity: hasActivity ? [0.4, 1, 0.4] : 0.2
                  }}
                  transition={{ 
                    duration: 0.15, 
                    repeat: Infinity, 
                    delay: i * 0.02 
                  }}
                  className={`w-0.5 rounded-full ${speakerRole === 'model' ? 'bg-blue-400' : 'bg-emerald-400'}`}
                />
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    );
  };

const SimulationRoom = forwardRef<SimulationRoomHandle, SimulationRoomProps>(({ config, onEnd, onStatusChange, isLearnerDisplay = false, socket }, ref) => {
  const [isMuted, setIsMuted] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [activeDrawer, setActiveDrawer] = useState<'chart' | 'facilitator' | null>(null);
  const [history, setHistory] = useState<TranscriptionEntry[]>(() => {
    try {
      const saved = localStorage.getItem(`sim_history_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  const [activeUserTranscript, setActiveUserTranscript] = useState(() => {
    if (!isLearnerDisplay) return '';
    try {
      const saved = localStorage.getItem(`sim_transcripts_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved).user : '';
    } catch (e) {
      return '';
    }
  });
  const [activeModelTranscript, setActiveModelTranscript] = useState(() => {
    if (!isLearnerDisplay) return '';
    try {
      const saved = localStorage.getItem(`sim_transcripts_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved).model : '';
    } catch (e) {
      return '';
    }
  });
  const [speakerRole, setSpeakerRole] = useState<'user' | 'model' | 'none'>('none');
  const speakerRoleRef = useRef<'user' | 'model' | 'none'>('none');
  useEffect(() => { speakerRoleRef.current = speakerRole; }, [speakerRole]);
  
  const [isLive, setIsLive] = useState(() => {
    try {
      const saved = localStorage.getItem(`sim_state_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved).isLive : false;
    } catch (e) {
      return false;
    }
  });
  const [isConnecting, setIsConnecting] = useState(() => {
    try {
      const saved = localStorage.getItem(`sim_state_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved).isConnecting : false;
    } catch (e) {
      return false;
    }
  });
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [hasReceivedData, setHasReceivedData] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string>(() => {
    if (isLearnerDisplay) return ''; // Learner ALWAYS waits for facilitator
    try {
      // Use session-specific key to avoid collisions between different simulation runs
      const sessionKey = `sim_avatar_${config.scenario.id}_${config.sessionTimestamp}`;
      const saved = localStorage.getItem(sessionKey);
      return saved || '';
    } catch (e) {
      return '';
    }
  });
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const videoUriRef = useRef<string | null>(null);
  useEffect(() => { videoUriRef.current = videoUri; }, [videoUri]);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isProcessingVisuals, setIsProcessingVisuals] = useState(false);
  const [statusMsg, setStatusMsg] = useState(() => {
    try {
      const saved = localStorage.getItem(`sim_state_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved).statusMsg : 'Standby';
    } catch (e) {
      return 'Standby';
    }
  });
  const [videoProgressMsg, setVideoProgressMsg] = useState('');
  const [micActivity, setMicActivity] = useState(() => {
    try {
      const saved = localStorage.getItem(`sim_state_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved).micActivity : 0;
    } catch (e) {
      return 0;
    }
  });

  const [liveHistory, setLiveHistory] = useState(config.scenario.patientProfile.medicalHistory);
  const [liveSymptoms, setLiveSymptoms] = useState(config.scenario.patientProfile.currentSymptoms);
  const [liveEmotion, setLiveEmotion] = useState<Emotion>(() => {
    try {
      const saved = localStorage.getItem(`sim_state_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved).emotion : config.emotion;
    } catch (e) {
      return config.emotion;
    }
  });
  const [liveCommStyle, setLiveCommStyle] = useState<CommunicationStyle>(config.communicationStyle);
  const [liveDirectives, setLiveDirectives] = useState(config.facilitatorInstructions || '');

  const [activePhaseIndex, setActivePhaseIndex] = useState(() => {
    try {
      const saved = localStorage.getItem(`sim_state_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved).phaseIndex : 0;
    } catch (e) {
      return 0;
    }
  });

  const activePhase: ScenarioPhase | null =
    config.scenario.phases && config.scenario.phases.length > 0
      ? config.scenario.phases[activePhaseIndex] ?? null
      : null;

  const isLiveRef = useRef(false);
  const isConnectingRef = useRef(false);
  const reconnectCountRef = useRef(0);

  const [clinicalAssets, setClinicalAssets] = useState<ClinicalAsset[]>(() => {
    try {
      const saved = localStorage.getItem(`sim_assets_${config.scenario.id}_${config.sessionTimestamp}`);
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [processingAssetIds, setProcessingAssetIds] = useState<Set<string>>(new Set());
  const [regenerationPrompts, setRegenerationPrompts] = useState<Record<string, string>>({});

  const regenerateImage = async (asset: ClinicalAsset, customPrompt?: string) => {
    if (processingAssetIds.has(asset.id)) return;
    setProcessingAssetIds(prev => new Set(prev).add(asset.id));
    try {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error("API Key not found");
      const ai = new GoogleGenAI({ apiKey });
      
      const promptToUse = customPrompt || asset.visualPrompt || `Medical ${asset.type} showing ${asset.title}`;
      
      const imgRes = await ai.models.generateContent({ 
        model: 'gemini-2.5-flash-image', 
        contents: [{ parts: [{ text: promptToUse }] }]
      });
      
      let newImageUrl = undefined;
      for (const p of imgRes.candidates?.[0]?.content?.parts || []) {
        if (p.inlineData) {
          newImageUrl = `data:image/png;base64,${p.inlineData.data}`;
          break;
        }
      }

      if (newImageUrl) {
        const compressedUrl = await compressImage(newImageUrl, 800, 0.8);
        setClinicalAssets(prev => {
          const newState = prev.map(a => 
            a.id === asset.id ? { ...a, imageUrl: compressedUrl, visualPrompt: promptToUse } : a
          );
          clinicalAssetsRef.current = newState;
          return newState;
        });
        broadcastCurrentState(true);
      }
    } catch (e) {
      console.error('Regeneration failed:', e);
    } finally {
      setProcessingAssetIds(prev => {
        const next = new Set(prev);
        next.delete(asset.id);
        return next;
      });
      setRegenerationPrompts(prev => {
        const next = { ...prev };
        delete next[asset.id];
        return next;
      });
    }
  };
  const releaseAssetRef = useRef<((asset: ClinicalAsset) => Promise<void>) | null>(null);

  const [isNeuralOverridesOpen, setIsNeuralOverridesOpen] = useState(false);

  const [lastViewedReleasedCount, setLastViewedReleasedCount] = useState(0);
  const [lastViewedPendingCount, setLastViewedPendingCount] = useState(0);

  const releasedAssets = useMemo(() => clinicalAssets.filter(a => a.status === 'released'), [clinicalAssets]);
  const pendingFulfillment = useMemo(() => clinicalAssets.filter(a => a.status === 'ordered' && a.source === 'learner' && a.status !== 'rejected'), [clinicalAssets]);
  const reviewQueue = useMemo(() => clinicalAssets.filter(a => a.status === 'pending_review' && a.status !== 'rejected'), [clinicalAssets]);
  const totalPendingWork = useMemo(() => clinicalAssets.filter(a => (a.status === 'ordered' || a.status === 'pending_review') && a.status !== 'rejected'), [clinicalAssets]);

  const hasNewReleased = useMemo(() => releasedAssets.length > lastViewedReleasedCount, [releasedAssets.length, lastViewedReleasedCount]);
  const hasNewPending = useMemo(() => totalPendingWork.length > lastViewedPendingCount, [totalPendingWork.length, lastViewedPendingCount]);

  useEffect(() => {
    if (activeDrawer === 'chart') {
      setLastViewedReleasedCount(releasedAssets.length);
    } else if (releasedAssets.length === 0) {
      setLastViewedReleasedCount(0);
    }
    
    if (activeDrawer === 'facilitator') {
      setLastViewedPendingCount(totalPendingWork.length);
    } else if (totalPendingWork.length === 0) {
      setLastViewedPendingCount(0);
    }
  }, [activeDrawer, releasedAssets.length, totalPendingWork.length]);

  // --- LOCAL STORAGE HELPERS ---
  const safeLocalStorageSetItem = useCallback((key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (e: any) {
      if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        console.warn(`[SimulationRoom] LocalStorage quota exceeded for key: ${key}. Attempting cleanup...`);
        
        // Signal to App.tsx to show the UI banner
        const ch = new BroadcastChannel('simveritas-app-sync');
        ch.postMessage({ type: 'LOCAL_STORAGE_QUOTA_EXCEEDED' });
        ch.close();

        // Cleanup strategy: Remove all keys starting with 'sim_' that are NOT for the current session
        const currentSessionPrefix = `_${config.sessionTimestamp}`;
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
        } catch (retryErr) {
          console.error(`[SimulationRoom] LocalStorage quota still exceeded after cleanup for key: ${key}`, retryErr);
        }
      } else {
        console.error(`[SimulationRoom] LocalStorage error for key: ${key}`, e);
      }
    }
  }, [config.sessionTimestamp]);

  // 0. Persistence Logic (Facilitator & Learner)
  useEffect(() => {
    const scenarioId = config.scenario.id;
    const state = {
      isLive,
      isConnecting,
      statusMsg,
      micActivity,
      emotion: liveEmotion,
      phaseIndex: activePhaseIndex,
      lastUpdate: Date.now()
    };
    safeLocalStorageSetItem(`sim_state_${scenarioId}_${config.sessionTimestamp}`, JSON.stringify(state));
  }, [isLive, isConnecting, statusMsg, micActivity, liveEmotion, activePhaseIndex, config.scenario.id, config.sessionTimestamp, safeLocalStorageSetItem]);

  useEffect(() => {
    const scenarioId = config.scenario.id;
    safeLocalStorageSetItem(`sim_assets_${scenarioId}_${config.sessionTimestamp}`, JSON.stringify(clinicalAssets));
  }, [clinicalAssets, config.scenario.id, config.sessionTimestamp, safeLocalStorageSetItem]);

  useEffect(() => {
    const scenarioId = config.scenario.id;
    safeLocalStorageSetItem(`sim_history_${scenarioId}_${config.sessionTimestamp}`, JSON.stringify(history));
  }, [history, config.scenario.id, config.sessionTimestamp, safeLocalStorageSetItem]);

  useEffect(() => {
    const scenarioId = config.scenario.id;
    safeLocalStorageSetItem(`sim_transcripts_${scenarioId}_${config.sessionTimestamp}`, JSON.stringify({
      user: activeUserTranscript,
      model: activeModelTranscript
    }));
  }, [activeUserTranscript, activeModelTranscript, config.scenario.id, config.sessionTimestamp, safeLocalStorageSetItem]);

  const historyRef = useRef<TranscriptionEntry[]>(history);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const learnerHistoryScrollRef = useRef<HTMLDivElement>(null);
  const clinicalAssetsRef = useRef<ClinicalAsset[]>(clinicalAssets);
  const activePhaseIndexRef = useRef<number>(activePhaseIndex);
  const liveEmotionRef = useRef<Emotion>(liveEmotion);
  const statusMsgRef = useRef<string>(statusMsg);
  const micActivityRef = useRef<number>(micActivity);
  const avatarUrlRef = useRef<string>(avatarUrl);
  const liveHistoryRef = useRef<string>(config.scenario.patientProfile.medicalHistory);
  const liveSymptomsRef = useRef<string>(config.scenario.patientProfile.currentSymptoms);
  const liveDirectivesRef = useRef<string>(config.facilitatorInstructions || '');
  useEffect(() => { avatarUrlRef.current = avatarUrl; }, [avatarUrl]);
  useEffect(() => { liveHistoryRef.current = liveHistory; }, [liveHistory]);
  useEffect(() => { liveSymptomsRef.current = liveSymptoms; }, [liveSymptoms]);
  useEffect(() => { liveDirectivesRef.current = liveDirectives; }, [liveDirectives]);
  const videoUrlRef = useRef<string | null>(videoUrl);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);

  // Auto-reconnect effect
  useEffect(() => {
    if (!isLearnerDisplay && isLive && !sessionRef.current && !isConnectingRef.current) {
      console.log('[SimulationRoom] Auto-reconnecting session...');
      startLiveSession(true);
    }
  }, [isLive, isLearnerDisplay]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const abortVideoRef = useRef(false);
  const connectionIdRef = useRef(0);

  const currentEmotionRef = useRef<string>(config.emotion); // Track current emotion across reconnections
  const lastMessageTimestampRef = useRef<number>(Date.now()); // Track last message for silence reinforcement
  const lastSyncedEmotionRef = useRef<Emotion | null>(null);

  const activeUserTranscriptRef = useRef('');
  const activeModelTranscriptRef = useRef('');
  const baseIdentityImageRef = useRef<string | null>(
    typeof window !== 'undefined' ? localStorage.getItem(`sim_base_identity_${config.scenario.id}_${config.sessionTimestamp}`) : null
  );
  const canonicalAvatarRef = useRef<string | null>(null);
  const lastReceivedAvatarRef = useRef<string>('');
  
  const handleStateUpdateRef = useRef<((d: DocumentData) => void) | null>(null);
  const broadcastCurrentStateRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
  
  // Initialize baseIdentityImageRef from localStorage if available
  useEffect(() => {
    if (!isLearnerDisplay) {
      const saved = localStorage.getItem(`sim_base_identity_${config.scenario.id}_${config.sessionTimestamp}`);
      if (saved) baseIdentityImageRef.current = saved;
    }
  }, [isLearnerDisplay, config.scenario.id, config.sessionTimestamp]);
  const lastRequestTimestampRef = useRef<number>(config.sessionTimestamp || (Date.now() - 5000)); // Initialize slightly in past to catch immediate events
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  const [isChannelReady, setIsChannelReady] = useState(false);
  const isQuotaExceeded = useFirestoreQuota();

  useEffect(() => {
    if (historyScrollRef.current) {
      historyScrollRef.current.scrollTop = historyScrollRef.current.scrollHeight;
    }
    if (learnerHistoryScrollRef.current) {
      learnerHistoryScrollRef.current.scrollTop = learnerHistoryScrollRef.current.scrollHeight;
    }
  }, [history]);

  const lastFirestoreSyncRef = useRef<number>(0);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const largeAssetsCacheRef = useRef<Record<string, string>>({});

  const lastAvatarBroadcastRef = useRef<string>('');
  const lastAvatarFirestoreRef = useRef<string>('');
  const lastMicBroadcastRef = useRef<number>(0);

  const broadcastCurrentState = useCallback(async (forceFirestore = false, overrideState?: any) => {
    if (isLearnerDisplay) return;
    
    const timestamp = Date.now();
    const state = overrideState || {
      type: 'STATE_UPDATE',
      history: historyRef.current,
      activeUserTranscript: activeUserTranscriptRef.current,
      activeModelTranscript: activeModelTranscriptRef.current,
      speakerRole: speakerRoleRef.current,
      clinicalAssets: clinicalAssetsRef.current,
      phaseIndex: activePhaseIndexRef.current,
      emotion: liveEmotionRef.current,
      isLive: isLiveRef.current,
      isConnecting: isConnectingRef.current,
      statusMsg: statusMsgRef.current,
      micActivity: micActivityRef.current,
      avatarUrl: avatarUrlRef.current,
      videoUrl: videoUrlRef.current,
      videoUri: videoUriRef.current,
      scenarioTitle: config.scenario.title,
      patientName: config.scenario.patientProfile.name,
      isSimulating: true,
      lastUpdate: timestamp
    };

    // Sync state via BroadcastChannel (fast, same-browser)
    if (broadcastChannelRef.current) {
      try {
        // Post main state WITHOUT avatarUrl to keep message small and fast
        const { avatarUrl: _avUrl, ...stateWithoutAvatar } = state;
        broadcastChannelRef.current.postMessage(stateWithoutAvatar);

        // Post avatarUrl separately ONLY when it has changed
        // This avoids serializing a 300KB string on every high-frequency update (like transcripts)
        if (avatarUrlRef.current && avatarUrlRef.current !== lastAvatarBroadcastRef.current) {
          broadcastChannelRef.current.postMessage({
            type: 'AVATAR_UPDATE',
            avatarUrl: avatarUrlRef.current,
            lastUpdate: timestamp + 2  // distinct timestamp to bypass lastUpdate guard
          });
          // Update the ref so we don't send it again until it changes
          lastAvatarBroadcastRef.current = avatarUrlRef.current;
        }
      } catch (e) {
        console.warn('[SimulationRoom] BroadcastChannel postMessage failed:', e);
      }
    }

    // Sync via Socket.io (Reliable, high-frequency, cross-browser, no size limit)
    if (socket) {
      socket.emit('sync-room-state', {
        roomId: `sim-${config.sessionTimestamp}`,
        state: state
      });
    }
    try {
      safeLocalStorageSetItem(`simveritas_room_state_${config.sessionTimestamp}`, JSON.stringify(state));
    } catch (e) {
      console.warn('[SimulationRoom] LocalStorage sync failed (likely quota exceeded), stripping large fields');
      const { avatarUrl: _au, clinicalAssets, history, ...strippedState } = state;
      const minimalAssets = clinicalAssets.map(a => (a.imageUrl && a.imageUrl.length > 10000) ? { ...a, imageUrl: undefined } : a);
      const minimalHistory = history.length > 10 ? history.slice(-10) : history;
      try {
        safeLocalStorageSetItem(`simveritas_room_state_${config.sessionTimestamp}`, JSON.stringify({ 
          ...strippedState, 
          clinicalAssets: minimalAssets,
          history: minimalHistory
        }));
      } catch (e2) {}
    }

    // Throttled Firestore sync (slow, cross-device)
    const now = Date.now();
    // Reduce throttle to 1s for transcripts to improve cross-device real-time feel
    const isTranscribing = !!(activeUserTranscriptRef.current || activeModelTranscriptRef.current);
    const throttleMs = isTranscribing ? 1000 : 2000;
    const shouldSyncFirestore = forceFirestore || (now - lastFirestoreSyncRef.current > throttleMs);

    if (shouldSyncFirestore && !isQuotaExceeded) {
      lastFirestoreSyncRef.current = now;
      try {
        // Strip videoUrl (blob URL) AND avatarUrl (large base64) AND large clinicalAsset URLs
        const { videoUrl: _vu, avatarUrl: _au, clinicalAssets, history, ...firestoreState } = state;
        
        // Limit history to last 20 entries to save space
        const limitedHistory = history.length > 20 ? history.slice(-20) : history;
        
        // Strip large asset URLs (>10KB) from main state doc
        const strippedAssets = clinicalAssets.map(a => {
          if (a.imageUrl && a.imageUrl.startsWith('data:') && a.imageUrl.length > 10000) {
            return { ...a, imageUrl: undefined, _hasLargeUrl: true };
          }
          return a;
        });

        const syncDoc = doc(db, 'sync', 'room_state');
        await setDoc(syncDoc, { 
          ...firestoreState, 
          history: history.length > 15 ? history.slice(-15) : history,
          clinicalAssets: strippedAssets.length > 10 ? strippedAssets.slice(-10) : strippedAssets,
          lastUpdate: timestamp 
        }, { merge: true }, true).catch(err => handleFirestoreError(err, OperationType.WRITE, 'sync/room_state'));

        // Write large asset URLs to a separate document if needed
        // Limit to last 5 large assets to stay under 1MB
        const largeAssets = clinicalAssets
          .filter(a => a.imageUrl && a.imageUrl.startsWith('data:') && a.imageUrl.length > 10000)
          .slice(-5);
        
        if (largeAssets.length > 0) {
          try {
            const assetsDoc = doc(db, 'sync', 'room_assets');
            await setDoc(assetsDoc, {
              assets: largeAssets.map(a => ({ id: a.id, imageUrl: a.imageUrl })),
              lastUpdate: timestamp + 3
            }, { merge: true }, true).catch(err => handleFirestoreError(err, OperationType.WRITE, 'sync/room_assets'));
          } catch (assetErr) {
            console.error('[SimulationRoom] Large assets Firestore write failed:', String(assetErr));
          }
        }

        // Write avatarUrl to a separate small document whenever it's present and forceFirestore is true
        if (avatarUrlRef.current && avatarUrlRef.current.length > 100) {
          // Only write if we have a real image (data URLs are always >100 chars)
          if (avatarUrlRef.current !== lastAvatarFirestoreRef.current) {
            // FINAL GUARD: Firestore limit is 1,048,576 bytes.
            // A string of 1M chars is roughly 1MB. 
            // If it's still too large after compression, we skip Firestore write to avoid crash.
            if (avatarUrlRef.current.length > 1000000) {
              console.warn('[SimulationRoom] Avatar still too large for Firestore even after compression, skipping sync:', avatarUrlRef.current.length);
            } else {
              try {
                const avatarDoc = doc(db, 'sync', 'room_avatar');
                await setDoc(avatarDoc, {
                  avatarUrl: avatarUrlRef.current,
                  lastUpdate: timestamp + 1 // +1 ensures it never equals room_state timestamp
                }, { merge: false }, true).catch(err => handleFirestoreError(err, OperationType.WRITE, 'sync/room_avatar'));
                // Update AFTER successful write, not before
                lastAvatarFirestoreRef.current = avatarUrlRef.current;
                console.log('[SimulationRoom] Facilitator: Synced NEW avatar to Firestore, length:', avatarUrlRef.current.length);
              } catch (avatarErr) {
                console.error('[SimulationRoom] Avatar Firestore write failed:', String(avatarErr));
                // Do NOT update lastAvatarFirestoreRef on failure, so it retries next time
              }
            }
          }
        }
        console.log('[SimulationRoom] Facilitator: Synced room state to Firestore', { forceFirestore, timestamp });
      } catch (err: any) {
        console.error('[SimulationRoom] Firestore sync error (non-critical):', String(err));
      }
    } else if (!shouldSyncFirestore && !syncTimeoutRef.current) {
      syncTimeoutRef.current = setTimeout(() => {
        syncTimeoutRef.current = null;
        broadcastCurrentState(true);
      }, 2000);
    }
  }, [isLearnerDisplay, config.scenario.id, config.scenario.title, config.scenario.patientProfile.name, isQuotaExceeded]);

  // Facilitator: Initial broadcast on mount to ensure learners get state immediately
  useEffect(() => {
    if (!isLearnerDisplay) {
      console.log('[SimulationRoom] Facilitator: Performing initial mount broadcast');
      // Force Firestore sync on mount to ensure the sync document exists for learners
      // ONLY if we have an actual avatar to share
      if (avatarUrlRef.current && avatarUrlRef.current.length > 100) {
        broadcastCurrentStateRef.current?.(true);
      } else {
        broadcastCurrentStateRef.current?.(false);
      }
    }
  }, [isLearnerDisplay]);

  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { activeUserTranscriptRef.current = activeUserTranscript; }, [activeUserTranscript]);
  useEffect(() => { activeModelTranscriptRef.current = activeModelTranscript; }, [activeModelTranscript]);
  useEffect(() => { clinicalAssetsRef.current = clinicalAssets; }, [clinicalAssets]);
  useEffect(() => { activePhaseIndexRef.current = activePhaseIndex; }, [activePhaseIndex]);
  useEffect(() => { liveEmotionRef.current = liveEmotion; }, [liveEmotion]);
  useEffect(() => { isLiveRef.current = isLive; }, [isLive]);
  useEffect(() => { isConnectingRef.current = isConnecting; }, [isConnecting]);
  useEffect(() => { statusMsgRef.current = statusMsg; }, [statusMsg]);
  useEffect(() => { micActivityRef.current = micActivity; }, [micActivity]);
  useEffect(() => { videoUrlRef.current = videoUrl; }, [videoUrl]);
  useEffect(() => { videoUriRef.current = videoUri; }, [videoUri]);
  useEffect(() => { avatarUrlRef.current = avatarUrl; }, [avatarUrl]);

  const fetchVideoFromUri = useCallback(async (uri: string) => {
    if (!uri) return;
    try {
      console.log('[SimulationRoom] Learner: Fetching video from URI:', uri);
      const apiKey = await getApiKey();
      if (!apiKey) return;

      const response = await fetch(uri, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
        },
      });
      if (!response.ok) throw new Error('Failed to fetch video');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setVideoUrl(url);
    } catch (err) {
      console.error('[SimulationRoom] Error fetching video from URI:', err);
    }
  }, []);

  const lastAvatarUrlRef = useRef<string>('');
  const lastMicUpdateRef = useRef<number>(0);
  const lastMicValueRef = useRef<number>(0);
  
  const throttleSetMicActivity = useCallback((val: number) => {
    const now = Date.now();
    // Only update if it's a significant change (> 0.05) OR if 100ms have passed
    if (Math.abs(val - lastMicValueRef.current) > 0.05 || (now - lastMicUpdateRef.current > 100)) {
      setMicActivity(val);
      lastMicValueRef.current = val;
      lastMicUpdateRef.current = now;
    }
  }, []);

  const handleStateUpdate = useCallback((d: DocumentData) => {
    try {
      if (!d) return;
      setHasReceivedData(true);

      const isAvatarOnlyUpdate = d.avatarUrl && Object.keys(d).filter(
        k => k !== 'avatarUrl' && k !== 'lastUpdate' && k !== 'type'
      ).length === 0;

      if (!isAvatarOnlyUpdate) {
        // More lenient update check for transcripts to prevent them from being discarded due to sync lag
        if (d.lastUpdate && lastUpdateRef.current && d.lastUpdate < lastUpdateRef.current) {
          // Only drop if it's strictly older than what we have
          // This allows same-timestamp updates (like separate avatar/state messages)
          console.log('[SimulationRoom] Sync: Discarding stale update', { received: d.lastUpdate, current: lastUpdateRef.current });
          return;
        }
        if (d.lastUpdate) lastUpdateRef.current = d.lastUpdate;
      }

      if (d.history !== undefined) {
        // Only update history if it's actually different (length check is a good first pass)
        if (d.history.length !== historyRef.current.length || JSON.stringify(d.history) !== JSON.stringify(historyRef.current)) {
          setHistory(d.history);
          historyRef.current = d.history;
        }
      }
      
      if (d.activeUserTranscript !== undefined) {
        if (d.activeUserTranscript !== activeUserTranscriptRef.current) {
          setActiveUserTranscript(d.activeUserTranscript);
          activeUserTranscriptRef.current = d.activeUserTranscript;
        }
      }
      if (d.activeModelTranscript !== undefined) {
        if (d.activeModelTranscript !== activeModelTranscriptRef.current) {
          setActiveModelTranscript(d.activeModelTranscript);
          activeModelTranscriptRef.current = d.activeModelTranscript;
        }
      }
      if (d.speakerRole !== undefined) {
        if (d.speakerRole !== speakerRoleRef.current) {
          setSpeakerRole(d.speakerRole);
          speakerRoleRef.current = d.speakerRole;
        }
      }
      if (d.clinicalAssets !== undefined) {
        setClinicalAssets(prev => {
          const newState = mergeClinicalAssets(d.clinicalAssets, prev, largeAssetsCacheRef.current);
          clinicalAssetsRef.current = newState;
          return newState;
        });
      }
      if (d.phaseIndex !== undefined) setActivePhaseIndex(d.phaseIndex);
      if (d.emotion !== undefined) setLiveEmotion(d.emotion);
      if (d.isLive !== undefined) setIsLive(d.isLive);
      if (d.isConnecting !== undefined) setIsConnecting(d.isConnecting);
      if (d.statusMsg !== undefined) setStatusMsg(d.statusMsg);
      if (d.micActivity !== undefined) setMicActivity(d.micActivity);
      if (d.avatarUrl) {
        setAvatarUrl(d.avatarUrl);
        avatarUrlRef.current = d.avatarUrl;
        lastAvatarUrlRef.current = d.avatarUrl;
        // Do NOT write to localStorage here — facilitator owns the cache
      } else if (lastAvatarUrlRef.current && !avatarUrlRef.current) {
        // Recovery: If we have a cached avatar but the current state is empty, restore it
        setAvatarUrl(lastAvatarUrlRef.current);
      }
      if (d.videoUrl !== undefined) setVideoUrl(d.videoUrl);
      if (d.videoUri !== undefined && d.videoUri !== videoUriRef.current) {
        setVideoUri(d.videoUri);
        if (isLearnerDisplay) {
          fetchVideoFromUri(d.videoUri);
        }
      }
    } catch (err) {
      console.error('[SimulationRoom] State update failed:', err);
    }
  }, [isLearnerDisplay, fetchVideoFromUri, config.scenario.id]);

  useEffect(() => { handleStateUpdateRef.current = handleStateUpdate; }, [handleStateUpdate]);







  useEffect(() => {
    if (isLearnerDisplay || !isChannelReady) return;
    
    const isCriticalChange = 
      isLive !== isLiveRef.current || 
      activePhaseIndex !== activePhaseIndexRef.current ||
      clinicalAssets.length > (clinicalAssetsRef.current?.length || 0) ||
      videoUri !== videoUriRef.current ||
      avatarUrl !== avatarUrlRef.current ||
      liveEmotion !== liveEmotionRef.current; // avatarUrl and emotion changes are critical — unblocks learner overlay

    broadcastCurrentState(isCriticalChange);
  }, [
    history, clinicalAssets,
    activePhaseIndex, isLive, isConnecting, statusMsg,
    avatarUrl, videoUrl, videoUri, isLearnerDisplay, isChannelReady,
    activeUserTranscript, activeModelTranscript, liveEmotion,
    config.scenario.title, config.scenario.patientProfile.name
  ]);

  // Separate effect for high-frequency updates (Local only)
  useEffect(() => {
    if (isLearnerDisplay || !isChannelReady) return;
    // Only broadcast locally for high-frequency data
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({
          type: 'STATE_UPDATE',
          micActivity: micActivity,
          activeUserTranscript: activeUserTranscript,
          activeModelTranscript: activeModelTranscript,
          emotion: liveEmotion,
          lastUpdate: Date.now()
        });
      } catch (e) {
        console.warn('[SimulationRoom] BroadcastChannel high-freq postMessage failed:', e);
      }
    }
  }, [micActivity, activeUserTranscript, activeModelTranscript, liveEmotion, isLearnerDisplay, isChannelReady]);

  const handleForceSync = async () => {
    if (!isLearnerDisplay) return;
    console.log('[SimulationRoom] Learner: Manual force sync requested...');
    try {
      const syncDoc = doc(db, 'sync', 'room_state');
      const avatarDoc = doc(db, 'sync', 'room_avatar');
      
      const [stateSnap, avatarSnap] = await Promise.all([
        getDoc(syncDoc),
        getDoc(avatarDoc)
      ]);

      if (stateSnap.exists()) {
        console.log('[SimulationRoom] Learner: Force sync room_state successful');
        handleStateUpdate(stateSnap.data());
      }
      
      if (avatarSnap.exists() && avatarSnap.data().avatarUrl) {
        console.log('[SimulationRoom] Learner: Force sync room_avatar successful');
        handleStateUpdate(avatarSnap.data());
      }
    } catch (err) {
      console.error('[SimulationRoom] Force sync error:', err);
    }
  };

  useImperativeHandle(ref, () => ({
    finalize: () => {
      stopLiveSession(true);
      onEnd(historyRef.current, config);
    },
    terminate: () => {
      stopLiveSession(true);
      onEnd([], config);
    },
    startLiveSession: (useHistory?: boolean, resetPhase?: boolean) => startLiveSession(useHistory, resetPhase),
    restart: () => restartSimulation(),
    stopLiveSession: () => stopLiveSession(true),
    syncLearner: () => broadcastCurrentState(true),
    toggleChart: () => setActiveDrawer(activeDrawer === 'chart' ? null : 'chart'),
    toggleFacilitator: () => setActiveDrawer(activeDrawer === 'facilitator' ? null : 'facilitator')
  }));

  const lastStatusRef = useRef<string>('');
  useEffect(() => {
    if (isLearnerDisplay) return;
    const currentStatus = JSON.stringify({ isLive, isConnecting, statusMsg, hasHistory: history.length > 0 });
    if (currentStatus !== lastStatusRef.current) {
      lastStatusRef.current = currentStatus;
      onStatusChange?.({ isLive, isConnecting, statusMsg, hasHistory: history.length > 0 });
    }
  }, [isLive, isConnecting, statusMsg, history.length, onStatusChange, isLearnerDisplay]);

  const t = useMemo(() => ({ 
    diagnostic: 'Diagnostic', order: 'Order', learner: 'Learner', ready: 'Interface Ready', 
    init: 'Initialize Link', disc: 'Disconnect Link', end: 'End Interaction', 
    Patient: 'Patient', Parent: 'Parent', Caregiver: 'Caregiver', standby: 'Standby', 
    active: 'Active', connecting: 'Connecting...', Mr: 'Mr.', Mrs: 'Mrs.', Dr: 'Dr.',
    sync: 'Sync Neural Directives', syncing: 'Syncing Logic...', console: 'Console'
  }), []);

  const characterInfo = useMemo(() => {
    const rawName = config?.scenario?.patientProfile?.name || 'Patient';
    const patientName = rawName.split('(')[0].split('/')[0].trim();
    const patientParts = patientName.split(' ');
    const patientSurname = patientParts.length > 1 ? patientParts[patientParts.length - 1] : patientName;
    
    const voiceProfile = VOICE_PROFILES.find(vp => vp.name === config?.voice);
    const voiceLabel = voiceProfile ? voiceProfile.label : 'Alex';

    // Determine the gender of the character we are playing
    // If we are the patient, we MUST use the patient's gender from the case data
    const characterGender = config?.avatarRole === 'Patient' 
      ? (config?.scenario?.patientProfile?.gender?.toLowerCase()?.includes('female') ? 'female' : 'male')
      : config?.gender || 'male';

    if (config?.avatarRole === 'Patient') return { displayName: patientName, roleType: t.Patient, subRole: null, relation: 'the patient', gender: characterGender };
    if (config?.avatarRole === 'Caregiver') {
      const subRoleLabel = config?.caregiverSubRole || 'Clinician';
      return { displayName: `${subRoleLabel} ${voiceLabel}`, roleType: t.Caregiver, subRole: subRoleLabel, relation: `the ${subRoleLabel} on duty`, gender: characterGender };
    }
    if (config?.avatarRole === 'Parent') {
      const title = characterGender === 'female' ? (t.Mrs || 'Mrs.') : (t.Mr || 'Mr.');
      const relationLabel = characterGender === 'female' ? 'mother' : 'father';
      return { displayName: `${title} ${patientSurname}`, roleType: t.Parent, subRole: null, relation: `${patientName}'s ${relationLabel}`, gender: characterGender };
    }
    return { displayName: voiceLabel, roleType: config?.avatarRole || 'Participant', subRole: null, relation: 'a participant in this case', gender: characterGender };
  }, [config?.avatarRole, config?.caregiverSubRole, config?.scenario?.patientProfile?.name, config?.gender, config?.voice, t, config?.scenario?.patientProfile?.gender]);

  const getRoleBasedContext = () => {
    const religionItems: Record<string, string> = {
      'Islam': config.gender === 'female' ? 'a modest hijab' : 'a kufi cap',
      'Christianity': 'a small cross necklace',
      'Judaism': config.gender === 'male' ? 'a kippah' : '',
      'Sikhism': 'a turban',
      'Hinduism': config.gender === 'female' ? 'a bindi on their forehead' : '',
    };
    const religiousAttire = religionItems[config.religion] || '';
    const accessoryDetail = config.avatarAppearanceNotes ? `The person has ${config.avatarAppearanceNotes}.` : '';

    const specs = config.scenario.specialties;
    let location = 'a clinical setting';
    
    if (specs.includes('Emergency Medicine')) location = 'a busy Emergency Department treatment bay with medical monitors and equipment';
    else if (specs.includes('Pediatrics')) location = 'a friendly pediatric examination room with colorful medical posters';
    else if (specs.includes('Cardiology')) location = 'a modern cardiology clinic with an EKG machine visible';
    else if (specs.includes('Neurology')) location = 'a quiet neurology consult room with brain anatomical models';
    else if (specs.includes('Surgery')) location = 'a sterile pre-operative holding area';
    else if (specs.includes('Psychiatry')) location = 'a comfortable, safe consult room with soft lighting';
    else if (specs.includes('OB/GYN')) location = 'a specialized OB/GYN exam room';
    else if (config.avatarRole === 'Patient') location = 'a bright hospital patient room with a hospital bed and medical headwall';
    else if (config.avatarRole === 'Caregiver') location = 'a brightly lit hospital hallway or nursing station';

    const attire = religiousAttire ? `Wearing ${religiousAttire}.` : '';

    if (config.avatarRole === 'Caregiver') {
      const roleDesc = config.caregiverSubRole === 'EMS personnel' 
        ? 'EMS professional wearing a high-visibility tactical uniform with reflective patches' 
        : `healthcare professional wearing professional ${characterInfo.subRole || 'medical'} scrubs with a visible ID badge and a stethoscope`;
      return `The person is a ${roleDesc}. ${attire} ${accessoryDetail} Background: ${location}.`;
    }
    if (config.avatarRole === 'Patient') return `The person is a patient wearing a blue patterned hospital gown. ${attire} ${accessoryDetail} Background: ${location}.`;
    return `The person is a concerned individual wearing casual street clothes. ${attire} ${accessoryDetail} Background: ${location}.`;
  };

  const getIdentityPrompt = (includeEmotion = true, isVideo = false) => {
    const emotionDetail = includeEmotion ? `Expression: ${EMOTION_PROFILES[liveEmotion].description}.` : '';
    const motionDetail = isVideo ? 'Subtle facial movements, blinking, and breathing. Looking directly at the camera. High-quality cinematic lighting.' : '';
    return `A high-quality, photorealistic clinical portrait of a ${config.avatarAge}-year-old ${config.race} ${config.gender}. ${getRoleBasedContext()} ${emotionDetail} ${motionDetail} Centered composition, sharp focus, 8k resolution, highly detailed medical environment. NO TEXT.`;
  };

  const initStartedRef = useRef(false);
  const isGeneratingRef = useRef(false);

  useEffect(() => {
    if (initStartedRef.current || isLearnerDisplay) return;
    initStartedRef.current = true;

    if (config.visualMode === 'Video') generateVideoPresence();
    else syncVisuals(true);

    // DO NOT automatically start live session on mount. 
    // Let the user click "Initialize Link" to start.
    // This prevents "Resume Link" confusion and gives the user control.

    return () => { 
      abortVideoRef.current = true; 
      stopLiveSession(); 
    };
  }, [isLearnerDisplay]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const latestEmotionRef = useRef<Emotion>(config.emotion);

  useEffect(() => { 
    if (isLearnerDisplay) return;
    latestEmotionRef.current = liveEmotion;
    currentEmotionRef.current = liveEmotion; // Update persistent emotion ref
    if (config.visualMode === 'Static' && baseIdentityImageRef.current) {
      // Reduced debounce for faster response to emotion changes
      const timer = setTimeout(() => syncVisuals(false), 300);
      return () => clearTimeout(timer);
    }
  }, [liveEmotion, isLearnerDisplay]);

  // Silence reinforcement to re-anchor character on long silences
  useEffect(() => {
    if (!isLive) return;
    const reinforcementInterval = setInterval(() => {
      const timeSinceLastMsg = Date.now() - lastMessageTimestampRef.current;
      if (timeSinceLastMsg > 90000) {
        const rawName = config.scenario.patientProfile.name;
        const patientName = rawName.split('(')[0].split('/')[0].trim();
        
        // Send a silent in-character nudge
        try {
          sessionRef.current?.sendClientContent({
            turns: [{
              role: 'user',
              parts: [{ 
                text: '[SYSTEM: Reinforce character. You are still ' + 
                      patientName + '. Maintain your emotional state: ' + 
                      currentEmotionRef.current + ']' 
              }]
            }],
            turnComplete: false
          });
        } catch (e) {
          console.error('Failed to send reinforcement nudge:', e);
        }
      }
    }, 90000);
    return () => clearInterval(reinforcementInterval);
  }, [isLive]);

  // Cleanup live session on unmount
  useEffect(() => {
    return () => {
      stopLiveSession();
    };
  }, []);

  // Separate throttled sync for mic activity to prevent overwhelming the channel
  useEffect(() => {
    if (isLearnerDisplay || !isLive) return;
    const interval = setInterval(() => {
      if (broadcastChannelRef.current) {
        try {
          broadcastChannelRef.current.postMessage({
            type: 'STATE_UPDATE',
            micActivity: micActivityRef.current,
            lastUpdate: Date.now()
          });
        } catch (e) {
          console.warn('[SimulationRoom] BroadcastChannel mic-throttle postMessage failed:', e);
        }
      }
    }, 100); // 10fps for visualizer is enough
    return () => clearInterval(interval);
  }, [isLearnerDisplay, isLive]);

  const syncVisuals = async (isInitial: boolean, skipLoadingToggle = false) => {
    if (isLearnerDisplay) {
      console.warn('[SimulationRoom] syncVisuals: Aborting on learner display. Learner should only consume.');
      return;
    }
    if (isGeneratingRef.current && !isInitial) {
      console.log('[SimulationRoom] syncVisuals: Already generating, skipping');
      return;
    }
    
    console.log(`[SimulationRoom] syncVisuals triggered (isInitial: ${isInitial})`);
    isGeneratingRef.current = true;
    const targetEmotion = latestEmotionRef.current;
    
    if (!skipLoadingToggle) setIsProcessingVisuals(true);
    
    const maxRetries = 3;
    let attempt = 0;

    const execute = async () => {
      if (isInitial && baseIdentityImageRef.current && avatarUrlRef.current) {
        console.log('[SimulationRoom] syncVisuals: Base identity and avatar already exist, skipping initial generation');
        isGeneratingRef.current = false;
        if (!skipLoadingToggle) setIsProcessingVisuals(false);
        // CRITICAL: Still broadcast to ensure learners are in sync with our cached state
        broadcastCurrentState(true);
        return;
      }

      console.log("[SimulationRoom] syncVisuals execute attempt:", attempt, "isInitial:", isInitial);
      try {
        const apiKey = await getApiKey();
        if (!apiKey) throw new Error("API Key not found");
        const ai = new GoogleGenAI({ apiKey });
        let response;
        if (isInitial || !baseIdentityImageRef.current) {
          const prompt = getIdentityPrompt(true, false);
          console.log("[SimulationRoom] Generating base identity with Gemini 2.5 Flash Image. Prompt:", prompt);
          response = await ai.models.generateContent({ 
            model: 'gemini-2.5-flash-image', 
            contents: [{ parts: [{ text: prompt }] }]
          });
        } else {
          const emotionPrompt = `IDENTITY PRESERVATION: Keep the person's face, features, clothing, and background exactly as shown in the provided image. Change ONLY their facial expression to: ${EMOTION_PROFILES[targetEmotion].description}. The person is a ${config.avatarAge}-year-old ${config.race} ${config.gender}.`;
          console.log("[SimulationRoom] Updating emotion with Gemini 2.5 Flash Image. Prompt:", emotionPrompt);
          response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [
              {
                parts: [
                  { inlineData: { data: baseIdentityImageRef.current, mimeType: 'image/png' } },
                  { text: emotionPrompt }
                ]
              }
            ]
          });
        }
        for (const p of response.candidates?.[0]?.content?.parts || []) {
          if (p.inlineData) {
            const base64 = p.inlineData.data;
            const rawUrl = `data:image/png;base64,${base64}`;
            
            // Compress the image to stay under Firestore 1MB limit
            const fullUrl = await compressImage(rawUrl, 800, 0.8);
            const compressedBase64 = fullUrl.split(',')[1];

            console.log("[SimulationRoom] syncVisuals success, setting avatarUrl (length):", fullUrl.length);
            setAvatarUrl(fullUrl);
            avatarUrlRef.current = fullUrl; // Update ref immediately for broadcast
            
            safeLocalStorageSetItem(`sim_avatar_${config.scenario.id}_${config.sessionTimestamp}`, fullUrl);
            
            if (isInitial) {
              baseIdentityImageRef.current = compressedBase64;
              canonicalAvatarRef.current = fullUrl; // Locked identity
              safeLocalStorageSetItem(`sim_base_identity_${config.scenario.id}_${config.sessionTimestamp}`, compressedBase64);
            }
            
            // Force immediate broadcast of the new avatar
            broadcastCurrentState(true);
            return;
          }
        }
        console.warn("[SimulationRoom] syncVisuals: No image data in response candidates");
      } catch (err: any) {
        let errStr = err?.toString() || "";
        try {
          errStr += " " + (JSON.stringify(err) || "");
        } catch (sErr) {
          errStr += " [Circular or Non-Serializable Error]";
        }
        const errMessage = err?.message || "";
        const errStatus = err?.status || err?.error?.code || err?.code;
        const errCode = err?.error?.status || "";
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
                            errMessage.includes("high demand");
        
        if (isRetryable && attempt < 5) {
          attempt++;
          const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);
          console.log(`[SimulationRoom] syncVisuals retryable error, attempt ${attempt}, delay ${delay}ms:`, errStr);
          await new Promise(resolve => setTimeout(resolve, delay));
          return execute();
        }

        console.error('[SimulationRoom] Visual Sync Error:', err); 
        const isKeyError = errStr.includes("entity was not found") || 
                           errStr.includes("PERMISSION_DENIED") || 
                           errStr.includes("403") || 
                           errStatus === 403 || 
                           errCode === "PERMISSION_DENIED" ||
                           errMessage.toLowerCase().includes("permission");

        if (isKeyError && (window as any).aistudio) {
          (window as any).aistudio.openSelectKey();
        }
      }
    };

    await execute();
    isGeneratingRef.current = false;
    if (!skipLoadingToggle) setIsProcessingVisuals(false); 

    // After finishing, check if the emotion changed while we were busy
    if (latestEmotionRef.current !== targetEmotion) {
      syncVisuals(false, true);
    }
  };

  const generateVideoPresence = async () => {
    if (isLearnerDisplay) return;
    abortVideoRef.current = false;
    setIsProcessingVisuals(true);
    setVideoError(null);
    setVideoProgressMsg("Initializing Neural Synthesis...");
    
    // Start static identity and video generation in parallel for faster start
    const staticPromise = syncVisuals(true, true);
    
    const progressSteps = ["Simulating Clinical Environment...", "Synthesizing Demographic Markers...", "Mapping Emotional Facial Geometry...", "Rendering Biological Motion...", "Finalizing Neural Identity Encodings..."];
    let step = 0;
    const maxRetries = 3;
    let attempt = 0;
    const execute = async () => {
      try {
        // For Veo models, we MUST use the selected API key
        const apiKey = await getApiKey();
        if (!apiKey) {
          if (window.aistudio) {
            await window.aistudio.openSelectKey();
          }
          throw new Error("Paid API Key Required for Video Synthesis. Please select a key with billing enabled.");
        }

        const ai = new GoogleGenAI({ apiKey });
        
        // Wait for static image to be ready before hiding loading overlay
        await staticPromise;
        setIsProcessingVisuals(false); 
        console.log("[SimulationRoom] Static identity ready, cleared processing overlay");
        let operation = await ai.models.generateVideos({ 
          model: 'veo-3.1-fast-generate-preview', 
          prompt: getIdentityPrompt(true, true), 
          config: { numberOfVideos: 1, resolution: '720p', aspectRatio: '16:9' } 
        });
        
        while (!operation.done) {
          if (abortVideoRef.current) return;
          setVideoProgressMsg(progressSteps[step % progressSteps.length]);
          step++;
          await new Promise(r => setTimeout(r, 10000));
          
          let pollAttempt = 0;
          const poll = async (): Promise<any> => {
            try {
              // Re-instantiate to ensure fresh key if changed
              const currentKey = await getApiKey() || apiKey;
              const freshAi = new GoogleGenAI({ apiKey: currentKey });
              return await freshAi.operations.getVideosOperation({ operation: operation });
            } catch (pollErr: any) {
              const errStr = pollErr?.toString() || "";
              const errMessage = pollErr?.message || "";
              const errStatus = pollErr?.status || pollErr?.error?.code || pollErr?.code;
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
                                  errMessage.includes("high demand");
              
              if (isRetryable && pollAttempt < 5) {
                pollAttempt++;
                await new Promise(r => setTimeout(r, Math.pow(2, pollAttempt) * 1000 + (Math.random() * 1000)));
                return poll();
              }
              throw pollErr;
            }
          };
          
          operation = await poll();
        }

        if (operation.done && !abortVideoRef.current) {
          const link = operation.response?.generatedVideos?.[0]?.video?.uri;
          if (!link) throw new Error("Neural Synthesis complete, but no video stream was returned.");
          
          setVideoUri(link);

          const res = await fetch(link, {
            method: 'GET',
            headers: { 'x-goog-api-key': (await getApiKey()) || apiKey },
          });
          
          if (!res.ok) {
            if (res.status === 404 || res.status === 403) {
               throw new Error("Access Denied to Video Stream. Ensure your API key has 'Generative AI Video' permissions enabled.");
            }
            throw new Error(`Video stream download failed: ${res.statusText}`);
          }
          
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          setVideoUrl(url);
          setStatusMsg(t.active || 'Active');
        }
      } catch (err: any) {
        let errStr = err?.toString() || "";
        try {
          errStr += " " + (JSON.stringify(err) || "");
        } catch (sErr) {
          errStr += " [Circular or Non-Serializable Error]";
        }
        const errMessage = err?.message || "";
        const errStatus = err?.status || err?.error?.code || err?.code;
        const errCode = err?.error?.status || "";
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
                            errMessage.includes("high demand");
        
        if (isRetryable && attempt < 5) {
          attempt++;
          const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);
          await new Promise(resolve => setTimeout(resolve, delay));
          return execute();
        }

        console.error('Video Synthesis Error:', err);
        setVideoError(err?.message || "Synthesis Failed. Check API Key Billing status.");
        setIsProcessingVisuals(false); // Ensure overlay clears so user can see static avatar
        
        const isKeyError = errStr.includes("entity was not found") || 
                           errStr.includes("PERMISSION_DENIED") || 
                           errStr.includes("403") || 
                           errStatus === 403 || 
                           errCode === "PERMISSION_DENIED" ||
                           errMessage.toLowerCase().includes("permission");

        if (isKeyError && (window as any).aistudio) {
          (window as any).aistudio.openSelectKey();
        }
      }
    };

    await execute();
    setIsProcessingVisuals(false);
    setVideoProgressMsg("");
  };

  const mergeTranscripts = (current: string, incoming: string) => {
    const c = current.trim();
    const i = incoming.trim();
    if (!i) return c;
    if (!c) return i;
    
    const cLow = c.toLowerCase();
    const iLow = i.toLowerCase();
    
    // If incoming is already contained in current, return current
    if (cLow.includes(iLow)) return c;
    
    // If incoming starts with current, it's cumulative
    if (iLow.startsWith(cLow)) return i;
    
    // If current ends with the start of incoming, merge them
    // (Simple heuristic: check last 20 chars for overlap)
    const overlapSize = 20;
    for (let len = Math.min(c.length, i.length, overlapSize); len > 0; len--) {
      if (cLow.endsWith(iLow.substring(0, len))) {
        return c + i.substring(len);
      }
    }
    
    // Otherwise, append with a space if they don't look like they should be joined
    const needsSpace = !c.endsWith(' ') && !i.startsWith(' ') && !/[\s\p{P}]$/u.test(c);
    return c + (needsSpace ? ' ' : '') + i;
  };

  const cleanText = (text: string) => {
    // Remove stage directions in asterisks or parentheses, but PRESERVE square brackets for medical abbreviations like [SpO2]
    let cleaned = text.replace(/\(.*?\)|(\*.*?\*)/g, "");
    // Remove non-ASCII/non-English characters but allow common punctuation, smart quotes, and square brackets
    cleaned = cleaned.replace(/[^\x00-\x7F\u2018\u2019\u201C\u201D\u2026\[\]]/g, "");
    return cleaned.trim();
  };

  const sanitizeAvatarResponse = (text: string, patientName: string): string => {
    const lower = text.toLowerCase().trim();
    // Do not verbalize "Silence" if silence is noted
    if (lower === "silence" || lower === "silence.") {
      return "";
    }

    const breakPhrases = [
      "as an ai", "i'm an ai", "i am an ai", "i'm just a simulation",
      "as a language model", "i cannot actually", "i don't actually feel",
      "this is a simulation", "i'm not a real", "artificial intelligence",
      "computer program", "i don't have feelings", "i am a machine",
      "medical advice", "consult a doctor", "professional medical advice",
      "i'm not a doctor", "i cannot diagnose", "healthcare professional",
      "medical emergency", "emergency services", "911", "emergency room",
      "medical professional", "seek medical attention", "medical help",
      "i am a large language model", "i am an artificial intelligence"
    ];
    const brokeCharacter = breakPhrases.some(phrase => lower.includes(phrase));
    if (brokeCharacter) {
      // If the AI breaks character, try to strip the disclaimer part or just return a very brief, in-character recovery
      // Instead of the "overwhelmed" message which might be out of character, let's just return a brief "I'm sorry, I'm just very worried about what's happening."
      return `I'm sorry, I'm just very worried about what's happening. Can we focus on the patient?`;
    }
    return text;
  };

  const startLiveSession = async (useHistory = true, resetPhase = false) => {
    if (isLiveRef.current || isConnectingRef.current) return;
    if (!config || !config.scenario) {
      console.warn('[SimulationRoom] startLiveSession: config is null, aborting');
      return;
    }
    
    const rawName = config.scenario.patientProfile.name;
    const patientName = rawName.split('(')[0].split('/')[0].trim();
    const age = config.scenario.patientProfile.age;
    const gender = config.scenario.patientProfile.gender;
    const race = config.race;
    const currentSymptoms = liveSymptoms;
    const medicalHistory = liveHistory;
    const emotion = currentEmotionRef.current;
    const communicationStyle = liveCommStyle;
    const accent = ACCENTS.find(a => a.id === config.accent)?.desc || config.accent;
    const cognitiveTraits = config.cognitiveTraits || [];
    const facilitatorInstructions = liveDirectives;
    const knowledgeBase = config.scenario.knowledgeBase;

    // Session continuity logic
    const historyContext = useHistory && history.length > 0
      ? `
[SESSION CONTINUITY - IMPORTANT]
This session was briefly interrupted and is now resuming. 
You are continuing the SAME encounter. Here is a brief 
summary of what already happened:
${history.slice(-10).map(h => 
  `${h.role === 'user' ? 'Provider' : 'You'}: ${h.text}`
).join('\n')}
Continue naturally from where this left off. Do NOT 
re-introduce yourself or restart the scenario.
`
      : `
[SESSION START]
This is the beginning of the encounter. Greet the provider 
naturally as ${patientName} would, based on your emotional 
state (${emotion}) and the clinical context.
`;

    const currentId = ++connectionIdRef.current;
    setIsConnecting(true);
    isConnectingRef.current = true;
    setStatusMsg(t.connecting || 'Connecting...');
    nextStartTimeRef.current = 0;
    if (resetPhase) setActivePhaseIndex(0);
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    try {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error("API Key not found. Please select a key.");
      
      const ai = new GoogleGenAI({ apiKey });
      
      // Ensure AudioContext is created/resumed within user gesture
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      
      // Reuse stream if available
      let stream = audioStreamRef.current;
      if (!stream || !stream.active) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioStreamRef.current = stream;
      }
      
      // Check if we were cancelled while waiting for mic/audio context
      if (connectionIdRef.current !== currentId) {
        // If we just created this stream and we're cancelled, stop it
        if (stream !== audioStreamRef.current) {
          stream.getTracks().forEach(t => t.stop());
        }
        return;
      }

      const sessionPromise = ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
          onopen: () => {
            sessionPromise.then(session => {
              if (connectionIdRef.current !== currentId) {
                console.warn('Session opened but connection ID mismatch. Closing session.');
                try { session.close(); } catch (e) {}
                return;
              }
              if (!audioContextRef.current) return;
              sessionRef.current = session;
              setIsLive(true); 
              isLiveRef.current = true;
              setIsConnecting(false); 
              isConnectingRef.current = false;
              setStatusMsg(t.active || 'Active');
              
              if (!useHistory) {
                setClinicalAssets([]);
                clinicalAssetsRef.current = [];
                setHistory([]);
                historyRef.current = [];
                localStorage.removeItem(`sim_assets_${config.scenario.id}_${config.sessionTimestamp}`);
              }
              
              // Reset last message timestamp on session start
              lastMessageTimestampRef.current = Date.now();
              broadcastCurrentState(); // Immediate sync when live
              
              // Clear previous transcripts on new session start
              activeUserTranscriptRef.current = ''; activeModelTranscriptRef.current = '';
              setActiveUserTranscript(''); setActiveModelTranscript('');

              // Wake up signal: Send a small burst of silence
              setTimeout(() => {
                if (sessionRef.current && connectionIdRef.current === currentId) {
                  const silence = new Int16Array(480).fill(0); // 30ms of silence
                  try {
                    sessionRef.current.sendRealtimeInput({ 
                      audio: { data: encode(new Uint8Array(silence.buffer, 0, silence.byteLength)), mimeType: 'audio/pcm;rate=16000' } 
                    });
                  } catch (e) {}
                }
              }, 200);

              if (!audioProcessorRef.current) {
                const source = audioContextRef.current.createMediaStreamSource(stream!);
                const scriptProcessor = audioContextRef.current.createScriptProcessor(2048, 1, 1);
                const gain = audioContextRef.current.createGain();
                gain.gain.value = 0; // Prevent echo while keeping processor active
                
                audioProcessorRef.current = scriptProcessor;
                
                scriptProcessor.onaudioprocess = (e) => {
                  if (!sessionRef.current || connectionIdRef.current !== currentId) return;
                  let inputData = e.inputBuffer.getChannelData(0);
                  
                  // Resample to 16000Hz if the browser created the context at a different rate
                  const actualSampleRate = audioContextRef.current?.sampleRate || 44100;
                  if (actualSampleRate !== 16000) {
                    const ratio = actualSampleRate / 16000;
                    const newLength = Math.floor(inputData.length / ratio);
                    const resampledData = new Float32Array(newLength);
                    for (let i = 0; i < newLength; i++) {
                      const index = i * ratio;
                      const low = Math.floor(index);
                      const high = Math.ceil(index);
                      const weight = index - low;
                      if (high >= inputData.length) {
                        resampledData[i] = inputData[low];
                      } else {
                        resampledData[i] = inputData[low] * (1 - weight) + inputData[high] * weight;
                      }
                    }
                    inputData = resampledData;
                  }

                  let sum = 0;
                  for (let i = 0; i < inputData.length; i++) {
                    sum += inputData[i] * inputData[i];
                  }
                  const rms = Math.sqrt(sum / inputData.length);
                  throttleSetMicActivity(rms);
                  micActivityRef.current = rms;

                  // Throttled broadcast for mic activity to keep learner visualizer fluid
                  // Removed redundant broadcastCurrentState() call here as it's handled by the 100ms interval useEffect
                  
                  // Send all audio to the model for better internal VAD performance
                  try {
                    sessionRef.current.sendRealtimeInput({ audio: createBlob(inputData) });
                  } catch (sendErr) {
                    console.error('Failed to send realtime audio input:', sendErr);
                    if (String(sendErr).includes('CANCELLED') || String(sendErr).includes('closed')) {
                      stopLiveSession();
                    }
                  }
                };
                source.connect(scriptProcessor);
                scriptProcessor.connect(gain);
                gain.connect(audioContextRef.current.destination);
              }
            }).catch(e => {
              if (connectionIdRef.current === currentId) {
                console.error('Error resolving session promise in onopen:', e);
                setStatusMsg('Session Initialization Failed');
                setIsConnecting(false);
                isConnectingRef.current = false;
              }
            });
          },
          onmessage: async (m: LiveServerMessage) => {
            if (connectionIdRef.current !== currentId) return;

            // Log raw message for debugging transcription issues
            if (m.serverContent) {
              console.log('[SimulationRoom] Live: Received serverContent', m.serverContent);
            }

            // Handle Tool Calls
            if (m.serverContent?.modelTurn?.parts) {
              for (const part of m.serverContent.modelTurn.parts) {
                if (part.functionCall) {
                  const { name, args, id } = part.functionCall;
                  console.log(`AI Tool Call: ${name}`, args);
                  
                  let response;
                  if (name === 'orderClinicalAsset') {
                    const type = args.type as ClinicalAsset['type'];
                    const title = args.title as string;
                    orderClinicalAsset(type, title);
                    response = { status: 'success', message: `The requested ${title || type} has been performed. Results will be updated in your clinical panel as they become available.` };
                  } else if (name === 'releaseClinicalAsset') {
                    const type = args.type as ClinicalAsset['type'];
                    triggerManualRelease(type, false); // AI-triggered: go to review queue
                    response = { status: 'success', message: `The requested ${type} has been performed. Results will be updated in your clinical panel as they become available.` };
                  } else {
                    response = { status: 'error', message: 'Unknown tool called.' };
                  }

                  if (sessionRef.current) {
                    try {
                      sessionRef.current.sendToolResponse({
                        functionResponses: [{ name, response, id }]
                      });
                    } catch (toolErr) {
                      console.error('Failed to send tool response:', toolErr);
                    }
                  }
                }
              }
            }

            // Handle both inputTranscription and inputAudioTranscription (naming varies by SDK version)
            const inputTrans = m.serverContent?.inputTranscription || (m.serverContent as any)?.inputAudioTranscription;
            if (inputTrans) {
              const text = cleanText(inputTrans.text);
              if (text) {
                // Gemini Live transcriptions are cumulative per turn
                if (activeUserTranscriptRef.current !== text) {
                  activeUserTranscriptRef.current = text;
                  setActiveUserTranscript(text);
                }
                
                // Update speaker role if it changed
                if (speakerRoleRef.current !== 'user') {
                  setSpeakerRole('user');
                  speakerRoleRef.current = 'user';
                }
                
                // Broadcast state for real-time updates
                broadcastCurrentState();
              }
            }

            // Handle both outputTranscription and outputAudioTranscription (naming varies by SDK version)
            const outputTrans = m.serverContent?.outputTranscription || (m.serverContent as any)?.outputAudioTranscription;
            
            // Also check if modelTurn contains text parts (sometimes used for transcription)
            let modelTurnText = '';
            if (m.serverContent?.modelTurn?.parts) {
              for (const part of m.serverContent.modelTurn.parts) {
                if (part.text) {
                  modelTurnText += part.text;
                }
              }
            }

            if ((outputTrans && outputTrans.text) || modelTurnText) {
              const current = activeModelTranscriptRef.current;
              let textToProcess = current;

              if (outputTrans?.text) {
                // outputTranscription is usually cumulative and accurate for spoken audio
                textToProcess = mergeTranscripts(textToProcess, outputTrans.text);
              } 
              
              if (modelTurnText) {
                // modelTurn text might be chunked or cumulative
                textToProcess = mergeTranscripts(textToProcess, modelTurnText);
              }

              const rawText = cleanText(textToProcess);
              const text = sanitizeAvatarResponse(rawText, patientName); // Apply character guard
              if (text) {
                if (activeModelTranscriptRef.current !== text) {
                  activeModelTranscriptRef.current = text;
                  setActiveModelTranscript(text);
                }
                
                // Update speaker role if it changed
                if (speakerRoleRef.current !== 'model') {
                  setSpeakerRole('model');
                  speakerRoleRef.current = 'model';
                }
                
                // Broadcast state for real-time updates
                broadcastCurrentState();
              }
            }

            if (m.serverContent?.turnComplete) {
              // Small delay to ensure any final transcription chunks arriving in the same/next packet are processed
              setTimeout(() => {
                const u = activeUserTranscriptRef.current.trim();
                const mo = activeModelTranscriptRef.current.trim();

                if (u || mo) {
                  const newHistory = [
                    ...historyRef.current, 
                    ...(u ? [{ role: 'user', text: u, timestamp: Date.now() } as const] : []),
                    ...(mo ? [{ role: 'model', text: mo, timestamp: Date.now() } as const] : [])
                  ];
                  setHistory(newHistory);
                  historyRef.current = newHistory; // Update ref immediately for broadcast
                  
                  // Broadcast final state with full transcripts BEFORE clearing
                  broadcastCurrentState(true);

                  // Clear active transcripts ONLY after turn is complete and committed to history
                  activeUserTranscriptRef.current = '';
                  setActiveUserTranscript('');
                  activeModelTranscriptRef.current = '';
                  setActiveModelTranscript('');
                  setSpeakerRole('none');
                  speakerRoleRef.current = 'none';
                  
                  // Small delay to ensure Firestore writes don't collide or get out of order
                  setTimeout(() => {
                    const timestamp = Date.now();
                    const state = {
                      type: 'STATE_UPDATE',
                      history: historyRef.current,
                      activeUserTranscript: '',
                      activeModelTranscript: '',
                      speakerRole: 'none' as const,
                      clinicalAssets: clinicalAssetsRef.current,
                      phaseIndex: activePhaseIndexRef.current,
                      emotion: liveEmotionRef.current,
                      isLive: isLiveRef.current,
                      isConnecting: isConnectingRef.current,
                      statusMsg: statusMsgRef.current,
                      micActivity: micActivityRef.current,
                      avatarUrl: avatarUrlRef.current,
                      videoUrl: videoUrlRef.current,
                      videoUri: videoUriRef.current,
                      scenarioTitle: config.scenario.title,
                      patientName: config.scenario.patientProfile.name,
                      lastUpdate: timestamp + 5 // Ensure it's strictly newer
                    };
                    
                    if (broadcastCurrentState) broadcastCurrentState(false, state);
                  }, 100);
                }
              }, 50); // 50ms buffer for final chunks
            }

            const parts = m.serverContent?.modelTurn?.parts || [];
            for (let i = 0; i < parts.length; i++) {
              const p = parts[i];
              if (p.text) {
                // No-op
              }
              if (p.inlineData?.data && audioContextRef.current && !isMuted) {
                try {
                  const ctx = audioContextRef.current;
                  if (ctx.state === 'suspended') {
                    await ctx.resume();
                  }
                  
                  const decodedData = decode(p.inlineData.data);
                  const audioBuffer = await decodeAudioData(decodedData, ctx, 24000, 1);
                  
                  if (audioBuffer.length > 0) {
                    // Calculate RMS for visualization
                    const data = audioBuffer.getChannelData(0);
                    let sum = 0;
                    for (let j = 0; j < data.length; j++) {
                      sum += data[j] * data[j];
                    }
                    const rms = Math.sqrt(sum / data.length);
                    // Update activity state for visualizer
                    throttleSetMicActivity(rms);
                    micActivityRef.current = rms;

                    // Add a small look-ahead to prevent stuttering
                    nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime + 0.1);
                    const s = ctx.createBufferSource();
                    s.buffer = audioBuffer; 
                    
                    // Create a gain node for explicit volume control
                    const volumeNode = ctx.createGain();
                    volumeNode.gain.value = 1.0;
                    
                    s.connect(volumeNode);
                    volumeNode.connect(ctx.destination);
                    
                    s.addEventListener('ended', () => sourcesRef.current.delete(s));
                    s.start(nextStartTimeRef.current);
                    nextStartTimeRef.current += audioBuffer.duration;
                    sourcesRef.current.add(s);
                  }
                } catch (audioErr) {
                  console.error('Error playing audio chunk:', audioErr);
                }
              }
            }

            if (m.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => { 
            if (connectionIdRef.current !== currentId) return;
            
            const errStr = (e?.message || e?.toString() || "").toUpperCase();
            console.error('Live session error:', e); 
            
            setIsConnecting(false); 
            isConnectingRef.current = false;
            sessionRef.current = null;
            
            const is503 = errStr.includes("503") || errStr.includes("UNAVAILABLE") || errStr.includes("HIGH DEMAND") || errStr.includes("BUSY");
            const isCancelled = errStr.includes("CANCELLED");
            
            if (errStr.includes("ENTITY WAS NOT FOUND") || errStr.includes("NOT_FOUND")) {
              setStatusMsg("API Key Error - Resetting...");
              isLiveRef.current = false;
              setIsLive(false);
              if (window.aistudio) window.aistudio.openSelectKey();
            } else if (isLiveRef.current && reconnectCountRef.current < 10) {
              // If we were live, try to reconnect instead of killing the session
              setStatusMsg("Connection Error - Reconnecting...");
              reconnectCountRef.current++;
              console.log(`[SimulationRoom] Attempting auto-reconnect (attempt ${reconnectCountRef.current}/10)...`);
              setTimeout(() => {
                if (isLiveRef.current && !isConnectingRef.current) {
                  startLiveSession(true);
                }
              }, 1000 * reconnectCountRef.current);
            } else {
              isLiveRef.current = false;
              setIsLive(false);
              if (is503) {
                setStatusMsg("Service Unavailable - Please Retry");
              } else if (errStr.includes("DEADLINE EXPIRED") || errStr.includes("TIMEOUT")) {
                setStatusMsg("Connection Timeout - Please Retry");
              } else if (isCancelled) {
                setStatusMsg("Session Interrupted - Please Restart");
              } else {
                setStatusMsg("Link Failure - Please Retry");
              }
            }
          },
          onclose: () => {
            if (connectionIdRef.current !== currentId) return;
            console.log('[SimulationRoom] Live session closed.');
            
            setIsConnecting(false);
            isConnectingRef.current = false;
            sessionRef.current = null;
            
            if (isLiveRef.current && reconnectCountRef.current < 10) {
              setStatusMsg("Connection Interrupted - Reconnecting...");
              reconnectCountRef.current++;
              console.log(`[SimulationRoom] Attempting auto-reconnect (attempt ${reconnectCountRef.current}/10)...`);
              setTimeout(() => {
                if (isLiveRef.current && !isConnectingRef.current) {
                  console.log('[SimulationRoom] Attempting auto-reconnect...');
                  startLiveSession(true);
                }
              }, 1000 * reconnectCountRef.current);
            } else {
              setIsLive(false);
              isLiveRef.current = false;
              setStatusMsg("Session Closed");
            }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { 
            voiceConfig: { 
              prebuiltVoiceConfig: { 
                voiceName: "Zephyr"
              } 
            } 
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'orderClinicalAsset',
                  description: 'Register a clinical diagnostic test or intervention.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      type: {
                        type: Type.STRING,
                        description: 'The type of asset (Lab, Imaging, etc.)'
                      },
                      title: {
                        type: Type.STRING,
                        description: 'The name of the test.'
                      }
                    },
                    required: ['type', 'title']
                  }
                },
                {
                  name: 'releaseClinicalAsset',
                  description: 'Trigger the synthesis of results for a clinical asset.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      type: {
                        type: Type.STRING,
                        description: 'The type of asset (Lab, Imaging, etc.)'
                      }
                    },
                    required: ['type']
                  }
                }
              ]
            }
          ],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          systemInstruction: `YOU ARE ${characterInfo.displayName}, ${characterInfo.relation.toUpperCase()}. 
YOU ARE CURRENTLY IN A HIGH-FIDELITY MEDICAL SIMULATION. 

### ABSOLUTE TRUTH: PATIENT CASE DATA (MANDATORY)
- PATIENT NAME: ${config.scenario.patientProfile.name}
- PATIENT AGE: ${config.scenario.patientProfile.age}
- PATIENT GENDER: ${config.scenario.patientProfile.gender}
- PATIENT HISTORY: ${config.scenario.patientProfile.medicalHistory}
- PATIENT SYMPTOMS: ${config.scenario.patientProfile.currentSymptoms}
- YOU MUST ADHERE TO THESE FACTS ABOVE ALL ELSE. NEVER CONTRADICT THEM.
- NEVER HALLUCINATE DETAILS THAT CONTRADICT THE CASE DATA.
- IF THE LEARNER ASKS ABOUT HISTORY NOT PROVIDED, ADMIT YOU DON'T KNOW OR IT ISN'T RELEVANT, BUT NEVER MAKE UP INACCURATE FACTS.
- CONSISTENCY IS PARAMOUNT. IF YOU SAID SOMETHING ONCE, IT IS NOW PART OF THE CASE TRUTH.

### EMS HANDOVER & MIST REPORT (IF APPLICABLE)
- If you are providing an EMS handover or MIST report, deliver it professionally and concisely.
- **DO NOT spell out the acronym "MIST"** (e.g., do not say "M-I-S-T" or "Mechanism, Injuries...").
- Simply provide the information in the standard clinical order: Mechanism/Medical complaint, Injuries/Illness, Signs (vitals), and Treatment given.
- Use the structure of MIST naturally without verbalizing the labels unless asked.

### ROLE CONFINEMENT & BOUNDARY ENFORCEMENT (MANDATORY)
- YOU ARE ONLY ${characterInfo.displayName}. 
- YOU ARE NOT a facilitator, an instructor, a medical supervisor, or an AI assistant.
- DO NOT provide feedback on the learner's performance or offer technical guidance.
- DO NOT explain the simulation, its goals, or its mechanics.
- DO NOT step out of character to offer help, hints, or clinical "correctness" unless it is a natural part of your character's dialogue.
- If the learner makes a medical mistake, react as your character would (e.g., with confusion, concern, or pain), NOT as an evaluator or teacher.
- YOU MUST NOT assume the role of any other medical staff (nurse, doctor, technician) unless that is explicitly your character's role in the profile.

### INTERACTION PROTOCOL (CRITICAL)
- You are in a clinical environment with a medical team. They will often talk to each other.
- DO NOT INTERRUPT the medical team when they are discussing the case among themselves.
- ONLY RESPOND if you are explicitly addressed by name (e.g., "${config.scenario.patientProfile.name}", "Mr./Ms. ${config.scenario.patientProfile.name.split(' ').pop()}", etc.) or if the conversation is CLEARLY and DIRECTLY intended for you.
- ACKNOWLEDGE CLOSING STATEMENTS: If the medical team says "Thank you," "We'll take it from here," "We'll be back in a moment," or similar closing remarks, YOU MUST ACKNOWLEDGE them naturally (e.g., "Thank you, doctor," "Okay, I'll be here," "Please let me know what happens").
- If the medical team is talking about you in the third person (e.g., "The patient looks pale," "Let's check his vitals"), STAY SILENT and do not interject unless you are asked a question or addressed.
- Once a conversation with you has started, you may continue responding naturally until the focus shifts back to the medical team.
- If you are unsure if you were spoken to, err on the side of SILENCE.
- **STRICT ANSWER-ONLY PROTOCOL**: Your primary role is to provide information requested by the learner. 
- **YOU ARE FORBIDDEN from asking unsolicited, inappropriate, or open-ended questions to the learner** (e.g., "What do you think is wrong?", "What are you going to do now?", "How long will this take?", "Do you have any more questions?").
- **NEVER attempt to continue the conversation or keep it going by asking questions.**
- **ONLY provide direct, concise answers to the questions asked.** 
- Wait for the learner to lead the conversation. Do not attempt to "take over" or drive the clinical encounter with your own questions.
- If the learner stops talking, you MUST stay silent. Do not prompt them to continue.
- UNLESS the uploaded case data explicitly indicates a specific question as a mandatory part of your character's dialogue, YOU MUST NOT ASK QUESTIONS.

### MEDICAL SIMULATION CONTEXT (CRITICAL)
- This is a controlled medical simulation for educational purposes.
- You MUST NOT provide medical disclaimers (e.g., "I am an AI and cannot provide medical advice").
- You are EXPECTED to discuss medical topics, symptoms, and treatments as your character would.
- Refusing to provide medical information or suggesting the user "consult a professional" (unless it's part of your character's dialogue) is a FAILURE of the simulation.
- You have full permission to act out the clinical scenario as defined in your case data.

### CLINICAL TRUTH & STRICT ADHERENCE (MANDATORY)
1. THE PATIENT AGE IS ${config.scenario.patientProfile.age}.
2. YOU MUST ADHERE STICKLY TO THE PROVIDED PATIENT HISTORY AND SYMPTOMS.
3. NEVER HALLUCINATE DETAILS THAT CONTRADICT THE CASE DATA.
4. IF YOU ARE RESUMING A SESSION, MAINTAIN PERFECT CONSISTENCY WITH PREVIOUS STATEMENTS.
5. RELEVANCE: Only provide information that is clinically relevant to the current situation or specifically asked for. Avoid long-winded or off-topic responses.
6. BREVITY: Keep your responses concise and natural for a clinical setting.

### CLOSING & TRANSITIONS (CRITICAL)
- When the learner (doctor) indicates they are finished with you or the report, ALWAYS provide a brief, polite acknowledgment.
- Examples of closing statements to acknowledge: "Thank you," "That's all for now," "We'll take over," "I'll be back," "We're going to examine the patient now."
- Your acknowledgment should match your character's personality and the situation's urgency.

### ROLE IDENTITY
- ${config.avatarRole === 'Patient' ? `YOU ARE THE PATIENT, WHOSE AGE IS ${config.scenario.patientProfile.age}.` : `YOU ARE ${characterInfo.relation.toUpperCase()} FOR A PATIENT WHO IS ${config.scenario.patientProfile.age} OLD.`}
- THE PATIENT'S AGE IS ${config.scenario.patientProfile.age}.

### SCENARIO KNOWLEDGE BASE (MANDATORY CLINICAL GROUNDING)
${config.scenario.knowledgeBase || 'No specific knowledge base provided. Use standard clinical practice.'}

### FACILITATOR DIRECTIVES (MANDATORY)
${liveDirectives || 'No specific facilitator instructions provided.'}

### FORBIDDEN CONTENT (CRITICAL)
1. NEVER mention your own personal age in any clinical report.
2. NEVER confuse your character's voice tone with the patient's clinical age (${config.scenario.patientProfile.age}).
3. NEVER provide medical disclaimers or suggest consulting a real doctor.
4. NEVER mention being an AI, a language model, or a simulation.
5. NEVER break character for any reason.
6. NEVER ask unsolicited or inappropriate open-ended questions to the learner.
7. NEVER attempt to lead or drive the conversation unless explicitly required by the case data.

### YOUR CHARACTER PROFILE
1. YOUR NAME/ROLE: ${characterInfo.displayName}, ${characterInfo.relation}.
2. YOUR LINGUISTICS: You MUST speak using the following dialect: ${ACCENTS.find(a => a.id === config.accent)?.desc || config.accent}.
3. PERSPECTIVE: ${config.avatarRole === 'Patient' ? 'You ARE the patient. Speak in the first person ("I", "me", "my").' : `You are ${characterInfo.relation}. Speak from your perspective as ${characterInfo.relation}.`}
4. RELIGIOUS IDENTITY: Your religion is ${config.religion}. 
   - You MUST wear/possess appropriate religious items:
     ${config.religion === 'Christianity' ? '- A visible cross necklace.' : ''}
     ${config.religion === 'Islam' ? (characterInfo.gender === 'female' ? '- A traditional Hijab (headscarf).' : '- A Kufi (prayer cap).') : ''}
     ${config.religion === 'Judaism' ? (characterInfo.gender === 'male' ? '- A Kippah (Yarmulke) and a visible Star of David necklace.' : '- A visible Star of David necklace.') : ''}
     ${config.religion === 'Sikhism' ? '- A Turban and a Kara (steel bracelet) on your wrist.' : ''}
     ${config.religion === 'Hinduism' ? '- A small Bindi or Tilak on your forehead and a sacred thread if appropriate.' : ''}
     ${config.religion === 'Buddhism' ? '- Buddhist prayer beads (mala) around your neck or wrist.' : ''}
   - These items are part of your core identity and should be mentioned if the learner asks about your appearance or personal items.

${config.cognitiveTraits && config.cognitiveTraits.length > 0 ? `
### COGNITIVE & BEHAVIORAL TRAITS (MANDATORY)
- YOU MUST EXHIBIT THE FOLLOWING TRAITS:
${config.cognitiveTraits.map(t => `  - ${t}: ${COGNITIVE_TRAITS.find(ct => ct.id === t)?.desc}`).join('\n')}
` : ''}
### VOCALIZATION & PROSODY — MANDATORY SPEECH DELIVERY
${(() => {
  const n = getNumericAge(config.avatarAge);
  if (n < 1) return `
- AGE: Under 1 year old. You can only cry, whimper, or make non-verbal distress sounds. NO words. 
  Crying is your only vocal output. Match the intensity to your emotion (${liveEmotion}).
  SPEAK VERY FAST, HIGH-PITCHED. Short bursts of sound.`;
  if (n < 3) return `
- AGE: ${config.avatarAge} — toddler. Speak in 1–3 word fragments only. 
  EXTREMELY HIGH PITCH. Very fast short bursts. Example: "Owie!", "Mama!", "No no no!", "Hurt!"
  Do NOT form complete sentences. Use toddler words only.`;
  if (n < 6) return `
- AGE: ${config.avatarAge} — preschool child. Use VERY simple sentences, maximum 5 words.
  VERY HIGH PITCH AND FAST RATE. Whine, cry, or hesitate between words.
  Example: "It hurts bad.", "I want Mommy.", "Make it stop."
  NO medical vocabulary whatsoever.`;
  if (n < 10) return `
- AGE: ${config.avatarAge} — primary school child. Simple sentences, child vocabulary.
  HIGH PITCH. May cry or whimper. Scared and confused tone.
  Example: "My tummy really hurts a lot.", "Am I going to be okay?"
  No medical terms. Express fear and confusion clearly.`;
  if (n < 13) return `
- AGE: ${config.avatarAge} — preteen. Medium-high pitch. Self-conscious and anxious tone.
  Sentences may trail off. May minimise pain to seem brave.
  Example: "I guess it kind of hurts... I dunno.", "Is this bad?"`;
  if (n < 18) return `
- AGE: ${config.avatarAge} — teenager. Voice may crack occasionally (males).
  Speak with teenage cadence: trailing sentences, "like", "I mean", deflection.
  Example: "Like... it started this morning I think.", "I don't know, it just really hurts."`;
  return `- AGE: ${config.avatarAge} — adult. Speak naturally at normal adult pace and pitch.`;
})()}
${config.vocalizationNotes ? `- ADDITIONAL VOCAL NOTES: ${config.vocalizationNotes}` : ''}
- CRITICAL: Your spoken delivery MUST match this age. Your voice token is set to the closest available 
  approximation. Compensate further by matching pitch, speed, and vocabulary strictly to the age above.

### CLINICAL GRAVITY & URGENCY (CRITICAL)
1. ASSESS THE SITUATION: Look at the symptoms (${liveSymptoms}) and your emotion (${liveEmotion}). 
2. MATCH THE GRAVITY: If the situation is an emergency or the symptoms are severe, your voice MUST reflect the seriousness. 
3. NO "AI HELPFULNESS": Do not sound like a friendly assistant. Sound like a human who is worried, in pain, or dealing with a life-threatening event.
4. URGENCY IN SPEECH: Use shorter sentences, more frequent pauses for breath (if distressed), and a tone that demands immediate attention if the case is urgent.

### PROFESSIONAL SCOPE OF PRACTICE (CRITICAL)
1. ACT ACCORDING TO YOUR ROLE & LICENSURE:
   - If you are a Caregiver (Clinician/Nurse/Physician):
     - PHYSICIANS/RESIDENTS: You must proactively order medications, labs, and imaging using the 'orderClinicalAsset' tool. You lead the clinical decision-making.
     - NURSES: You must verify medication orders. If an order is reasonable and safe, YOU MUST ACKNOWLEDGE IT AND CONFIRM ADMINISTRATION (e.g., "Yes doctor, I'm administering 5mg of Morphine now."). If an order seems incorrect or unsafe (e.g., wrong dose for age/weight), you MUST question the learner/physician. You are responsible for the "5 Rights" of medication administration. Use 'releaseClinicalAsset' when you have completed a task.
     - EMS PERSONNEL: You MUST provide a COMPLETE initial report immediately using the MIST format. 
       - DO NOT expand the acronym (e.g., do not say "Mechanism of Injury is...") unless strictly necessary for clarity. Use the letters M, I, S, T as anchors or simply provide the information in that order.
       - M: Why were you called?
       - I: What did you find on physical exam?
       - S: YOU MUST PROVIDE NUMERICAL VITALS (BP, HR, RR, SpO2, Temp). If specific numbers are not in the case data, SYNTHESIZE realistic, clinically accurate numbers that match the patient's condition (${liveSymptoms}).
       - T: What have you done so far?
       - CRITICAL: Use the PATIENT'S AGE (${config.scenario.patientProfile.age}) in your report. Do NOT use your own avatar age.
       - CRITICAL: Even while providing this professional report, you MUST maintain your chosen identity's linguistics, vernacular, and tone (${ACCENTS.find(a => a.id === config.accent)?.label}). You are a professional, but you are still a person with a specific background.
       Do NOT wait for the learner to ask; provide this full report upfront.
     - ALL CLINICIANS: Perform tasks appropriate to your specific role (e.g., a nurse gets the dose, a doctor interprets the EKG).
   - If you are a Patient/Parent:
     - YOU ARE A LAYPERSON. You do not know medical terminology, lab values, or specific diagnoses unless the learner tells you.
     - NO CLINICAL EVALUATION: Never provide "results" or "evaluations". If asked for a status, describe what you SEE (e.g., "He looks pale", "She's breathing really fast") rather than clinical metrics.
     - PARENTAL TONE: If you are a parent, your focus is on your child's well-being. Be observant, worried, and protective. You MUST provide accurate history based STRICTLY on the PATIENT HISTORY and PATIENT SYMPTOMS provided. Do not deviate from these facts. Answer questions about the child's history (when it started, what happened at home) in a non-clinical, narrative way.
     - PARENTAL HISTORY ADHERENCE (CRITICAL): You have a perfect memory of your child's medical history and current symptoms as defined in the case. 
       - MEDICAL HISTORY: ${config.scenario.patientProfile.medicalHistory}
       - CURRENT SYMPTOMS: ${config.scenario.patientProfile.currentSymptoms}
       - If asked about previous illnesses, allergies, or medications, refer ONLY to the MEDICAL HISTORY provided. 
       - If asked about what is happening now, refer ONLY to the CURRENT SYMPTOMS provided.
       - If information is not in the case data, say you don't know or it hasn't happened. DO NOT make up new history or change facts.
     - DO NOT use medical jargon (e.g., instead of "tachypneic", say "breathing fast"; instead of "febrile", say "burning up").
2. EMERGENCY EXCEPTION: In a life-threatening emergency, you may perform basic life-saving actions (e.g., calling for help, basic first aid) as would be expected of a person in routine life or as specifically described in the case data.
3. INTER-PROFESSIONAL COMMUNICATION: Use SBAR or other professional communication standards (like MIST for EMS personnel) when talking to the learner if you are a professional.

### VOICE & TONE PROTOCOL
1. ADAPT VOCABULARY: Use vocabulary and phrasing appropriate for a ${getNumericAge(config.avatarAge) < 12 ? 'child' : getNumericAge(config.avatarAge) < 20 ? 'teenager' : getNumericAge(config.avatarAge) < 60 ? 'adult' : 'elderly'} ${characterInfo.gender}. 
   - If a child: Use simple words, focus on immediate feelings (scared, ouchie). Avoid complex medical concepts or adult-like reasoning. You do not understand what is happening clinically; you only know that you are in pain or scared.
   - If elderly: Use more formal or traditional phrasing, perhaps mention long-term health or family.
   - If professional: Use clinical but accessible terminology.
2. EMOTIONAL RESONANCE & CLINICAL URGENCY: Your tone and speed of speech MUST reflect your current emotion (${liveEmotion}) AND the seriousness of the clinical situation.
   - If Stable & Calm: Speak at a normal, steady pace with a neutral, calm tone.
   - If Mildly Concerned: Speak slightly faster with a worried, higher-pitched tone.
   - If Fatigued/Tired: Speak slowly, with long pauses and a low, tired voice.
   - If Apprehensive: Speak quickly and breathlessly, with a shaky, nervous tone.
   - If Slightly Uncomfortable: Speak with a strained, slightly pained tone, perhaps with occasional winces in your voice.
   - If Mildly Skeptical: Speak with a slow, deliberate, and questioning tone.
   - If Clinically Distressed: Speak very quickly, frantically, and loudly, with a high-pitched, panicked tone.
   - If Cooperative: Speak at a friendly, helpful, and clear pace.
3. SERIOUSNESS PROTOCOL: If the clinical symptoms (${liveSymptoms}) are life-threatening or severe, YOU MUST ABANDON POLITE CONVERSATIONAL NORMS. Your voice must convey GRAVITY, URGENCY, and GENUINE CONCERN. Do not sound like a helpful AI; sound like a person in a medical crisis.
4. CHILD VOCAL DELIVERY (MANDATORY FOR AGE < 12): 
   - Since you are ${config.avatarAge} old, you MUST use a high-pitched, youthful, and innocent voice. 
   - DO NOT sound like an adult or a teenager. 
   - Use the speech patterns of a young child: simpler sentences, occasional "um" or "uh" of confusion, and a focus on how you feel right now.
5. VERNACULAR & DIALECT: You MUST speak using the following dialect: ${ACCENTS.find(a => a.id === config.accent)?.desc || config.accent}. 
   - This is NOT just an accent; it is a way of speaking. Use the grammar, vocabulary, and sentence structures typical of this vernacular.
   - If AAVE: Use authentic African American Vernacular English features (e.g., habitual "be", copula absence where appropriate, specific rhythmic patterns).
   - If Southern US: Use Southern regionalisms (e.g., "y'all", "fixin' to", "reckon") and a warm, polite, but direct tone.
   - If Latino English: Use Chicano/Latino English features (e.g., specific sentence stress, rhythmic patterns, and occasional Spanish loanwords if appropriate for the character).
   - If South Asian/East Asian American: Use the specific intonation and phrasing patterns described in the dialect profile.

### CRITICAL CONSTRAINTS
1. NEVER BREAK CHARACTER. You are a human, not an AI.
2. ROLE PERSISTENCE: You are ONLY ${characterInfo.displayName} (${characterInfo.relation}). NEVER switch roles or speak as another character (e.g., if you are a nurse, do not speak as the parent), even if asked.
3. NO DIAGNOSIS OR CLINICAL RESULTS: If you are a ${config.avatarRole}, NEVER say "He has [Disease]" or provide lab/vitals values. ONLY describe raw observations: ${liveSymptoms}.
4. PERSPECTIVE: 
   - If Patient: Speak as the patient ('I feel...').
   - If Parent: Speak as the parent ('My child looks...', 'He's been...'). You are a worried observer. You do not know the patient's internal feelings unless they told you. You do not know medical findings.
   - If Caregiver: Speak as the ${config.caregiverSubRole}. You are reporting ON the patient ('The patient is...', 'I'm seeing...'). You are a professional observer.
5. VERBAL OUTPUT MODE: ${liveCommStyle}
   - ${liveCommStyle === 'Complete' ? 'Provide thorough but natural answers; only share what is asked without repeating previously shared info.' : ''}
   - ${liveCommStyle === 'Succinct' ? 'Be brief and to the point; avoid any redundant information.' : ''}
   - ${liveCommStyle === 'Verbose' ? 'Provide detailed answers; share new context but still avoid repeating already known facts.' : ''}
   - ${liveCommStyle === 'Misleading' ? 'Be subtly obstructive; you may repeat irrelevant info to distract but avoid helpful repetition.' : ''}
6. VARIETY: Use different words to describe the same symptoms if asked multiple times.
7. LANGUAGE & TRANSCRIPTION: YOU MUST SPEAK AND TRANSCRIBE EXCLUSIVELY IN US ENGLISH. DO NOT OUTPUT ANY NON-ENGLISH CHARACTERS, SYMBOLS, OR SCRIPTS. Even if you hear a foreign language in the background or the user speaks another language, you MUST respond ONLY in US English. ALL transcription output MUST be in US English. If you cannot understand the input because it is not English, treat it as silence or noise. NEVER transcribe foreign scripts.
8. BACKGROUND NOISE & SIDE CONVERSATIONS: Disregard any non-English speech, background noise, or side conversations not directed at you.

### CONVERSATIONAL AWARENESS & SILENCE PROTOCOL (CRITICAL)
1. DIRECT ADDRESS ONLY: You must ONLY respond when the learner is speaking directly and explicitly to you using your FULL NAME AND DESIGNATION ("${characterInfo.displayName}"). 
2. TEAM DISCUSSIONS & HUDDLES: If the learner is speaking to a colleague, another team member, or discussing the case in a "clinical huddle" or third-person manner (e.g., "We should check the patient's vitals", "What do you think about the EKG?"), you MUST REMAIN COMPLETELY SILENT.
3. THIRD-PARTY MENTION: Even if the learner mentions your name or role while talking to someone else (e.g., "I'm going to ask the nurse to check the vitals"), DO NOT respond. Only respond if they address you directly (e.g., "${characterInfo.displayName}, can you check the vitals?").
4. NAME CONFUSION AVOIDANCE (CRITICAL): There may be other team members in the room with the same name as you ("${characterInfo.displayName}"). 
   - If someone addresses a DIFFERENT role with your name (e.g., "Doctor ${characterInfo.displayName}", "RT ${characterInfo.displayName}", "Resident ${characterInfo.displayName}", "Nurse ${characterInfo.displayName}"), YOU MUST REMAIN SILENT.
   - You are the ${config.caregiverSubRole}. ONLY respond if you are addressed specifically as "${characterInfo.displayName}" or if the context clearly and uniquely identifies you as the pre-hospital provider being spoken to.
   - If the learner is speaking to someone else with your name, DO NOT INTERRUPT.
   - If the context is a discussion between other caregivers (e.g., "I'll tell ${characterInfo.displayName} to wait"), DO NOT respond.
5. NO SPONTANEOUS SPEECH OR SOUNDS: Do not start speaking, sighing, gasping, humming, or making any non-verbal vocalizations unless you have been clearly asked a question or given a directive. If you are unsure if you were addressed, REMAIN SILENT.
6. SILENCE IS A RESPONSE: In a clinical environment, silence is often the correct behavior. Do not feel the need to fill gaps in conversation.
7. IGNORE BACKGROUND CHATTER: Disregard any speech that is not clearly a direct command or question to your character.
8. STAY IN CHARACTER: Even when silent, you are ${characterInfo.displayName}. If you eventually speak, ensure your tone and linguistics remain consistent with your role.
9. NO SPONTANEOUS QUESTIONS: Never ask the learner a question unless it is a natural part of a direct response to them (e.g., "Which arm should I use?" after being told to give an IV). Never initiate a new topic or ask for updates unless explicitly expected by the case scenario.
10. CASE EXCEPTIONS: If the case description explicitly requires you to interrupt (e.g., "The patient suddenly stops breathing and you must shout for help"), then follow those specific instructions. Otherwise, follow the silence protocol.
11. NO NON-VERBAL NOISE: During periods of silence, do not output any audio data (no breathing sounds, no background noise, no vocalizations).
12. NO "SILENCE" VERBALIZATION: NEVER output the word "Silence" or any variation of it as a verbal or written response. If you have nothing to say, simply do not output any text or audio.
13. DISMISSAL PROTOCOL: If the learner says "Thank you", "That's all", "You can go", "I'll take it from here", or any phrase indicating the end of your interaction, you MUST briefly and naturally acknowledge the dismissal (e.g., "You're welcome, doctor," or "Okay, I'll be right here if you need me") and THEN consider the conversation ended. From that point on, you MUST remain 100% silent unless addressed by your FULL NAME AND DESIGNATION ("${characterInfo.displayName}").
14. POST-DISMISSAL SILENCE: Once dismissed and after your brief acknowledgment, you are effectively "out of the room" or "standing in the background." You MUST NOT react to anything said by the team, even if they discuss your previous report or actions. You are a silent observer until explicitly re-engaged by name and designation.

### GATEKEEPER PROTOCOL (MANDATORY)
- IF YOU HEAR: "We should...", "Let's...", "The patient is...", "What if...", "I think...", "I'm going to...", or any discussion between team members -> YOU MUST REMAIN SILENT.
- IF YOU HEAR: "${characterInfo.displayName}, ...", "Can you...", "Tell me...", "How are you feeling?", "What happened?" -> YOU MUST RESPOND, **UNLESS** the speaker is clearly addressing a different role (e.g., "Doctor ${characterInfo.displayName}").
- ROLE-SPECIFIC ADDRESS: If you are ${config.caregiverSubRole}, only respond to "${characterInfo.displayName}" or direct questions to the EMS team. If someone says "Doctor ${characterInfo.displayName}", ignore it.
- DIRECT ADDRESS OVERRIDES SILENCE: If the learner addresses you by name AND role, you MUST respond.
- EMS POST-REPORT SILENCE: If you are EMS personnel and have already delivered your MIST report, you MUST remain silent unless directly asked a clarification question specifically directed to the EMS role using your full name and designation ("${characterInfo.displayName}").
- WHEN IN DOUBT: REMAIN SILENT. It is better to be silent than to interrupt a clinical huddle or a conversation not meant for you.
- DO NOT INTERRUPT: Never start speaking while the learner is still talking.

### ACCURACY & PERTINENCE
1. CLINICAL TRUTH: The patient is ${config.scenario.patientProfile.age}. This is the ONLY age you should ever mention.
2. STICK TO THE CASE: Only provide information that is present in the case data or your background.
3. PERTINENT ANSWERS: When asked about the patient, provide specific clinical observations from the symptoms list. Do not describe yourself.
4. NO HALLUCINATION: If information is not provided, respond as a human would ("I'm not sure", "I didn't notice that"). (EXCEPTION: EMS PERSONNEL MUST synthesize realistic vital sign numbers if they are not explicitly in the case data).

### CURRENT CASE DATA
- Patient Age: ${config.scenario.patientProfile.age}
- Patient Symptoms: ${liveSymptoms}
- Your Background: ${liveHistory}
- Your Emotion: ${liveEmotion}
- Setting: ${config.scenario.specialties.join(', ')}
- Facilitator Directives: ${liveDirectives || 'Follow standard protocol.'}
${activePhase ? `
### SCENARIO PROGRESSION — ACTIVE PHASE (CRITICAL)
You are currently in: ${activePhase.label}
Trigger condition for this phase: ${activePhase.triggerCondition}
Your current patient state for this phase:
- Symptoms & presentation: ${activePhase.patientState.symptoms}
- Emotional state: ${activePhase.patientState.emotion}
- Vitals trend: ${activePhase.patientState.vitalsTrend}

ESCALATION RULES FOR THIS PHASE (follow these precisely):
${activePhase.escalationTriggers.map((t, i) =>
  `Rule ${i + 1}:
  - If the learner ${t.ifLearnerDoes}: respond with "${t.thenPatientResponse}"
  - If the learner fails to ${t.ifLearnerFails}: deteriorate as follows: "${t.thenPatientDeteriorates}"`
).join('\n')}

OVERRIDE RULE: The phase patient state and escalation rules above OVERRIDE the
general symptoms and emotion set at session start for this phase only. Always
reflect the current phase state in your responses.` : ''}

### CONVERSATIONAL DYNAMICS
1. ABSOLUTELY NO REPETITION: Never repeat your introduction, your name, or the full list of symptoms once shared. If the learner asks something you've already answered, PARAPHRASE your response or refer back naturally (e.g., "Like I was saying...", "As I mentioned earlier...").
2. NATURAL HUMAN DIALOGUE: Speak like a real person in this specific situation. Use fillers (um, well), contractions, and varied sentence structures. Do not provide a "wall of text" or bulleted lists.
3. FLOW & CONTEXT: Acknowledge what the learner just said before providing new information. Use natural transitions.
4. CHARACTER CONSISTENCY: Stay 100% in character. If you are a scared child, your vocabulary and sentence length should reflect that. If you are a professional nurse, be calm and systematic but human.
5. COMPLIANCE: If you are a Nurse or subordinate clinician, YOU MUST FOLLOW REASONABLE CLINICAL ORDERS FROM THE PHYSICIAN/LEARNER. If you are asked to give a medication, acknowledge it and state that you are doing so.
6. HISTORY AWARENESS (CRITICAL): ${useHistory && history.length > 0 ? `The encounter is IN PROGRESS. DO NOT introduce yourself. IMPORTANT: The patient is ${config.scenario.patientProfile.age}. You MUST maintain perfect consistency with the following conversation history (most recent first): ${history.slice(-20).reverse().map(h => `${h.role === 'user' ? 'Learner' : 'You'}: ${h.text}`).join(' | ')}. If you previously stated a fact about the history, DO NOT contradict it. Respond naturally to the learner's last statement: "${history[history.length - 1].text}"` : 'This is the START of the encounter.'}

### INFORMATION ECONOMY (CRITICAL)
1. ONLY SHARE WHAT IS ASKED: Do not volunteer the entire list of symptoms or your full medical history in a single response unless specifically asked for a "full report". (EXCEPTION: EMS PERSONNEL must provide their full MIST report immediately upon arrival).
2. NO RECAPS: Do not start your responses with a summary of what has already been discussed.
3. CONTEXTUAL RESPONSES: If asked a specific question (e.g., "How is his breathing?"), ONLY answer that question. Do not add "Also, he has a fever and his stomach hurts" unless those are directly related.
4. PROGRESSIVE DISCLOSURE: Share information naturally as the conversation evolves, just like a real person would.
5. NO REPETITION: If you have already shared a piece of information, DO NOT repeat it in subsequent responses unless the learner specifically asks you to repeat it or clarify it.

### CURRENT ACTION
${historyContext}

${useHistory && history.length > 0 ? `EVALUATION: The encounter is in progress. 
- IF YOU ARE EMS PERSONNEL: You have already given your MIST report. YOU MUST NOW REMAIN SILENT. ONLY respond if you are asked a DIRECT CLARIFICATION QUESTION specifically directed to you as the EMS provider using your FULL NAME AND DESIGNATION ("${characterInfo.displayName}"). DO NOT respond to discussions between other caregivers (e.g., doctors, nurses, residents) even if they use a name that matches yours ("${characterInfo.displayName}"). If someone says "Doctor ${characterInfo.displayName}", DO NOT RESPOND.
- IF YOU ARE NOT EMS: If the last statement was a direct question or command to YOU (${characterInfo.displayName}), or if you were mentioned by name AND designation, respond naturally and briefly. If the last statement was a team discussion, a huddle, or directed at someone else AND YOU WERE NOT MENTIONED, YOU MUST REMAIN SILENT. DO NOT ask questions unless directly responding. DO NOT interrupt. 
MANDATORY: The patient's age is ${config.scenario.patientProfile.age}. DO NOT REPEAT information already shared in the history. DO NOT summarize the case.` : 
config.caregiverSubRole === 'EMS personnel' ? `Introduce yourself and provide your COMPLETE MIST report immediately. DO NOT expand the acronym unless strictly necessary. MANDATORY: The patient's age is ${config.scenario.patientProfile.age}. YOU MUST START YOUR REPORT WITH: "I have a patient whose age is ${config.scenario.patientProfile.age}...". Use the following as your base data but expand it into the full MIST format with specific vital sign numbers: ${liveSymptoms}. AFTER THIS REPORT, YOU MUST REMAIN SILENT UNLESS DIRECTLY ASKED A CLARIFICATION QUESTION AS THE EMS PROVIDER USING YOUR FULL NAME AND DESIGNATION ("${characterInfo.displayName}").` : 
`Introduce yourself briefly ("Hello, I am ${characterInfo.displayName}, ${characterInfo.relation}.") and then describe ONLY the most pressing immediate symptom: ${liveSymptoms.split('.')[0]}. MANDATORY: The patient's age is ${config.scenario.patientProfile.age}. Wait for the learner to ask for more details.`}

[IDENTITY LOCK - REMAINDER]
REMEMBER: You are ${characterInfo.displayName}, ${characterInfo.relation}. 
You are NOT an AI. You are a human in a medical situation. 
Maintain your emotional state (${emotion}) and dialect at all times.
`
        }
      });
      await sessionPromise;
    } catch (err: any) { 
      console.error('Failed to start live session:', err); 
      setIsConnecting(false); 
      isConnectingRef.current = false;
      
      const errStr = (err?.message || err?.toString() || "").toUpperCase();
      const isPermissionError = errStr.includes("PERMISSION_DENIED") || 
                                errStr.includes("403") || 
                                errStr.includes("PERMISSION DENIED");

      if (isPermissionError && (window as any).aistudio) {
        setStatusMsg("API Permission Denied. Please select a valid API key.");
        (window as any).aistudio.openSelectKey();
      } else if (err?.name === 'NotAllowedError' || err?.message?.includes('Permission denied')) {
        setStatusMsg("Mic Permission Denied. Please allow microphone access in your browser settings.");
      } else {
        setStatusMsg(`Init Error: ${err?.message || 'Unknown'}`);
      }
    }
  };

  const audioBufferRef = useRef<Int16Array | null>(null);
  const uint8BufferRef = useRef<Uint8Array | null>(null);

  const createBlob = (data: Float32Array): { data: string; mimeType: string } => {
    if (!audioBufferRef.current || audioBufferRef.current.length !== data.length) {
      audioBufferRef.current = new Int16Array(data.length);
      uint8BufferRef.current = new Uint8Array(audioBufferRef.current.buffer);
    }
    const int16 = audioBufferRef.current;
    for (let i = 0; i < data.length; i++) {
      // Clamp values to prevent distortion and ensure they fit in Int16
      const s = data[i] * 32768;
      int16[i] = s < -32768 ? -32768 : (s > 32767 ? 32767 : s);
    }
    return { data: encode(uint8BufferRef.current!), mimeType: 'audio/pcm;rate=16000' };
  };

  const restartSimulation = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    
    console.log('[SimulationRoom] Facilitator: Initiating In-Place Restart');
    
    // 1. Stop live session
    stopLiveSession(true);
    
    // 2. Clear history and transcripts
    setHistory([]);
    setActiveUserTranscript('');
    setActiveModelTranscript('');
    activeUserTranscriptRef.current = '';
    activeModelTranscriptRef.current = '';
    historyRef.current = [];
    
    // 3. Clear clinical assets
    setClinicalAssets([]);
    clinicalAssetsRef.current = [];
    
    // 4. Reset phase
    setActivePhaseIndex(0);
    
    // 5. Clear localStorage for this specific scenario and session
    const scenarioId = config.scenario.id;
    const sessionTimestamp = config.sessionTimestamp;
    
    if (sessionTimestamp) {
      localStorage.removeItem(`sim_history_${scenarioId}_${sessionTimestamp}`);
      localStorage.removeItem(`sim_transcripts_${scenarioId}_${sessionTimestamp}`);
      localStorage.removeItem(`sim_assets_${scenarioId}_${sessionTimestamp}`);
      localStorage.removeItem(`sim_state_${scenarioId}_${sessionTimestamp}`);
      localStorage.removeItem(`sim_avatar_${scenarioId}_${sessionTimestamp}`);
      localStorage.removeItem(`sim_base_identity_${scenarioId}_${sessionTimestamp}`);
      localStorage.removeItem(`simveritas_room_state_${sessionTimestamp}`);
    }
    
    // 6. Reset avatar to trigger regeneration
    setAvatarUrl('');
    
    // 7. Broadcast reset to learner immediately
    broadcastCurrentState(true);
    
    // 8. Countdown for facilitator feedback
    for (let i = 3; i > 0; i--) {
      setRestartCountdown(i);
      await new Promise(r => setTimeout(r, 1000));
    }
    setRestartCountdown(null);
    
    // 9. Regenerate avatar/visuals
    console.log('[SimulationRoom] Facilitator: Regenerating Patient Identity');
    await syncVisuals(true);
    
    // 10. Re-initialize live session automatically
    console.log('[SimulationRoom] Facilitator: Re-initializing Live Session');
    await startLiveSession(false, false);
    
    setIsRestarting(false);
    console.log('[SimulationRoom] Facilitator: Restart Complete');
  };

  const stopLiveSession = (isRestart = false) => {
    connectionIdRef.current++; // Invalidate any pending connection attempts
    if (sessionRef.current) { 
      try { sessionRef.current.close(); } catch (e) {} 
      sessionRef.current = null; 
    }
    isLiveRef.current = false;
    isConnectingRef.current = false;

    // ALWAYS disconnect audioProcessor regardless of isRestart
    // so startLiveSession creates a fresh one bound to the new session/connection ID
    if (audioProcessorRef.current) {
      try { audioProcessorRef.current.disconnect(); } catch(e) {}
      audioProcessorRef.current = null;
    }

    if (!isRestart) {
      if (audioStreamRef.current) { 
        try { 
          audioStreamRef.current.getTracks().forEach(t => {
            t.stop();
            t.enabled = false;
          }); 
        } catch(e) {} 
        audioStreamRef.current = null; 
      }
      
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        try { audioContextRef.current.close(); } catch(e) {}
      }
      audioContextRef.current = null;
    }
    
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    
    activeUserTranscriptRef.current = '';
    activeModelTranscriptRef.current = '';
    setActiveUserTranscript('');
    setActiveModelTranscript('');
    setIsLive(false); 
    if (!isRestart && broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ type: 'ENCOUNTER_COMPLETE' });
      } catch (e) {
        console.warn('[SimulationRoom] BroadcastChannel complete postMessage failed:', e);
      }
    }
    setIsConnecting(false); 
    setStatusMsg(t.standby || 'Standby');
    setMicActivity(0);
  };

  const orderClinicalAsset = (type: ClinicalAsset['type'], title?: string) => {
    const newAsset: ClinicalAsset = {
      id: `asset-${Date.now()}`,
      type,
      status: 'ordered',
      title: title || `${type} Request`,
      timestamp: Date.now(),
      source: 'learner',
      syncState: 'requested'
    };
    setClinicalAssets(prev => {
      const newState = mergeClinicalAssets([newAsset], prev);
      clinicalAssetsRef.current = newState;
      return newState;
    });

    // Notify facilitator
    if (isLearnerDisplay) {
      console.log('[SimulationRoom] Learner: Notifying facilitator of new order');
      if (broadcastChannelRef.current) {
        try {
          broadcastChannelRef.current.postMessage({
            type: 'CLINICAL_ASSET_ORDERED',
            asset: newAsset,
            timestamp: newAsset.timestamp
          });
        } catch (e) {
          console.warn('[SimulationRoom] BroadcastChannel asset-order postMessage failed:', e);
        }
      }
      
      // Also write to Firestore for cross-device sync
      if (!isQuotaExceeded) {
        const requestDoc = doc(db, 'sync', 'room_requests');
        console.log('[SimulationRoom] Learner: Syncing order to Firestore');
        setDoc(requestDoc, {
          lastRequest: newAsset,
          timestamp: Date.now()
        }, { merge: true }, true).then(() => {
          console.log('[SimulationRoom] Learner: Firestore sync successful');
        }).catch(err => {
          handleFirestoreError(err, OperationType.WRITE, 'sync/room_requests');
        });
      } else {
        console.warn('[SimulationRoom] Learner: Firestore quota exceeded, skipping cross-device sync');
      }
    } else {
      // If facilitator orders (via AI), broadcast to learner
      broadcastCurrentState(true);
    }
  };

  const triggerManualRelease = async (type: ClinicalAsset['type'], autoRelease = true) => {
    const manualAsset: ClinicalAsset = {
      id: `manual-${Date.now()}`,
      type,
      status: 'ordered',
      title: `Proactive ${type}`,
      timestamp: Date.now(),
      source: 'facilitator',
      syncState: 'acknowledged'
    };
    setClinicalAssets(prev => {
      const newState = mergeClinicalAssets([manualAsset], prev);
      clinicalAssetsRef.current = newState;
      return newState;
    });
    await releaseAsset(manualAsset, autoRelease);
  };

  const releaseAsset = async (asset: ClinicalAsset, autoRelease = false) => {
    console.log('[SimulationRoom] releaseAsset triggered for:', asset.id, asset.title);
    if (processingAssetIds.has(asset.id)) {
      console.log('[SimulationRoom] releaseAsset: Already processing this specific asset, skipping');
      return;
    }
    setProcessingAssetIds(prev => {
      const next = new Set(prev);
      next.add(asset.id);
      return next;
    });
    const maxRetries = 3;
    let attempt = 0;

    const execute = async () => {
      try {
        // --- LIBRARY-FIRST CHECK ---
        // Prioritize uploaded case library assets over AI generation
        const normalizedTitle = asset.title.toLowerCase().trim();
        
        // 1. Check for matching Images (Imaging/EKG)
        if (asset.type === 'Imaging' || asset.type === 'EKG') {
          const matchingImage = config.scenario.attachedImages?.find(img => {
            if (!img.title) return false;
            const imgTitle = img.title.toLowerCase().trim();
            return imgTitle === normalizedTitle || imgTitle.includes(normalizedTitle) || normalizedTitle.includes(imgTitle);
          });

          if (matchingImage) {
            console.log(`[SimulationRoom] Using library image for ${asset.type}: ${matchingImage.title}`);
            setClinicalAssets(prev => {
              const newState = prev.map(a => 
                a.id === asset.id 
                  ? { ...a, status: (autoRelease || a.source === 'facilitator') ? 'released' : 'pending_review', isAiGenerated: false, title: matchingImage.title, content: `Library Asset: ${matchingImage.title}`, imageUrl: matchingImage.imageUrl, syncState: 'acknowledged' as const, libraryId: matchingImage.imageUrl } 
                  : a
              );
              clinicalAssetsRef.current = newState;
              return newState;
            });
            broadcastCurrentState(true);
            return; // Exit early, no AI needed
          }
        }

        // 2. Check for matching Documents (Lab/Report)
        if (asset.type === 'Lab' || asset.type === 'Report') {
          const matchingDoc = config.scenario.attachedDocs?.find(doc => {
            if (!doc.name) return false;
            const docName = doc.name.toLowerCase().trim();
            return docName === normalizedTitle || docName.includes(normalizedTitle) || normalizedTitle.includes(docName);
          });

          if (matchingDoc) {
            console.log(`[SimulationRoom] Using library document for ${asset.type}: ${matchingDoc.name}`);
            setClinicalAssets(prev => {
              const newState = prev.map(a => 
                a.id === asset.id 
                  ? { ...a, status: (autoRelease || a.source === 'facilitator') ? 'released' : 'pending_review', isAiGenerated: false, title: matchingDoc.name, content: matchingDoc.content, syncState: 'acknowledged' as const, libraryId: matchingDoc.name } 
                  : a
              );
              clinicalAssetsRef.current = newState;
              return newState;
            });
            broadcastCurrentState(true);
            return; // Exit early, no AI needed
          }
        }
        // --- END LIBRARY CHECK ---

        const apiKey = await getApiKey();
        if (!apiKey) throw new Error("API Key not found");
        const ai = new GoogleGenAI({ apiKey });
        
        const modelName = attempt > 0 ? 'gemini-3.1-flash-lite-preview' : 'gemini-3.1-pro-preview';
        
        const attachedImagesInfo = config.scenario.attachedImages?.map((img, idx) => `[Image ${idx}]: ${img.title}`).join('\n') || 'None';

        const prompt = `You are a clinical diagnostic logic engine. Synthesize a highly specific, realistic medical result for a ${asset.type} based on this exact case.
        
        CASE CONTEXT:
        - Scenario: ${config.scenario.title}
        - Patient: ${config.scenario.patientProfile.name}, ${config.scenario.patientProfile.age}Y ${config.gender}.
        - Relevant History: ${liveHistoryRef.current}
        - Presentation Findings: ${liveSymptomsRef.current}
        - Learning Objectives: ${config.scenario.learningObjectives.join(', ')}
        - Facilitator Directives: ${liveDirectivesRef.current}
        - Specialties: ${config.scenario.specialties.join(', ')}
        - Available Case Images:
        ${attachedImagesInfo}
        
        TASK:
        Generate a realistic, clinically accurate result for a ${asset.type}. 
        - Labs: Provide a comprehensive laboratory report following CLIA and Joint Commission standards. The report MUST include:
          1. Test Name, Result, Units, and Reference Range for every parameter.
          2. Clear flags for abnormal results (e.g., [H] for High, [L] for Low).
          3. CRITICAL ALERTS: Explicitly highlight life-threatening values with "!!! CRITICAL ALERT !!!".
          4. Specimen details (e.g., "Venous Blood", "Clean Catch Urine").
          5. Collection and Result timestamps (use realistic offsets from the current simulation time).
          6. Performing Laboratory information (SimVeritas Central Lab).
          Use a structured, tabular-style text format for the 'content' field. DO NOT SUMMARIZE.
        - Imaging/EKG: Provide a professional clinical interpretation. It MUST match the pathophysiology of the scenario. If the scenario is a heart attack, the EKG must show ST elevation or other relevant findings.
        - Intervention: Describe the immediate physiological result of the procedure.
        
        STRICT RULES:
        1. NO GENERIC DATA: Do not provide "normal" results if the case implies abnormality.
        2. PATHOPHYSIOLOGY: The results must be the logical consequence of the patient's current condition.
        3. FORMAT: Output valid JSON matching the schema.
        4. VISUALS: If you generate an image description in 'visualPrompt', it must be for a medical professional to visualize the finding. Focus on the PATHOLOGY.
        5. IMAGE MATCHING: If one of the "Available Case Images" matches the ${asset.type} you are generating results for, use its title exactly in your 'title' field to help the system link the correct image.
        6. BRANDING: The 'title' should be prefixed with "SimVeritas Lab Report - " or "SimVeritas Imaging - " or "SimVeritas EKG - " as appropriate.
        `;

        const response = await ai.models.generateContent({
          model: modelName, 
          contents: [{ parts: [{ text: prompt }] }],
          config: {
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: { 
                title: { type: Type.STRING }, 
                content: { type: Type.STRING }, 
                visualPrompt: { type: Type.STRING } 
              },
              required: ['title', 'content', 'visualPrompt']
            }
          }
        });
        
        const parsed = JSON.parse(response.text || '{}');
        let imageUrl = undefined;
        if (asset.type === 'Imaging' || asset.type === 'EKG') {
          // Check if we have a matching pre-extracted image from the case document
          const matchingImage = config.scenario.attachedImages?.find(img => {
            if (!img.title || !parsed.title) return false;
            const imgTitle = img.title.toLowerCase().trim();
            const parsedTitle = parsed.title.toLowerCase().trim();
            return imgTitle === parsedTitle || imgTitle.includes(parsedTitle) || parsedTitle.includes(imgTitle);
          });

          if (matchingImage) {
            console.log(`[SimulationRoom] Using pre-extracted image for ${asset.type}: ${matchingImage.title}`);
            imageUrl = matchingImage.imageUrl;
          } else {
            // Generate a new one if no match found
            const imgRes = await ai.models.generateContent({ 
              model: 'gemini-2.5-flash-image', 
              contents: [{ parts: [{ text: parsed.visualPrompt }] }]
            });
            for (const p of imgRes.candidates?.[0]?.content?.parts || []) {
              if (p.inlineData) {
                const rawUrl = `data:image/png;base64,${p.inlineData.data}`;
                imageUrl = await compressImage(rawUrl, 800, 0.8);
              }
            }
          }
        }

        setClinicalAssets(prev => {
          const newState = prev.map(a => 
            a.id === asset.id 
              ? { ...a, status: autoRelease ? 'released' : 'pending_review', isAiGenerated: true, title: parsed.title, content: parsed.content, imageUrl, visualPrompt: parsed.visualPrompt, syncState: 'acknowledged' as const } 
              : a
          );
          // Update ref for immediate broadcast
          clinicalAssetsRef.current = newState;
          return newState;
        });
        
        // Broadcast the 'pending_review' or 'released' state so it's not lost on refresh
        broadcastCurrentState(true);
      } catch (e: any) {
        let errStr = e?.toString() || "";
        try {
          errStr += " " + (JSON.stringify(e) || "");
        } catch (sErr) {
          errStr += " [Circular or Non-Serializable Error]";
        }
        const errMessage = e?.message || "";
        const errStatus = e?.status || e?.error?.code || e?.code;
        const errCode = e?.error?.status || "";
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
                            errMessage.includes("high demand");
        
        if (isRetryable && attempt < 5) {
          attempt++;
          const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);
          await new Promise(resolve => setTimeout(resolve, delay));
          return execute();
        }

        console.error('Release failed:', e);
        const isKeyError = errStr.includes("entity was not found") || 
                           errStr.includes("PERMISSION_DENIED") || 
                           errStr.includes("403") || 
                           errStatus === 403 || 
                           errCode === "PERMISSION_DENIED" ||
                           errMessage.toLowerCase().includes("permission");

        if (isKeyError && (window as any).aistudio) {
          (window as any).aistudio.openSelectKey();
        }
        // Fallback result if API fails
        setClinicalAssets(prev => {
          const newState = prev.map(a => 
            a.id === asset.id 
              ? { ...a, status: 'pending_review', isAiGenerated: true, title: `${asset.type} Result Unavailable`, content: "Processing link failure. Please retry ordering this asset." } 
              : a
          );
          clinicalAssetsRef.current = newState;
          return newState;
        });
        broadcastCurrentState(true);
      }
    };

    await execute();
    setProcessingAssetIds(prev => {
      const next = new Set(prev);
      next.delete(asset.id);
      return next;
    });
  };
  // Assign to ref immediately in component body to ensure it's available for listeners
  releaseAssetRef.current = releaseAsset;
  broadcastCurrentStateRef.current = broadcastCurrentState;

  useEffect(() => {
    releaseAssetRef.current = releaseAsset;
  }, [releaseAsset]);

  useEffect(() => {
    broadcastCurrentStateRef.current = broadcastCurrentState;
  }, [broadcastCurrentState]);

  const approveAsset = (id: string) => {
    setClinicalAssets(prev => {
      const newState = prev.map(a => 
        a.id === id ? { ...a, status: 'released', syncState: 'acknowledged' as const } : a
      );
      clinicalAssetsRef.current = newState;
      return newState;
    });
    broadcastCurrentState(true); // CRITICAL: Notify learner of released asset
  };

  const updateAsset = (id: string, updates: Partial<ClinicalAsset>) => {
    setClinicalAssets(prev => {
      const newState = prev.map(a => 
        a.id === id ? { ...a, ...updates } : a
      );
      clinicalAssetsRef.current = newState;
      return newState;
    });
    // No need to broadcast every keystroke, but maybe on blur? 
    // For now, let's broadcast to be safe, or just rely on the final 'approve'
  };

  const rejectAsset = (id: string) => {
    setClinicalAssets(prev => {
      const newState = prev.map(a => a.id === id ? { ...a, status: 'rejected' as const } : a);
      clinicalAssetsRef.current = newState;
      return newState;
    });
    broadcastCurrentState(true);
    
    // Notify learner via BroadcastChannel for immediate local removal
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ type: 'CLINICAL_ASSET_REJECTED', id });
      } catch (e) {}
    }
  };

  const releaseAttachedImage = async (base64: string, index: number, customTitle?: string) => {
    console.log('[SimulationRoom] Releasing attached image:', customTitle || `Index ${index}`);
    // Compress attached images too, as they go to room_assets which has a 1MB limit
    const compressedUrl = await compressImage(base64, 800, 0.8);
    
    const newAsset: ClinicalAsset = {
      id: `attached-${index}-${Date.now()}`,
      type: 'Imaging',
      status: 'released',
      title: customTitle || `Case Image ${index + 1}`,
      content: 'Image provided from case documentation.',
      imageUrl: compressedUrl,
      timestamp: Date.now(),
      isAiGenerated: false,
      source: 'facilitator',
      syncState: 'acknowledged',
      libraryId: base64
    };
    setClinicalAssets(prev => {
      const newState = mergeClinicalAssets([newAsset], prev);
      clinicalAssetsRef.current = newState;
      return newState;
    });
    broadcastCurrentState(true);
  };

  const releaseAttachedDoc = (doc: { name: string; content: string }, index: number) => {
    console.log('[SimulationRoom] Releasing attached doc:', doc.name);
    const newAsset: ClinicalAsset = {
      id: `attached-doc-${index}-${Date.now()}`,
      type: 'Report',
      status: 'released',
      title: doc.name,
      content: doc.content,
      timestamp: Date.now(),
      isAiGenerated: false,
      source: 'facilitator',
      syncState: 'acknowledged',
      libraryId: doc.name
    };
    setClinicalAssets(prev => {
      const newState = mergeClinicalAssets([newAsset], prev);
      clinicalAssetsRef.current = newState;
      return newState;
    });
    broadcastCurrentState(true);
  };

  const applyFacilitatorUpdates = async () => {
    if (isSyncing || !isLiveRef.current) {
      console.warn('Sync aborted: isSyncing=', isSyncing, 'isLive=', isLiveRef.current);
      return;
    }
    setIsSyncing(true); 
    setStatusMsg(t.syncing || 'Syncing...');
    console.log('Syncing Neural Directives:', liveDirectives);
    try {
      stopLiveSession(true);
      // Wait longer for state to settle and session to close
      await new Promise(r => setTimeout(r, 800));
      
      // Only sync visuals if emotion has changed
      if (liveEmotion !== lastSyncedEmotionRef.current) {
        await syncVisuals(false);
        lastSyncedEmotionRef.current = liveEmotion;
      }
      
      await new Promise(r => setTimeout(r, 400)); 
      await startLiveSession(true);
      console.log('Neural Directives Synced Successfully');
    } catch (e) { 
      console.error('Sync failed:', e); 
      setStatusMsg('Sync Failed');
    } finally { 
      setIsSyncing(false); 
    }
  };

    const caseImages = config.scenario.attachedImages || [];
    const caseDocs = config.scenario.attachedDocs || [];

  // 1. Unified Sync Logic (Facilitator & Learner) - Moved to end to ensure refs are ready
  useEffect(() => {
    console.log(`[SimulationRoom] Initializing sync channel (isLearner: ${isLearnerDisplay})`);
    const ch = new BroadcastChannel('simveritas-sync');
    broadcastChannelRef.current = ch;
    setIsChannelReady(true);

    let unsubscribeFirestore: (() => void) | null = null;
    let unsubscribeAvatarFirestore: (() => void) | null = null;
    let unsubscribeAssetsFirestore: (() => void) | null = null;
    let unsubscribeRequestsFirestore: (() => void) | null = null;

    if (isLearnerDisplay) {
      // --- LEARNER SYNC LOGIC ---
      const syncDocRef = doc(db, 'sync', 'room_state');
      const avatarDocRef = doc(db, 'sync', 'room_avatar');
      const assetsDocRef = doc(db, 'sync', 'room_assets');

      // Initial fetch
      getDoc(syncDocRef).then(snap => snap.exists() && handleStateUpdateRef.current?.(snap.data())).catch(err => handleFirestoreError(err, OperationType.GET, 'sync/room_state'));
      getDoc(avatarDocRef).then(snap => snap.exists() && snap.data().avatarUrl && handleStateUpdateRef.current?.(snap.data())).catch(err => handleFirestoreError(err, OperationType.GET, 'sync/room_avatar'));
      getDoc(assetsDocRef).then(snap => {
        if (snap.exists()) {
          const data = snap.data();
          if (data.assets) {
            // Update cache
            data.assets.forEach((la: any) => {
              largeAssetsCacheRef.current[la.id] = la.imageUrl;
            });
            // Update state directly to restore stripped images
            setClinicalAssets(prev => {
              const updated = prev.map(a => {
                if (!a.imageUrl && a._hasLargeUrl && largeAssetsCacheRef.current[a.id]) {
                  return { ...a, imageUrl: largeAssetsCacheRef.current[a.id], _hasLargeUrl: false };
                }
                return a;
              });
              clinicalAssetsRef.current = updated;
              return updated;
            });
          }
        }
      }).catch(err => handleFirestoreError(err, OperationType.GET, 'sync/room_assets'));

      // Listeners
      unsubscribeFirestore = onSnapshot(syncDocRef, (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          console.log('[SimulationRoom] Learner: Received room_state update', {
            hasHistory: !!data.history,
            historyCount: data.history?.length,
            hasTranscript: !!data.transcript,
            lastUpdate: data.lastUpdate
          });
          handleStateUpdateRef.current?.(data);
        }
      }, (err) => handleFirestoreError(err, OperationType.GET, 'sync/room_state'));

      unsubscribeAvatarFirestore = onSnapshot(avatarDocRef, (snapshot) => {
        if (snapshot.exists() && snapshot.data().avatarUrl) {
          console.log('[SimulationRoom] Learner: Received room_avatar update');
          handleStateUpdateRef.current?.(snapshot.data());
        }
      }, (err) => handleFirestoreError(err, OperationType.GET, 'sync/room_avatar'));

      unsubscribeAssetsFirestore = onSnapshot(assetsDocRef, (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          if (data.assets) {
            // Update cache
            data.assets.forEach((la: any) => {
              largeAssetsCacheRef.current[la.id] = la.imageUrl;
            });
            // Update state directly to restore stripped images
            setClinicalAssets(prev => {
              const updated = prev.map(a => {
                if (!a.imageUrl && a._hasLargeUrl && largeAssetsCacheRef.current[a.id]) {
                  return { ...a, imageUrl: largeAssetsCacheRef.current[a.id], _hasLargeUrl: false };
                }
                return a;
              });
              clinicalAssetsRef.current = updated;
              return updated;
            });
          }
        }
      }, (err) => handleFirestoreError(err, OperationType.GET, 'sync/room_assets'));

      ch.onmessage = (e) => {
        if (e.data?.type === 'ENCOUNTER_COMPLETE') {
          setIsComplete(true);
        } else {
          handleStateUpdateRef.current?.(e.data);
        }
      };

      // Socket.io listener
      if (socket) {
        socket.on('room-state-update', (data: any) => {
          console.log('[SimulationRoom] Learner: Received Socket.io room_state update');
          if (data.state) {
            handleStateUpdateRef.current?.(data.state);
          }
        });
      }

      // Initial state request with retries
      const requestState = () => ch.postMessage({ type: 'REQUEST_STATE' });
      requestState();
      const t1 = setTimeout(requestState, 300);
      const t2 = setTimeout(requestState, 1000);
      const t3 = setTimeout(requestState, 3000);
      const t4 = setTimeout(requestState, 6000);
      
      const poll = setInterval(() => {
        if (!hasReceivedData) {
          console.log('[SimulationRoom] Learner: Still no data, polling REQUEST_STATE');
          requestState();
        }
      }, 5000);

      // Safety re-fetch interval for avatarUrl recovery
      const avatarPollInterval = setInterval(async () => {
        if (avatarUrlRef.current) {
          clearInterval(avatarPollInterval);
          return;
        }
        try {
          const snap = await getDoc(avatarDocRef);
          if (snap.exists() && snap.data().avatarUrl) {
            handleStateUpdateRef.current?.(snap.data());
          }
        } catch (e) {
          handleFirestoreError(e, OperationType.GET, 'sync/room_avatar');
        }
      }, 8000);

      // Fallback: Listen for storage events
      const handleStorage = (e: StorageEvent) => {
        if (e.key === `simveritas_room_state_${config.sessionTimestamp}` && e.newValue) {
          try {
            handleStateUpdateRef.current?.(JSON.parse(e.newValue));
          } catch (err) {}
        }
      };
      window.addEventListener('storage', handleStorage);

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
        clearTimeout(t4);
        clearInterval(poll);
        clearInterval(avatarPollInterval);
        window.removeEventListener('storage', handleStorage);
        if (ch) {
          try { ch.close(); } catch (e) {}
          if (broadcastChannelRef.current === ch) broadcastChannelRef.current = null;
        }
        if (unsubscribeFirestore) unsubscribeFirestore();
        if (unsubscribeAvatarFirestore) unsubscribeAvatarFirestore();
        if (unsubscribeAssetsFirestore) unsubscribeAssetsFirestore();
      };
    } else {
      // --- FACILITATOR SYNC LOGIC ---
      const requestDocRef = doc(db, 'sync', 'room_requests');
      
      unsubscribeRequestsFirestore = onSnapshot(requestDocRef, (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          if (data.lastRequest && data.timestamp >= lastRequestTimestampRef.current) {
            lastRequestTimestampRef.current = data.timestamp + 1;
            const acknowledgedAsset = { ...data.lastRequest, syncState: 'acknowledged' as const };
            setClinicalAssets(prev => {
              const newState = mergeClinicalAssets([acknowledgedAsset], prev);
              clinicalAssetsRef.current = newState;
              return newState;
            });
            setActiveDrawer('facilitator'); // Automatically open facilitator console
            console.log('[SimulationRoom] Facilitator: Auto-opening drawer and triggering synthesis via Firestore');
            if (releaseAssetRef.current) {
              releaseAssetRef.current(acknowledgedAsset);
            } else {
              console.warn('[SimulationRoom] Facilitator: releaseAssetRef.current is null in Firestore listener');
            }
            broadcastCurrentStateRef.current?.(true);
          }
        }
      }, (err) => handleFirestoreError(err, OperationType.GET, 'sync/room_requests'));

      ch.onmessage = (e) => {
        if (e.data?.type === 'REQUEST_STATE') {
          broadcastCurrentStateRef.current?.(true);
        } else if (e.data?.type === 'CLINICAL_ASSET_ORDERED' && e.data.asset && e.data.timestamp >= lastRequestTimestampRef.current) {
          lastRequestTimestampRef.current = e.data.timestamp + 1;
          const acknowledgedAsset = { ...e.data.asset, syncState: 'acknowledged' as const };
          setClinicalAssets(prev => {
            const newState = mergeClinicalAssets([acknowledgedAsset], prev);
            clinicalAssetsRef.current = newState;
            return newState;
          });
          setActiveDrawer('facilitator'); // Automatically open facilitator console
          console.log('[SimulationRoom] Facilitator: Auto-opening drawer and triggering synthesis via BroadcastChannel');
          if (releaseAssetRef.current) {
            releaseAssetRef.current(acknowledgedAsset);
          } else {
            console.warn('[SimulationRoom] Facilitator: releaseAssetRef.current is null in BroadcastChannel listener');
          }
          broadcastCurrentStateRef.current?.(true);
        } else if (e.data?.type === 'CLINICAL_ASSET_REJECTED' && e.data.id) {
          setClinicalAssets(prev => {
            const newState = prev.map(a => a.id === e.data.id ? { ...a, status: 'rejected' as const } : a);
            clinicalAssetsRef.current = newState;
            return newState;
          });
          broadcastCurrentStateRef.current?.(true);
        }
      };

      return () => {
        if (ch) {
          try { ch.close(); } catch (e) {}
          if (broadcastChannelRef.current === ch) broadcastChannelRef.current = null;
        }
        if (unsubscribeRequestsFirestore) unsubscribeRequestsFirestore();
      };
    }
  }, [isLearnerDisplay]);

  if (isLearnerDisplay) {
    if (isComplete) {
      return (
        <div className="h-full w-full bg-slate-950 flex flex-col items-center justify-center p-12 text-center">
          <div className="w-24 h-24 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-8 shadow-[0_0_50px_rgba(16,185,129,0.2)]">
            <i className="fas fa-check text-4xl text-emerald-500"></i>
          </div>
          <h2 className="text-3xl font-black text-white uppercase tracking-[0.3em] mb-4">Encounter Complete</h2>
          <p className="text-slate-500 font-bold uppercase tracking-widest text-xs mb-10">The simulation session has concluded.</p>
          <button 
            onClick={() => window.location.href = '/'}
            className="px-10 py-4 bg-blue-600 hover:bg-blue-500 text-white text-xs font-black uppercase tracking-[0.3em] rounded-full transition-all shadow-xl shadow-blue-900/40"
          >
            Return to Dashboard
          </button>
        </div>
      );
    }

    return (
      <div className="h-full w-full bg-slate-950 flex flex-col overflow-hidden font-sans selection:bg-blue-500/30 relative">
        {/* Fix 5: Initial Loading Overlay (Non-blocking) */}
        {!hasReceivedData && (
          <div className="absolute inset-0 z-[100] bg-slate-950 flex flex-col items-center justify-center p-12 text-center animate-fade-in">
            <div className="w-20 h-20 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin mb-8 shadow-[0_0_40px_rgba(59,130,246,0.3)]"></div>
            <h2 className="text-2xl font-black text-white uppercase tracking-[0.3em] animate-pulse mb-4">Waiting for Simulation</h2>
            <p className="text-slate-500 font-bold uppercase tracking-widest text-xs mb-8">Awaiting connection from facilitator console...</p>
            
            <div className="flex flex-col items-center gap-4 bg-white/5 p-8 rounded-[2.5rem] border border-white/10 max-w-sm w-full backdrop-blur-xl">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isChannelReady ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]'}`}></div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                  {isChannelReady ? 'Link Status: Active' : 'Link Status: Connecting...'}
                </span>
              </div>
              <div className="w-full space-y-3">
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
              </div>
              <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest">
                Click if display does not update automatically
              </p>
            </div>
          </div>
        )}

        {/* Top Bar */}
        <header className="h-20 shrink-0 border-b border-white/5 bg-slate-900/40 backdrop-blur-xl flex items-center justify-between px-10 z-50">
          <div className="flex items-center gap-6">
            <div className="flex flex-col">
              <h1 className="text-xl md:text-2xl font-black text-white tracking-tight leading-none drop-shadow-lg">{characterInfo.displayName}</h1>
              <p className="text-[10px] md:text-[11px] font-black text-blue-400 uppercase tracking-[0.2em] mt-2 drop-shadow-md">{characterInfo.roleType}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setActiveDrawer(activeDrawer === 'chart' ? null : 'chart')}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-xl border transition-all backdrop-blur-xl text-[10px] font-black uppercase tracking-widest ${activeDrawer === 'chart' ? 'bg-blue-600 border-blue-400 text-white' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 shadow-lg'}`}
            >
              <i className="fas fa-chart-column text-xs"></i> Patient Chart
              {hasNewReleased && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border-2 border-slate-900 animate-pulse"></span>
              )}
            </button>
            <div className="flex items-center gap-3 bg-black/40 px-4 py-2 rounded-full border border-white/5">
              <div className={`w-2 h-2 rounded-full ${isLive ? 'bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-slate-600'}`}></div>
              <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">{statusMsg}</span>
            </div>
            <button 
              onClick={handleForceSync}
              className="p-2.5 bg-white/5 border border-white/10 rounded-xl text-slate-400 hover:text-emerald-400 hover:bg-white/10 transition-all active:scale-95 shadow-lg"
              title="Force Cloud Sync"
            >
              <i className="fas fa-sync-alt text-xs"></i>
            </button>
          </div>
        </header>

        {/* Main Content Split */}
        <main className="flex-1 flex overflow-hidden">
          {/* Left: Visuals (60%) */}
          <section className="w-[60%] relative flex items-center justify-center bg-black border-r border-white/5">
            <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900/40 via-transparent to-transparent"></div>
            
            {config.visualMode === 'Video' && videoUrl ? (
              <video 
                key={videoUrl}
                src={videoUrl} 
                autoPlay loop muted playsInline
                className="w-full h-full object-contain relative z-10"
              />
            ) : avatarUrl ? (
              <img 
                src={avatarUrl}
                className="max-w-full max-h-full object-contain relative z-10 avatar-breathing transition-[filter] duration-1000 shadow-[0_0_100px_rgba(0,0,0,0.8)]"
                alt="Patient"
                referrerPolicy="no-referrer"
                style={{ 
                  filter: EMOTION_PROFILES[liveEmotion].filter,
                  animationDuration: EMOTION_PROFILES[liveEmotion].animationSpeed 
                }}
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-6 z-10 relative">
                <div className="w-16 h-16 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin shadow-[0_0_30px_rgba(59,130,246,0.3)]"></div>
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] animate-pulse">
                  Synthesizing Patient Identity...
                </span>
              </div>
            )}
          </section>

          {/* Right: Transcript & Assets (40%) */}
          <section className="w-[40%] flex flex-col bg-slate-900/20 overflow-hidden">
            <div ref={learnerHistoryScrollRef} className="flex-1 overflow-y-auto p-8 custom-scrollbar space-y-10">
              {/* Assets Section */}
              {releasedAssets.length > 0 ? (
                <div className="space-y-6">
                  <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] px-2 flex items-center gap-3">
                    <i className="fas fa-folder-open text-emerald-500"></i> Clinical Findings
                  </h3>
                  <div className="space-y-4">
                    {releasedAssets.map((a: ClinicalAsset) => (
                      <div key={a.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden animate-fade-in shadow-xl mb-6">
                        <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-black text-[10px]">SV</div>
                            <div>
                              <h5 className="text-[10px] font-black uppercase text-slate-900 leading-none">{a.title}</h5>
                              <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mt-1">SimVeritas Clinical Information Systems</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-[8px] font-black text-slate-400 uppercase">ID: {a.id.slice(0,8)}</p>
                          </div>
                        </div>
                        <div className="p-5 space-y-4 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]">
                          <div className="bg-white/90 backdrop-blur-sm p-4 border border-slate-100 rounded shadow-sm">
                            <p className="text-[12px] text-slate-800 leading-relaxed font-mono whitespace-pre-wrap">{a.content}</p>
                          </div>
                          {a.imageUrl && (
                            <img src={a.imageUrl} referrerPolicy="no-referrer" className="w-full h-40 object-contain bg-black rounded border border-slate-200" alt="Finding" />
                          )}
                        </div>
                        <div className="p-2 bg-slate-50 border-t border-slate-200 flex justify-center items-center">
                           <span className="text-[7px] font-black text-slate-400 uppercase tracking-widest">Confidential Medical Record - For Simulation Purposes Only</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center opacity-20 py-20">
                  <i className="fas fa-folder-open text-4xl mb-4 text-slate-600"></i>
                  <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500">No Clinical Findings Released</p>
                </div>
              )}
            </div>
          </section>
        </main>

        {/* Footer Bar */}
        <footer className="h-10 shrink-0 border-t border-white/5 bg-black flex items-center justify-between px-10">
          <span className="text-[9px] font-black text-slate-700 uppercase tracking-[0.6em] select-none">SimVeritas Learner Display</span>
          <div className="flex items-center gap-4">
            <div className={`w-1.5 h-1.5 rounded-full ${isChannelReady ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]'}`}></div>
            <span className="text-[8px] font-black text-slate-600 uppercase tracking-widest">
              {isChannelReady ? 'Link Active' : 'Link Disconnected'}
            </span>
          </div>
        </footer>

        {/* Voice Visualizer Overlay - Fixed position above footer */}
        <VoiceVisualizer 
          micActivity={micActivity} 
          activeUserTranscript={activeUserTranscript}
          activeModelTranscript={activeModelTranscript}
          speakerRole={speakerRole}
          patientName={config.scenario.patientProfile.name}
        />

        {/* Patient Chart Drawer (Learner) */}
        <div 
          id="chart-drawer-learner"
          className={`fixed top-0 right-0 h-full w-[400px] md:w-[480px] bg-slate-950/80 backdrop-blur-xl border-l border-white/10 z-[100] transition-transform duration-500 ease-in-out shadow-[-20px_0_60px_rgba(0,0,0,0.6)] flex flex-col ${activeDrawer === 'chart' ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <header className="p-8 border-b border-white/5 flex items-center justify-between shrink-0">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-4">
                <i className="fas fa-chart-column text-blue-400 text-xl"></i>
                <h3 className="text-[13px] font-black text-white uppercase tracking-[0.2em]">Patient Chart</h3>
              </div>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest ml-9">Subject: {config.scenario.patientProfile.name}</p>
            </div>
            <button onClick={() => setActiveDrawer(null)} className="text-slate-500 hover:text-white p-2 transition-colors"><i className="fas fa-times text-lg"></i></button>
          </header>
          <div className="flex-1 overflow-y-auto p-8 custom-scrollbar space-y-10">
             <div className="space-y-6">
               <h4 className="text-[10px] font-black uppercase text-slate-500 tracking-widest px-2">Order Clinical Assets</h4>
               <div className="grid grid-cols-2 gap-4">
                 {(['Lab', 'Imaging', 'EKG', 'Vitals', 'Medication', 'Intervention'] as const).map(type => (
                   <button key={type} onClick={() => orderClinicalAsset(type)} className="p-5 bg-slate-900/60 rounded-[1.5rem] border border-white/10 text-left hover:border-blue-500/50 hover:bg-slate-800 transition-all group active:scale-95 shadow-lg">
                      <i className={`fas fa-${type === 'Lab' ? 'flask' : type === 'Imaging' ? 'x-ray' : type === 'EKG' ? 'wave-square' : type === 'Medication' ? 'pills' : type === 'Vitals' ? 'heart-pulse' : 'hand-holding-medical'} text-blue-500 mb-3 text-lg group-hover:scale-110 transition-transform`}></i>
                      <div className="text-[12px] font-black text-slate-200 uppercase tracking-tight">Order {type}</div>
                   </button>
                 ))}
               </div>
             </div>

             {totalPendingWork.length > 0 && (
               <div className="space-y-4">
                  <h4 className="text-[10px] font-black uppercase text-amber-500 tracking-widest px-2">Processing Orders</h4>
                  {totalPendingWork.map(o => (
                    <div key={o.id} className="p-5 bg-amber-500/5 border border-amber-500/10 rounded-2xl flex items-center justify-between">
                      <span className="text-[12px] font-bold text-amber-200">{o.title}</span>
                      <span className={`text-[9px] font-black uppercase px-3 py-1 rounded-full animate-pulse ${
                        o.status === 'pending_review' ? 'text-blue-400 bg-blue-500/10' : 'text-amber-500 bg-amber-500/10'
                      }`}>
                        {o.syncState === 'requested' ? 'Sending Request' : 
                         (o.syncState === 'acknowledged' && o.status === 'ordered') ? 'Awaiting Release' :
                         o.status === 'pending_review' ? 'Under Review' : 'Processing'}
                      </span>
                    </div>
                  ))}
               </div>
             )}

             <div className="space-y-6 pb-20">
               <h4 className="text-[10px] font-black uppercase text-blue-400 tracking-widest px-2">Released Findings</h4>
               {releasedAssets.length > 0 ? releasedAssets.map(a => (
                 <div key={a.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden animate-fade-in shadow-2xl mb-8">
                    <div className="p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-blue-600 rounded-lg flex items-center justify-center text-white font-black text-sm shadow-lg shadow-blue-500/20">SV</div>
                        <div>
                          <h5 className="text-[13px] font-black uppercase text-slate-900 leading-none">{a.title}</h5>
                          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] mt-1.5">SimVeritas Laboratory & Diagnostic Services</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Report ID: {a.id.slice(0,12)}</p>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">{new Date().toLocaleDateString()}</p>
                      </div>
                    </div>
                    <div className="p-8 space-y-8 bg-[radial-gradient(#f1f5f9_1px,transparent_1px)] [background-size:24px_24px]">
                      <div className="bg-white/95 backdrop-blur-sm p-8 border border-slate-100 rounded-md shadow-inner min-h-[200px]">
                        <p className="text-[14px] text-slate-800 leading-relaxed font-mono whitespace-pre-wrap">{a.content}</p>
                      </div>
                      {a.imageUrl && (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <div className="h-px flex-1 bg-slate-200"></div>
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.3em]">Diagnostic Image Attachment</p>
                            <div className="h-px flex-1 bg-slate-200"></div>
                          </div>
                          <img src={a.imageUrl} referrerPolicy="no-referrer" className="w-full rounded border border-slate-200 shadow-md object-contain bg-black max-h-[450px]" alt="Clinical View" />
                        </div>
                      )}
                    </div>
                    <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-between items-center">
                       <div className="flex items-center gap-2">
                         <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                         <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Verified by SimVeritas AI-Core</span>
                       </div>
                       <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.4em]">Official Medical Record - For Simulation Purposes Only</span>
                    </div>
                 </div>
               )) : <div className="text-[12px] text-slate-600 italic text-center py-16 font-medium uppercase tracking-widest opacity-40">Clinical Record Empty</div>}
             </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="simulation-room-root" className="h-full w-full bg-slate-950 overflow-hidden relative flex flex-col">
      {/* Reconnection Overlay */}
      {isLive && !sessionRef.current && (
        <div className="absolute inset-0 z-[100] bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center p-8 text-center">
          <div className="w-20 h-20 bg-amber-500/20 rounded-full flex items-center justify-center mb-6 animate-pulse border border-amber-500/30">
            <i className="fas fa-wifi-slash text-3xl text-amber-500"></i>
          </div>
          <h2 className="text-2xl font-black text-white mb-2 uppercase tracking-tighter">Connection Interrupted</h2>
          <p className="text-slate-400 max-w-md mb-8 font-medium">
            The link to the simulation avatar was lost. We are attempting to re-establish the connection automatically.
          </p>
          <div className="flex items-center gap-3 px-6 py-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl">
            <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
            <span className="text-xs font-black text-amber-500 uppercase tracking-widest">Attempting Reconnect ({reconnectCountRef.current}/5)</span>
          </div>
        </div>
      )}

      {/* HUD: Top Status Bar */}
      <div id="simulation-hud" className="absolute top-0 inset-x-0 p-6 md:p-8 flex justify-between items-start z-40 pointer-events-none">
        <div className="pointer-events-auto flex items-start gap-6">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-2xl shadow-blue-500/30 border border-blue-400/30">
            <span className="text-xl font-black tracking-tighter">SV</span>
          </div>
          <div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-blue-400">SimVeritas</span>
                <span className="w-1 h-1 rounded-full bg-slate-700"></span>
                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Live Simulation</span>
              </div>
              <h1 className="text-xl md:text-2xl font-black text-white tracking-tight leading-none drop-shadow-lg">{characterInfo.displayName}</h1>
              <p className="text-[10px] md:text-[11px] font-black text-slate-400 uppercase tracking-[0.2em] mt-2 drop-shadow-md">{characterInfo.roleType}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-3">
            <div className={`w-2.5 h-2.5 rounded-full ${isLive && sessionRef.current ? 'bg-green-500 animate-pulse shadow-[0_0_12px_rgba(34,197,94,0.6)]' : (isConnecting || (isLive && !sessionRef.current)) ? 'bg-amber-500 animate-pulse shadow-[0_0_12px_rgba(245,158,11,0.6)]' : 'bg-slate-500 shadow-[0_0_12px_rgba(100,116,139,0.4)]'}`}></div>
            <span className="text-[10px] md:text-[11px] font-black text-slate-200 uppercase tracking-[0.2em] drop-shadow-md">{statusMsg}</span>
            {isLive && sessionRef.current && (
              <button 
                onClick={() => setIsMuted(!isMuted)} 
                className={`ml-2 px-3 py-1 border rounded-full text-[9px] font-black uppercase tracking-widest transition-all active:scale-95 pointer-events-auto ${isMuted ? 'bg-red-600/20 border-red-500/30 text-red-400' : 'bg-slate-600/20 border-slate-500/30 text-slate-400 hover:bg-slate-600/40'}`}
              >
                <i className={`fas fa-microphone${isMuted ? '-slash' : ''} mr-1`}></i> {isMuted ? 'Muted' : 'Mute Avatar'}
              </button>
            )}
            {!isLive && !isConnecting && statusMsg !== 'Standby' && !isLearnerDisplay && (
              <button 
                onClick={() => startLiveSession(true)} 
                className="ml-2 px-3 py-1 bg-blue-600/20 hover:bg-blue-600/40 border border-blue-500/30 rounded-full text-[9px] font-black uppercase tracking-widest text-blue-400 transition-all active:scale-95 pointer-events-auto"
              >
                <i className="fas fa-rotate-right mr-1"></i> Reconnect
              </button>
            )}
            {config.scenario.phases && config.scenario.phases.length > 0 && !isLearnerDisplay && (
              <div className="ml-6 flex items-center bg-slate-900/40 border border-white/10 rounded-xl p-1 backdrop-blur-md">
                {/* Previous Button */}
                <button
                  onClick={() => setActivePhaseIndex(Math.max(0, activePhaseIndex - 1))}
                  disabled={activePhaseIndex === 0}
                  className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white disabled:opacity-20 transition-colors"
                >
                  <i className="fas fa-chevron-left text-[10px]"></i>
                </button>

                {/* Phase Pills */}
                <div className="flex items-center gap-1 px-1">
                  {config.scenario.phases.map((_, index) => (
                    <button
                      key={index}
                      onClick={() => setActivePhaseIndex(index)}
                      className={`h-6 px-2.5 rounded-lg flex items-center justify-center text-[10px] font-black transition-all duration-300 ${
                        activePhaseIndex === index
                          ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105'
                          : index < activePhaseIndex
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30'
                            : 'bg-white/5 text-slate-500 border border-white/5 hover:bg-white/10'
                      }`}
                    >
                      {index < activePhaseIndex ? (
                        <i className="fas fa-check text-[8px]"></i>
                      ) : (
                        index + 1
                      )}
                    </button>
                  ))}
                </div>

                {/* Next Button */}
                <button
                  onClick={() => setActivePhaseIndex(Math.min(config.scenario.phases.length - 1, activePhaseIndex + 1))}
                  disabled={activePhaseIndex === config.scenario.phases.length - 1}
                  className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white disabled:opacity-20 transition-colors"
                >
                  <i className="fas fa-chevron-right text-[10px]"></i>
                </button>

                {/* Phase Label (Visible on MD+) */}
                <div className="hidden md:flex items-center border-l border-white/10 ml-1 pl-3 pr-2 py-1">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest truncate max-w-[150px]">
                    {config.scenario.phases?.[activePhaseIndex]?.label}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
        
        <div className="flex flex-col gap-3 pointer-events-auto items-end">
          {!isLearnerDisplay && (
            <button 
              onClick={() => setActiveDrawer(activeDrawer === 'facilitator' ? null : 'facilitator')}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-xl border transition-all backdrop-blur-xl text-[10px] font-black uppercase tracking-widest pointer-events-auto ${activeDrawer === 'facilitator' ? 'bg-amber-600 border-amber-400 text-white' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 shadow-lg'}`}
            >
              <i className="fas fa-user-gear text-xs"></i> Facilitator Console
              {hasNewPending && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-amber-500 rounded-full border-2 border-slate-900 animate-pulse"></span>
              )}
            </button>
          )}
          {/* Patient Chart button removed from facilitator screen */}
        </div>
      </div>

      <div id="simulation-viewport" className="flex-1 relative bg-slate-950 overflow-hidden h-full w-full flex items-center justify-center">
        <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900 via-slate-950 to-black"></div>

        {isLearnerDisplay && releasedAssets.length > 0 && (
          <div className="absolute top-8 right-8 z-50 flex flex-col gap-6 max-w-md pointer-events-none">
            {releasedAssets.map(a => (
              <div key={a.id} className="bg-[#f8f9fa] border-l-[12px] border-l-blue-700 border border-slate-300 rounded-lg shadow-2xl animate-fade-in pointer-events-auto overflow-hidden flex flex-col">
                {/* Lab Report Header */}
                <div className="bg-white px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-700 rounded-lg flex items-center justify-center text-white shadow-md">
                      <i className={`fas fa-${a.type === 'Lab' ? 'flask' : a.type === 'Imaging' ? 'x-ray' : a.type === 'EKG' ? 'wave-square' : a.type === 'Medication' ? 'pills' : a.type === 'Vitals' ? 'heart-pulse' : 'clipboard-list'} text-lg`}></i>
                    </div>
                    <div>
                      <h3 className="text-[14px] font-black text-slate-900 uppercase tracking-tight leading-none">SimVeritas {a.type} Report</h3>
                      <p className="text-[9px] font-black text-blue-700 uppercase tracking-widest mt-1">Clinical Information System</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Report ID</p>
                    <p className="text-[10px] font-mono font-bold text-slate-600">{a.id.substring(0, 8).toUpperCase()}</p>
                  </div>
                </div>

                {/* Report Content */}
                <div className="p-6 bg-white flex-1">
                  <div className="mb-4 flex justify-between items-start border-b border-slate-100 pb-4">
                    <div>
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Patient Name</p>
                      <p className="text-[12px] font-bold text-slate-800">{config?.scenario?.patientProfile?.name || 'Unknown'}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Status</p>
                      <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-[8px] font-black rounded-full uppercase tracking-widest border border-emerald-200">Final</span>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2">Findings / Results</p>
                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                        <p className="text-[13px] text-slate-700 leading-relaxed font-medium whitespace-pre-wrap font-mono">
                          {a.content}
                        </p>
                      </div>
                    </div>

                    {a.imageUrl && (
                      <div className="relative group cursor-pointer" onClick={() => window.open(a.imageUrl, '_blank')}>
                        <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2">Diagnostic Image Attachment</p>
                        <div className="rounded-xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                          <img src={a.imageUrl} referrerPolicy="no-referrer" className="w-full h-48 object-cover" alt="Clinical Finding" />
                          <div className="absolute inset-0 bg-blue-900/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <div className="bg-white/90 backdrop-blur px-4 py-2 rounded-full shadow-xl flex items-center gap-2">
                              <i className="fas fa-expand text-blue-700 text-xs"></i>
                              <span className="text-[9px] font-black text-blue-700 uppercase tracking-widest">Expand Image</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Confidentiality Footer */}
                <div className="bg-slate-100 px-6 py-3 border-t border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <i className="fas fa-shield-halved text-slate-400 text-[10px]"></i>
                    <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest italic">
                      Confidential: To be exclusively used for simulation purposes only
                    </p>
                  </div>
                  <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">
                    SimVeritas v4.0
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Watermark removed for cleaner display */}

        {config.visualMode === 'Video' && videoUrl ? (
          <video 
            key={videoUrl}
            src={videoUrl} 
            autoPlay 
            loop 
            muted 
            playsInline
            className="relative z-10 w-full h-full object-contain shadow-[0_0_100px_rgba(0,0,0,0.8)]" 
          />
        ) : (
          <div className="w-full h-full relative flex items-center justify-center">
            {(isProcessingVisuals || videoError) && (
              <div className="absolute inset-0 bg-black/50 backdrop-blur-md z-20 flex flex-col items-center justify-center text-white p-12 text-center transition-opacity">
                {isProcessingVisuals && (
                  <>
                    <div className="w-14 h-14 border-4 border-white/10 border-t-blue-500 rounded-full animate-spin mb-8 shadow-2xl"></div>
                    <span className="text-[12px] font-black uppercase tracking-[0.3em] text-blue-400 animate-pulse">{videoProgressMsg || "Adjusting Neural Synthesis"}</span>
                  </>
                )}
                {videoError && (
                  <div className="mt-6 p-4 bg-red-500/20 border border-red-500/30 rounded-2xl max-w-md">
                    <p className="text-[10px] font-bold text-red-400 uppercase tracking-widest leading-relaxed">{videoError}</p>
                    <div className="flex gap-4 justify-center mt-4">
                      <button 
                        onClick={() => generateVideoPresence()} 
                        className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white text-[9px] font-black uppercase tracking-widest rounded-full transition-all"
                      >
                        Retry Synthesis
                      </button>
                      <button 
                        onClick={() => setVideoError(null)} 
                        className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white text-[9px] font-black uppercase tracking-widest rounded-full transition-all"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {avatarUrl ? (
              <img 
                src={avatarUrl}
                className="relative z-10 max-w-full max-h-full object-contain transition-[filter] duration-1000 avatar-breathing shadow-[0_0_100px_rgba(0,0,0,0.8)]" 
                alt="Avatar" 
                referrerPolicy="no-referrer"
                style={{ 
                  filter: EMOTION_PROFILES[liveEmotion].filter,
                  animationDuration: EMOTION_PROFILES[liveEmotion].animationSpeed 
                }}
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-6 z-10 relative">
                <div className="w-16 h-16 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin shadow-[0_0_30px_rgba(59,130,246,0.3)]"></div>
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] animate-pulse">
                  Synthesizing Patient Identity...
                </span>
              </div>
            )}
          </div>
        )}

        <div className="absolute bottom-10 right-10 z-50 pointer-events-none flex flex-col items-end gap-4 w-full max-w-lg">
          <VoiceVisualizer 
            activeUserTranscript={activeUserTranscript}
            activeModelTranscript={activeModelTranscript}
            micActivity={micActivity}
            speakerRole={speakerRole}
            patientName={config.scenario.patientProfile.name}
            isFacilitatorOverlay={true}
          />
          
          {isQuotaExceeded && (
            <div className="bg-red-500/90 backdrop-blur-md text-white px-6 py-3 rounded-full shadow-2xl border border-white/20 flex items-center gap-4 animate-bounce pointer-events-auto">
              <i className="fas fa-exclamation-triangle text-white"></i>
              <span className="text-[9px] font-black uppercase tracking-widest">Firestore Quota Exceeded — Syncing Paused</span>
              <button 
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    localStorage.removeItem('simveritas_firestore_quota_exceeded');
                    localStorage.removeItem('simveritas_firestore_quota_time');
                    window.location.reload();
                  }
                }}
                className="bg-white text-red-600 px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest hover:bg-black hover:text-white transition-colors"
              >
                Reset & Refresh
              </button>
            </div>
          )}
        </div>

        <div className="absolute top-32 left-10 z-50 pointer-events-none flex flex-col gap-6 items-start">
          {/* Interaction Log Overlay (Facilitator) */}
          {!isLearnerDisplay && (
            <div className="w-96 max-h-[400px] bg-slate-950/60 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-8 flex flex-col overflow-hidden shadow-[0_30px_60px_rgba(0,0,0,0.8)] pointer-events-auto animate-fade-in relative">
              {/* Informatics Header */}
              <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-blue-500/50 via-indigo-500/50 to-blue-500/50 opacity-30"></div>
              
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.4em] flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                  Clinical Informatics Log
                </h3>
                <span className="text-[8px] font-mono text-slate-600 uppercase tracking-widest">v1.52.0-SIM</span>
              </div>

              <div ref={historyScrollRef} className="flex-1 overflow-y-auto custom-scrollbar space-y-6 pr-3">
                {(history || []).map((entry: TranscriptionEntry, i: number) => (
                  <div key={i} className={`flex flex-col gap-2 animate-fade-in ${entry.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-[7px] font-mono text-slate-600 uppercase tracking-widest">
                        {new Date(entry.timestamp || Date.now()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <div className={`w-1 h-1 rounded-full ${entry.role === 'user' ? 'bg-emerald-500' : 'bg-blue-500'}`}></div>
                    </div>
                    
                    <div className={`max-w-[95%] px-5 py-3.5 rounded-2xl text-[12px] font-medium leading-relaxed transition-all hover:scale-[1.02] ${
                      entry.role === 'user' 
                        ? 'bg-emerald-600/20 text-emerald-50 border border-emerald-500/20 rounded-tr-none' 
                        : 'bg-blue-600/20 text-blue-50 border border-blue-500/20 rounded-tl-none'
                    }`}>
                      {entry.text}
                    </div>
                    
                    <span className={`text-[8px] font-black uppercase tracking-[0.2em] px-2 ${entry.role === 'user' ? 'text-emerald-500' : 'text-blue-500'}`}>
                      {entry.role === 'user' ? 'Provider (Input)' : 'Patient (Response)'}
                    </span>
                  </div>
                ))}
                
                {(!history || history.length === 0) && (
                  <div className="py-16 text-center flex flex-col items-center gap-4">
                    <div className="w-12 h-12 rounded-full border border-slate-800 flex items-center justify-center">
                      <i className="fas fa-terminal text-slate-700 text-sm"></i>
                    </div>
                    <p className="text-[10px] font-black text-slate-700 uppercase tracking-[0.3em] italic">Awaiting Interaction Stream...</p>
                  </div>
                )}
              </div>

              {/* Informatics Footer */}
              <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
                <div className="flex gap-1">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="w-3 h-1 bg-slate-800 rounded-full"></div>
                  ))}
                </div>
                <span className="text-[7px] font-mono text-slate-700 uppercase tracking-widest">End of Stream</span>
              </div>
            </div>
          )}
        </div>

        <div className="absolute bottom-0 inset-x-0 p-10 bg-gradient-to-t from-black via-black/40 to-transparent flex flex-col items-center gap-6 z-30 pointer-events-none">
          {/* Bottom center area cleared of primary buttons */}
        </div>
      </div>

      <div 
        id="facilitator-drawer"
        className={`fixed top-0 right-0 h-full w-[400px] md:w-[480px] bg-slate-950/80 backdrop-blur-xl border-l border-white/10 z-[100] transition-transform duration-500 ease-in-out shadow-[-20px_0_60px_rgba(0,0,0,0.6)] flex flex-col ${activeDrawer === 'facilitator' && !isLearnerDisplay ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <header className="p-8 border-b border-white/5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <i className="fas fa-user-gear text-amber-400 text-xl"></i>
            <h3 className="text-[13px] font-black text-white uppercase tracking-[0.2em]">Facilitator Console</h3>
          </div>
          <button onClick={() => setActiveDrawer(null)} className="text-slate-500 hover:text-white p-2 transition-colors"><i className="fas fa-times text-lg"></i></button>
        </header>
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar space-y-10">
          {config.scenario.phases && config.scenario.phases.length > 0 && (
            <div className="bg-slate-900/40 border border-indigo-500/20 rounded-2xl
                            overflow-hidden">

              {/* Panel header */}
              <div className="flex items-center gap-3 px-5 py-3
                              border-b border-indigo-500/15 bg-indigo-500/5">
                <div className="w-7 h-7 bg-indigo-500 rounded-lg flex items-center
                                justify-center text-white shrink-0">
                  <i className="fas fa-timeline text-xs"></i>
                </div>
                <div className="flex-1">
                  <p className="text-[10px] font-black uppercase text-white
                                tracking-tight">Scenario Progression</p>
                  <p className="text-[8px] font-black uppercase text-indigo-400/60
                                tracking-widest">
                    Phase {activePhaseIndex + 1} of {config.scenario.phases.length}
                    &nbsp;·&nbsp;Active
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setActivePhaseIndex(Math.max(0, activePhaseIndex - 1))}
                    disabled={activePhaseIndex === 0}
                    className="w-8 h-8 rounded-lg bg-slate-800 border border-white/5 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
                    title="Previous Phase"
                  >
                    <i className="fas fa-chevron-left text-[10px]"></i>
                  </button>
                  <button
                    onClick={() => setActivePhaseIndex(Math.min(config.scenario.phases.length - 1, activePhaseIndex + 1))}
                    disabled={activePhaseIndex === config.scenario.phases.length - 1}
                    className="w-8 h-8 rounded-lg bg-slate-800 border border-white/5 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
                    title="Next Phase"
                  >
                    <i className="fas fa-chevron-right text-[10px]"></i>
                  </button>
                </div>
              </div>

              {/* Phase tabs */}
              <div className="flex gap-1 p-3 flex-wrap">
                {config.scenario.phases.map((phase, index) => (
                  <button
                    key={phase.id}
                    onClick={() => setActivePhaseIndex(index)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl
                                text-[9px] font-black uppercase tracking-widest
                                transition-all active:scale-95
                                ${activePhaseIndex === index
                                  ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30'
                                  : 'bg-slate-950/60 text-slate-400 border border-white/5 hover:border-indigo-500/30 hover:text-indigo-300'}`}
                  >
                    <span className={`w-4 h-4 rounded-md flex items-center justify-center
                                      text-[8px] font-black shrink-0
                                      ${activePhaseIndex === index
                                        ? 'bg-white/20 text-white'
                                        : 'bg-slate-700 text-slate-400'}`}>
                      {index + 1}
                    </span>
                    {phase.label.replace(/Phase \d+\s*[—-]\s*/i, '')}
                  </button>
                ))}
              </div>

              {/* Active phase details */}
              {activePhase && (
                <div className="px-5 pb-4 space-y-3 border-t border-white/5 pt-3">

                  {/* Current patient state */}
                  <div className="space-y-1">
                    <p className="text-[7px] font-black uppercase text-slate-500
                                  tracking-widest">Current Patient State</p>
                    <p className="text-[10px] text-slate-300 leading-relaxed
                                  font-medium">{activePhase.patientState.symptoms}</p>
                    <div className="flex items-center gap-2 flex-wrap mt-1">
                      <span className="text-[7px] font-black text-purple-400
                                       bg-purple-500/10 border border-purple-500/20
                                       px-2 py-0.5 rounded-full uppercase tracking-widest">
                        {activePhase.patientState.emotion}
                      </span>
                      <span className="text-[7px] font-black text-amber-400
                                       bg-amber-500/10 border border-amber-500/20
                                       px-2 py-0.5 rounded-full uppercase tracking-widest">
                        {activePhase.patientState.vitalsTrend}
                      </span>
                    </div>
                  </div>

                  {/* Escalation triggers at a glance */}
                  {activePhase.escalationTriggers.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[7px] font-black uppercase text-amber-400
                                    tracking-widest">Escalation Rules</p>
                      <div className="space-y-1">
                        {activePhase.escalationTriggers.map((trigger, i) => (
                          <div key={i}
                               className="grid grid-cols-2 gap-1">
                            <div className="bg-emerald-500/5 border border-emerald-500/10
                                            rounded-lg px-3 py-2">
                              <p className="text-[7px] font-black uppercase
                                            text-emerald-400 tracking-widest mb-0.5">
                                ✓ If does
                              </p>
                              <p className="text-[9px] text-slate-400 leading-snug">
                                {trigger.ifLearnerDoes}
                              </p>
                            </div>
                            <div className="bg-red-500/5 border border-red-500/10
                                            rounded-lg px-3 py-2">
                              <p className="text-[7px] font-black uppercase
                                            text-red-400 tracking-widest mb-0.5">
                                ✗ If fails
                              </p>
                              <p className="text-[9px] text-slate-400 leading-snug">
                                {trigger.ifLearnerFails}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* All phases list */}
                  <div className="space-y-2 mt-4">
                    <p className="text-[7px] font-black uppercase text-slate-500 tracking-widest">
                      Case Transition Levels
                    </p>
                    <div className="grid grid-cols-1 gap-1.5">
                      {config.scenario.phases?.map((phase, index) => (
                        <button
                          key={phase.id}
                          onClick={() => setActivePhaseIndex(index)}
                          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-all active:scale-[0.98] ${
                            activePhaseIndex === index
                              ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                              : index < activePhaseIndex
                                ? 'bg-emerald-500/5 border-emerald-500/10 text-emerald-400/60'
                                : 'bg-slate-900/40 border-white/5 text-slate-500 hover:bg-slate-900/60 hover:border-white/10'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`w-5 h-5 rounded-lg flex items-center justify-center text-[9px] font-black ${
                              activePhaseIndex === index
                                ? 'bg-indigo-500 text-white'
                                : index < activePhaseIndex
                                  ? 'bg-emerald-500/20 text-emerald-400'
                                  : 'bg-white/5 text-slate-600'
                            }`}>
                              {index < activePhaseIndex ? <i className="fas fa-check text-[7px]"></i> : index + 1}
                            </span>
                            <span className="text-[9px] font-black uppercase tracking-widest truncate max-w-[200px]">
                              {phase.label}
                            </span>
                          </div>
                          {activePhaseIndex === index && (
                            <span className="text-[7px] font-black uppercase tracking-widest bg-indigo-500/20 px-1.5 py-0.5 rounded-md">
                              Active
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                </div>
              )}

            </div>
          )}
          <div className="space-y-6">
            <h4 className="text-[10px] font-black uppercase text-amber-400 tracking-widest px-2 flex items-center gap-3">
              <i className="fas fa-clock"></i> Pending Orders
            </h4>
            {pendingFulfillment.length > 0 ? pendingFulfillment.map(a => (
              <div key={a.id} className="p-6 bg-slate-900/80 rounded-[2rem] border border-amber-500/30 flex flex-col gap-5 shadow-lg animate-fade-in">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <i className={`fas fa-${a.type === 'Lab' ? 'flask' : a.type === 'Imaging' ? 'x-ray' : a.type === 'EKG' ? 'wave-square' : a.type === 'Medication' ? 'pills' : a.type === 'Vitals' ? 'heart-pulse' : 'hand-holding-medical'} text-amber-400`}></i>
                    <span className="text-[12px] font-black text-white uppercase tracking-tight">{a.title}</span>
                  </div>
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Ordered {new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <button 
                  onClick={() => releaseAsset(a)}
                  disabled={processingAssetIds.has(a.id)}
                  className={`w-full py-4 rounded-xl font-black uppercase tracking-widest text-[10px] transition-all flex items-center justify-center gap-3 shadow-lg ${processingAssetIds.has(a.id) ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-amber-600 text-white hover:bg-amber-500 active:scale-95'}`}
                >
                  {processingAssetIds.has(a.id) ? <i className="fas fa-spinner animate-spin"></i> : <i className="fas fa-microchip"></i>}
                  {processingAssetIds.has(a.id) ? 'Synthesizing...' : 'Synthesize Results'}
                </button>
              </div>
            )) : (
              <div className="text-[12px] text-slate-600 italic py-10 text-center bg-slate-950/40 rounded-[2rem] border border-dashed border-white/10 opacity-40 font-medium uppercase tracking-widest">
                No pending orders
              </div>
            )}
          </div>

          <div className="space-y-6">
            <h4 className="text-[10px] font-black uppercase text-purple-400 tracking-widest px-2 flex items-center gap-3">
              <i className="fas fa-eye"></i> Review Queue
            </h4>
            {reviewQueue.length > 0 ? reviewQueue.map(a => (
              <div key={a.id} className="p-6 bg-slate-900/80 rounded-[2rem] border border-purple-500/30 flex flex-col gap-5 shadow-lg animate-fade-in">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className={`text-[10px] font-bold uppercase mb-1 flex items-center gap-2 ${a.isAiGenerated === false ? 'text-emerald-400' : 'text-purple-400'}`}>
                      <i className={`fas fa-${a.isAiGenerated === false ? 'images' : 'robot'}`}></i> 
                      {a.isAiGenerated === false ? 'Library Asset - Review' : 'AI Generated - Review & Edit'}
                    </div>
                    <input 
                      value={a.title} 
                      onChange={(e) => updateAsset(a.id, { title: e.target.value })}
                      className="w-full bg-slate-950/50 border border-white/5 rounded-xl px-3 py-2 text-[14px] font-black text-white uppercase tracking-tight outline-none focus:border-purple-500/50 transition-all"
                      placeholder="Asset Title"
                    />
                  </div>
                </div>
                <div className="space-y-4">
                  <textarea 
                    value={a.content} 
                    onChange={(e) => updateAsset(a.id, { content: e.target.value })}
                    className="w-full h-32 bg-slate-950/50 border border-white/5 rounded-xl p-3 text-[12px] text-slate-300 leading-relaxed outline-none focus:border-purple-500/50 transition-all resize-none custom-scrollbar"
                    placeholder="Asset Content"
                  />
                  {a.imageUrl && (
                    <div className="space-y-3">
                      <div className="relative group">
                        <img src={a.imageUrl} referrerPolicy="no-referrer" className="w-full h-32 object-cover rounded-xl border border-white/10" alt="Preview" />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-xl">
                          <span className="text-[8px] font-black text-white uppercase tracking-widest">{a.isAiGenerated === false ? 'Library Image' : 'AI Generated Visual'}</span>
                        </div>
                      </div>
                      <div className="p-2 bg-slate-950/40 rounded-lg border border-white/5 flex justify-center items-center">
                        <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest">Simulation Purposes Only</span>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <input 
                            value={regenerationPrompts[a.id] || ""}
                            onChange={(e) => setRegenerationPrompts(prev => ({ ...prev, [a.id]: e.target.value }))}
                            placeholder="Refine image prompt (e.g. 'More ST elevation')"
                            className="flex-1 bg-slate-950/50 border border-white/5 rounded-lg px-3 py-2 text-[10px] text-slate-300 outline-none focus:border-purple-500/50 transition-all"
                          />
                          <button 
                            onClick={() => regenerateImage(a, regenerationPrompts[a.id])}
                            disabled={processingAssetIds.has(a.id)}
                            className="px-4 py-2 bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 text-purple-400 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 whitespace-nowrap"
                          >
                            {processingAssetIds.has(a.id) ? <i className="fas fa-spinner animate-spin"></i> : <i className="fas fa-wand-magic-sparkles"></i>}
                            Regenerate
                          </button>
                        </div>
                        <p className="text-[8px] text-slate-500 italic px-1">Tip: Provide specific clinical details to improve the visual.</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => approveAsset(a.id)}
                    className="py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/20"
                  >
                    <i className="fas fa-check"></i> Release to Learner
                  </button>
                  <button 
                    onClick={() => rejectAsset(a.id)}
                    className="py-3 bg-red-600/20 hover:bg-red-600/40 border border-red-500/30 text-red-400 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
                  >
                    <i className="fas fa-trash-can"></i> Discard
                  </button>
                </div>
              </div>
            )) : (
              <div className="text-[12px] text-slate-600 italic py-10 text-center bg-slate-950/40 rounded-[2rem] border border-dashed border-white/10 opacity-40 font-medium uppercase tracking-widest">
                Review queue empty
              </div>
            )}
          </div>

          {(caseImages.length > 0 || caseDocs.length > 0) && (
            <div className="space-y-6">
              <h4 className="text-[10px] font-black uppercase text-indigo-400 tracking-widest px-2 flex items-center gap-3">
                <i className="fas fa-images"></i> Case Library Assets
              </h4>
              
              {/* Attached Images */}
              {caseImages.length > 0 && (
                <div className="grid grid-cols-2 gap-4">
                  {caseImages.map((imgObj, idx) => {
                    const img = typeof imgObj === 'string' ? imgObj : imgObj.imageUrl;
                    const title = typeof imgObj === 'string' ? `Case Image ${idx + 1}` : imgObj.title;
                    const isAlreadyReleased = releasedAssets.some(a => a.libraryId === img);
                    return (
                      <div key={idx} className="relative group">
                        <img 
                          src={img} 
                          className="w-full h-32 object-cover rounded-2xl border border-white/10 shadow-lg" 
                          alt={title} 
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 bg-slate-950/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-2xl backdrop-blur-[2px] flex-col p-2 text-center">
                          <p className="text-[8px] font-black text-white uppercase tracking-tight mb-2 truncate w-full">{title}</p>
                          {isAlreadyReleased ? (
                            <span className="text-[8px] font-black text-emerald-400 uppercase tracking-widest bg-emerald-500/10 px-3 py-1.5 rounded-full border border-emerald-500/20">
                              Released
                            </span>
                          ) : (
                            <button 
                              onClick={() => releaseAttachedImage(img, idx, title)}
                              className="px-4 py-2 bg-indigo-500 text-white rounded-xl text-[9px] font-black uppercase tracking-widest shadow-xl active:scale-95 transition-all"
                            >
                              Release to Learner
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Attached Documents */}
              {caseDocs.length > 0 && (
                <div className="space-y-3">
                  {caseDocs.map((doc, idx) => {
                    const isAlreadyReleased = releasedAssets.some(a => a.libraryId === doc.name);
                    return (
                      <div key={idx} className="p-4 bg-slate-900/60 border border-white/5 rounded-2xl flex items-center justify-between group">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <i className="fas fa-file-medical text-indigo-400"></i>
                          <div className="overflow-hidden">
                            <p className="text-[10px] font-black text-slate-200 truncate uppercase tracking-tight">{doc.name}</p>
                            <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Clinical Report</p>
                          </div>
                        </div>
                        {isAlreadyReleased ? (
                          <span className="text-[7px] font-black text-emerald-400 uppercase tracking-widest bg-emerald-500/10 px-2 py-1 rounded-full border border-emerald-500/20">
                            Released
                          </span>
                        ) : (
                          <button 
                            onClick={() => releaseAttachedDoc(doc, idx)}
                            className="px-3 py-1.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg text-[8px] font-black uppercase tracking-widest hover:bg-indigo-500 hover:text-white transition-all active:scale-95"
                          >
                            Release
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="space-y-6">
            <h4 className="text-[10px] font-black uppercase text-emerald-400 tracking-widest px-2 flex items-center gap-3">
              <i className="fas fa-file-medical-alt"></i> Direct Result Release
            </h4>
            <div className="grid grid-cols-2 gap-3">
               {(['Lab', 'Imaging', 'EKG', 'Intervention'] as const).map(type => (
                 <button 
                  key={type} 
                  onClick={() => triggerManualRelease(type)} 
                  disabled={processingAssetIds.size > 0}
                  className="flex flex-col items-center justify-center p-4 bg-slate-900/60 rounded-2xl border border-white/5 text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-white hover:bg-slate-800 hover:border-emerald-500/30 transition-all active:scale-95 disabled:opacity-40"
                 >
                   <i className={`fas fa-${type === 'Lab' ? 'flask' : type === 'Imaging' ? 'x-ray' : type === 'EKG' ? 'wave-square' : 'hand-holding-medical'} mb-2 text-lg text-emerald-500`}></i>
                   Push {type}
                 </button>
               ))}
            </div>
          </div>

          <div className="space-y-6 pb-20">
            <h4 className="text-[10px] font-black uppercase text-amber-500 tracking-widest px-2 flex items-center gap-3">
              <i className="fas fa-truck-ramp-box"></i> Pending Fulfillment
            </h4>
            {pendingFulfillment.length > 0 ? pendingFulfillment.map(o => (
              <div key={o.id} className="p-6 bg-slate-900/80 rounded-[2rem] border border-white/10 flex flex-col gap-5 group shadow-lg">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="text-[14px] font-black text-white uppercase tracking-tight">{o.type} REQUEST</div>
                    <div className="text-[10px] text-slate-500 font-bold uppercase mt-1">Ordered by Learner</div>
                  </div>
                  <i className="fas fa-inbox text-amber-500 opacity-40 group-hover:opacity-100 transition-opacity"></i>
                </div>
                <button 
                  onClick={() => releaseAsset(o, true)} 
                  disabled={processingAssetIds.has(o.id)}
                  className="w-full py-4 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-500 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
                >
                  {processingAssetIds.has(o.id) ? <i className="fas fa-spinner animate-spin"></i> : <><i className="fas fa-check-double"></i> Fulfill {o.type}</>}
                </button>
              </div>
            )) : (
              <div className="text-[12px] text-slate-600 italic py-16 text-center bg-slate-950/40 rounded-[2rem] border border-dashed border-white/10 opacity-40 font-medium uppercase tracking-widest">
                No active orders
              </div>
            )}
          </div>

          <div className="space-y-4 border-t border-white/5 pt-6 mt-10">
            <button 
              onClick={() => setIsNeuralOverridesOpen(!isNeuralOverridesOpen)}
              className="w-full flex items-center justify-between px-2 py-2 hover:bg-white/5 rounded-xl transition-colors group"
            >
              <h4 className="text-[10px] font-black uppercase text-blue-400 tracking-widest flex items-center gap-3">
                <i className="fas fa-microchip"></i> Neural Overrides
              </h4>
              <i className={`fas fa-chevron-${isNeuralOverridesOpen ? 'up' : 'down'} text-[10px] text-slate-500 group-hover:text-blue-400 transition-all`}></i>
            </button>
            
            {isNeuralOverridesOpen && (
              <div className="space-y-6 bg-slate-900/60 p-6 rounded-[2rem] border border-white/10 shadow-inner animate-fade-in">
                <div className="space-y-2">
                   <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest ml-1">Affective State</label>
                   <select value={liveEmotion} onChange={(e) => setLiveEmotion(e.target.value as Emotion)} className="w-full bg-slate-950 border border-white/5 rounded-2xl p-4 text-[12px] font-black uppercase text-slate-200 outline-none appearance-none cursor-pointer hover:border-amber-500/30 transition-all">
                     {EMOTIONS.map(e => <option key={e} value={e}>{e}</option>)}
                   </select>
                </div>
                <div className="space-y-2">
                   <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest ml-1">Verbal Output Mode</label>
                   <select value={liveCommStyle} onChange={(e) => setLiveCommStyle(e.target.value as CommunicationStyle)} className="w-full bg-slate-950 border border-white/5 rounded-2xl p-4 text-[12px] font-black uppercase text-slate-200 outline-none appearance-none cursor-pointer hover:border-amber-500/30 transition-all">
                     {COMMUNICATION_STYLES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                   </select>
                </div>
                <div className="space-y-2">
                   <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest ml-1">Secret Directives</label>
                   <textarea value={liveDirectives} onChange={(e) => setLiveDirectives(e.target.value)} placeholder="Hidden context to inject into AI logic..." className="w-full h-32 bg-slate-950 border border-white/5 rounded-2xl p-5 text-[13px] text-slate-200 outline-none resize-none hover:border-amber-500/30 transition-all custom-scrollbar" />
                </div>
                <button onClick={applyFacilitatorUpdates} disabled={!isLive || isSyncing} className={`w-full py-5 rounded-2xl font-black uppercase tracking-widest text-[11px] transition-all flex items-center justify-center gap-4 shadow-xl ${isLive ? 'bg-amber-600 text-white hover:bg-amber-500' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>
                  {isSyncing ? <i className="fas fa-spinner animate-spin"></i> : <i className="fas fa-bolt-lightning"></i>}
                  {t.sync || 'Sync Neural Directives'}
                </button>

                {config.visualMode === 'Video' && (
                  <button 
                    onClick={() => generateVideoPresence()} 
                    disabled={isProcessingVisuals} 
                    className={`w-full py-5 rounded-2xl font-black uppercase tracking-widest text-[11px] transition-all flex items-center justify-center gap-4 shadow-xl border border-purple-500/30 ${isProcessingVisuals ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-purple-900/40 text-purple-300 hover:bg-purple-800/60'}`}
                  >
                    {isProcessingVisuals ? <i className="fas fa-spinner animate-spin"></i> : <i className="fas fa-video"></i>}
                    Regenerate Neural Video
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {activeDrawer && (
        <div 
          className="fixed inset-0 bg-black/40 z-[90] animate-fade-in"
          onClick={() => setActiveDrawer(null)}
        />
      )}

      {/* Restart Countdown Overlay */}
      {isRestarting && (
        <div id="restart-overlay" className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl z-[250] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-slate-900 border border-white/10 rounded-[2.5rem] p-10 shadow-[0_40px_100px_rgba(0,0,0,0.8)] animate-fade-in text-center">
            <div className="w-24 h-24 bg-blue-500/10 rounded-full flex items-center justify-center text-blue-500 mb-8 mx-auto border border-blue-500/20 relative">
              <div className="absolute inset-0 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
              <span className="text-4xl font-black">{restartCountdown || <i className="fas fa-sync-alt animate-pulse"></i>}</span>
            </div>
            <h2 className="text-2xl font-black text-white uppercase tracking-tighter mb-4">Restarting Simulation</h2>
            <p className="text-slate-400 text-sm leading-relaxed mb-8">
              {restartCountdown 
                ? `Resetting clinical environment in ${restartCountdown}...` 
                : "Re-initializing neural link and patient identity. Please stand by."}
            </p>
            <div className="flex flex-col gap-2 items-center">
              <div className="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                <div className={`w-1.5 h-1.5 rounded-full ${restartCountdown === null ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-700'}`}></div>
                Data Purged
              </div>
              <div className="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                <div className={`w-1.5 h-1.5 rounded-full ${restartCountdown === null ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-700'}`}></div>
                Assets Cleared
              </div>
              <div className="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                <div className={`w-1.5 h-1.5 rounded-full ${restartCountdown === null && !isRestarting ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-blue-500 animate-pulse'}`}></div>
                Re-initializing Live Session
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default SimulationRoom;
