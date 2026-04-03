
export type VoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
export type AvatarRole = 'Patient' | 'Parent' | 'Caregiver';
export type CaregiverSubRole = 'Nurse' | 'Physician' | 'Respiratory Therapist' | 'Resident' | 'EMS personnel';
export type Language = 'en-US';
export type CommunicationStyle = 'Complete' | 'Succinct' | 'Verbose' | 'Misleading';
export type Accent = 'General American' | 'AAVE' | 'Southern US' | 'Latino English' | 'South Asian American' | 'East Asian American';
export type CognitiveTrait = 'High Literacy' | 'Low Literacy' | 'Unreliable Memory' | 'Deflection' | 'Minimization' | 'Fragmented Speech';
export type VisualMode = 'Video' | 'Static';
export type Specialty = 'General Medicine' | 'Cardiology' | 'Pediatrics' | 'Emergency Medicine' | 'Neurology' | 'Psychiatry' | 'Surgery' | 'OB/GYN' | 'Geriatrics' | 'Infectious Disease';

export enum Emotion {
  STABLE = 'Stable & Calm',
  CONCERNED = 'Mildly Concerned',
  FATIGUED = 'Fatigued/Tired',
  APPREHENSIVE = 'Apprehensive',
  UNCOMFORTABLE = 'Slightly Uncomfortable',
  SKEPTICAL = 'Mildly Skeptical',
  DISTRESSED = 'Clinically Distressed',
  COOPERATIVE = 'Cooperative'
}

export interface EscalationTrigger {
  ifLearnerDoes: string;
  thenPatientResponse: string;
  ifLearnerFails: string;
  thenPatientDeteriorates: string;
}

export interface PhasePatientState {
  symptoms: string;
  emotion: Emotion;
  vitalsTrend: string;
}

export interface ScenarioPhase {
  id: string;
  label: string;
  triggerCondition: string;
  durationHint: number;
  patientState: PhasePatientState;
  expectedLearnerActions: string[];
  escalationTriggers: EscalationTrigger[];
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  specialties: Specialty[];
  isCustom?: boolean;
  patientProfile: {
    name: string;
    age: number | string;
    gender: string;
    race?: string;
    religion?: string;
    medicalHistory: string;
    currentSymptoms: string;
  };
  learningObjectives: string[];
  facilitatorInstructions?: string;
  debriefKnowledgeBase?: string;
  phases?: ScenarioPhase[];
  knowledgeBase?: string;
  sourceAuthors?: string;
  attachedImages?: { title: string; imageUrl: string }[]; // Images attached to the case with titles
  attachedDocs?: { name: string; content: string }[]; // Clinical reports or reference documents
}

export interface ClinicalAsset {
  id: string;
  type: 'Lab' | 'Imaging' | 'EKG' | 'Vitals' | 'Medication' | 'Intervention' | 'Report';
  status: 'ordered' | 'pending_review' | 'released' | 'rejected';
  title: string;
  content?: string; 
  imageUrl?: string;
  timestamp: number;
  isAiGenerated?: boolean;
  visualPrompt?: string;
  source?: 'learner' | 'facilitator';
  syncState?: 'local_only' | 'requested' | 'acknowledged';
  _hasLargeUrl?: boolean;
  libraryId?: string;
}

export interface SimulationConfig {
  sessionTimestamp?: number;
  scenario: Scenario;
  voice: VoiceName;
  emotion: Emotion;
  avatarRole: AvatarRole;
  caregiverSubRole?: CaregiverSubRole;
  language: Language;
  communicationStyle: CommunicationStyle;
  accent: Accent;
  visualMode: VisualMode;
  facilitatorInstructions?: string;
  knowledgeBase?: string;
  debriefKnowledgeBase?: string;
  race: string;
  religion: string;
  avatarAge: number | string;
  gender: 'male' | 'female';
  avatarAppearanceNotes: string;
  vocalizationNotes?: string;
  cognitiveTraits: CognitiveTrait[];
}

export interface TranscriptionEntry {
  role: 'user' | 'model' | 'facilitator';
  text: string;
  timestamp: number;
}

export type NCBISourceType =
  | 'Society Practice Guideline'
  | 'National Clinical Guideline'
  | 'Consensus Statement'
  | 'Clinical Practice Guideline'
  | 'Meta-Analysis'
  | 'Systematic Review'
  | 'Clinical Reference';

export interface NCBISource {
  pmid: string;
  title: string;
  authors: string;
  journal: string;
  year: string;
  abstract: string;
  url: string;
  doi?: string | null;
  sourceType: NCBISourceType;
  pubTypes?: string;
}

export interface FeedbackReport {
  summary: string;
  strengths: string[];
  improvements: string[];
  clinicalAnalysis: {
    action: string;
    appropriateness: string;
    explanation: string;
    guidelineReference: string;  // "Guideline Name — PMID XXXXXXXX"
    sourceTypeBadge: string;     // mirrors NCBISourceType for display
  }[];
  overallScore: number;
  clinicalAccuracy: number;
  communicationScore: number;
  evidenceBasedScore: number;
  keyInsights: string[];
  evidenceSources: NCBISource[];
}

export interface SavedReport {
  id: string;
  timestamp: number;
  scenarioTitle: string;
  patientName: string;
  report: FeedbackReport;
}

export interface AnalyticsData {
  id: string;
  timestamp: number;
  scenarioTitle: string;
  patientName: string;
  overallScore: number;
  clinicalAccuracy: number;
  communicationScore: number;
  evidenceBasedScore: number;
}

export interface SimulationStatus {
  isLive: boolean;
  isConnecting: boolean;
  statusMsg: string;
  hasHistory?: boolean;
}

export interface SimulationRoomHandle {
  finalize: () => void;
  terminate: () => void;
  restart: () => void;
  startLiveSession: (useHistory?: boolean, resetPhase?: boolean) => void;
  stopLiveSession: () => void;
  syncLearner: () => void;
  toggleChart: () => void;
  toggleFacilitator: () => void;
}

export interface DashboardHandle {
  openArchive: () => void;
}

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}
