
import { Scenario, Emotion, VoiceName, Language, CommunicationStyle, Accent, Specialty, CaregiverSubRole, CognitiveTrait } from './types';

export const SPECIALTIES: Specialty[] = [
  'General Medicine', 'Cardiology', 'Pediatrics', 'Emergency Medicine', 
  'Neurology', 'Psychiatry', 'Surgery', 'OB/GYN', 'Geriatrics', 'Infectious Disease'
];

export const CAREGIVER_SUB_ROLES: { id: CaregiverSubRole; icon: string }[] = [
  { id: 'Nurse', icon: 'fa-user-nurse' },
  { id: 'Physician', icon: 'fa-user-md' },
  { id: 'Respiratory Therapist', icon: 'fa-lungs' },
  { id: 'Resident', icon: 'fa-user-graduate' },
  { id: 'EMS personnel', icon: 'fa-ambulance' },
];

export const SPECIALTY_COLORS: Record<Specialty, string> = {
  'General Medicine': 'bg-slate-500',
  'Cardiology': 'bg-red-500',
  'Pediatrics': 'bg-purple-500',
  'Emergency Medicine': 'bg-orange-500',
  'Neurology': 'bg-indigo-500',
  'Psychiatry': 'bg-pink-500',
  'Surgery': 'bg-amber-500',
  'OB/GYN': 'bg-teal-500',
  'Geriatrics': 'bg-emerald-500',
  'Infectious Disease': 'bg-lime-500'
};

export const DEFAULT_SCENARIOS: Scenario[] = [
  {
    id: 'peds-fever-001',
    title: 'Pediatric Febrile Seizure',
    specialties: ['Pediatrics', 'Emergency Medicine'],
    description: 'A frantic parent brings in a 2-year-old who just had a 1-minute tonic-clonic seizure at home.',
    patientProfile: {
      name: 'Baby Leo',
      age: 2,
      gender: 'Male',
      race: 'Caucasian',
      religion: 'Christianity',
      medicalHistory: 'None, up to date on vaccines.',
      currentSymptoms: 'Post-ictal state, fever of 102.4F.'
    },
    learningObjectives: ['Communicate with a distressed parent', 'Explain febrile seizures', 'Perform pediatric assessment']
  },
  {
    id: 'chest-pain-001',
    title: 'Acute Coronary Syndrome',
    specialties: ['Cardiology', 'Emergency Medicine'],
    description: 'A middle-aged patient presenting with sudden-onset substernal chest pain radiating to the left arm.',
    patientProfile: {
      name: 'Robert Miller',
      age: 58,
      gender: 'Male',
      race: 'Black/African American',
      religion: 'Christianity',
      medicalHistory: 'Hypertension, Type 2 Diabetes, Smoker (1 pack/day)',
      currentSymptoms: 'Crushing chest pain (8/10), diaphoresis, shortness of breath.'
    },
    learningObjectives: ['Differentiate cardiac vs non-cardiac pain', 'Prioritize initial diagnostics', 'Communicate effectively under pressure']
  }
];

export const EMOTIONS = Object.values(Emotion);

export const RACES = [
  'Caucasian',
  'Black/African American',
  'Hispanic/Latino',
  'South Asian',
  'East Asian',
  'Middle Eastern',
  'Indigenous/Native',
  'Pacific Islander'
];

export const RELIGIONS = [
  'Christianity',
  'Not Specified',
  'Islam',
  'Hinduism',
  'Buddhism',
  'Judaism',
  'Sikhism',
  'Shinto',
  'Secular/Atheist'
];

export const COMMUNICATION_STYLES: { id: CommunicationStyle; label: string; desc: string; icon: string }[] = [
  { id: 'Complete', label: 'Complete', desc: 'Thorough but natural; only shares what is asked without repeating previously shared info.', icon: 'fa-check-double' },
  { id: 'Succinct', label: 'Succinct', desc: 'Brief and to the point; avoids any redundant information.', icon: 'fa-compress-arrows-alt' },
  { id: 'Verbose', label: 'Verbose', desc: 'Detailed answers; shares new context but still avoids repeating already known facts.', icon: 'fa-comment-dots' },
  { id: 'Misleading', label: 'Misleading', desc: 'Subtly obstructive; may repeat irrelevant info to distract but avoids helpful repetition.', icon: 'fa-exclamation-triangle' },
];

export const ACCENTS: { id: Accent; label: string; desc: string }[] = [
  { id: 'General American', label: 'General American', desc: 'Standard neutral US dialect.' },
  { id: 'AAVE', label: 'AAVE / Black English', desc: 'African American Vernacular English syntax and rhythm.' },
  { id: 'Southern US', label: 'Southern Vernacular', desc: 'Southern US regional dialect and colloquialisms.' },
  { id: 'Latino English', label: 'Chicano/Latino English', desc: 'Spanish-influenced US English vernacular.' },
  { id: 'South Asian American', label: 'South Asian American', desc: 'Desi-influenced US English phrasing.' },
  { id: 'East Asian American', label: 'East Asian American', desc: 'East Asian-influenced US English intonation.' },
];

export const LANGUAGES: { id: Language; label: string; flag: string }[] = [
  { id: 'en-US', label: 'English (US)', flag: '🇺🇸' },
];

export const COGNITIVE_TRAITS: { id: CognitiveTrait; label: string; desc: string }[] = [
  { id: 'High Literacy', label: 'High Literacy', desc: 'Uses complex medical terminology and understands nuanced clinical explanations.' },
  { id: 'Low Literacy', label: 'Low Literacy', desc: 'Requires simple, non-medical language; may struggle with complex instructions.' },
  { id: 'Unreliable Memory', label: 'Unreliable Memory', desc: 'Contradicts previous statements; forgets recent events or medical history details.' },
  { id: 'Deflection', label: 'Deflection', desc: 'Avoids direct questions by changing the subject or focusing on irrelevant details.' },
  { id: 'Minimization', label: 'Minimization', desc: 'Downplays the severity of symptoms or the impact of their condition.' },
  { id: 'Fragmented Speech', label: 'Fragmented Speech', desc: 'Speaks in short, broken phrases; may lose train of thought mid-sentence.' },
];

export const VOICE_PROFILES: { 
  id: string; 
  name: VoiceName; 
  label: string; 
  desc: string; 
  gender: 'male' | 'female'; 
  minAge: number; 
  maxAge: number;
  ageGroup: 'infant' | 'child' | 'adolescent' | 'adult' | 'senior';
  pitchHint: 'very-high' | 'high' | 'medium-high' | 'medium' | 'medium-low' | 'low';
}[] = [
  // ── FEMALE ──────────────────────────────────────────────
  // Infant/toddler: 0–4 years — Aoede is the lightest female voice available
  { id: 'baby-girl',  name: 'Zephyr',   label: 'Baby Girl',   desc: 'Infant/toddler female (0–4y)',      gender: 'female', minAge: 0,   maxAge: 4,   ageGroup: 'infant',     pitchHint: 'very-high' },
  // Child: 5–12 years
  { id: 'lily',       name: 'Zephyr',   label: 'Lily',        desc: 'Young child female (5–9y)',          gender: 'female', minAge: 5,   maxAge: 9,   ageGroup: 'child',      pitchHint: 'high' },
  { id: 'chloe',      name: 'Zephyr',   label: 'Chloe',       desc: 'Older child female (10–12y)',        gender: 'female', minAge: 10,  maxAge: 12,  ageGroup: 'child',      pitchHint: 'high' },
  // Adolescent: 13–17 years
  { id: 'sophie',     name: 'Zephyr',  label: 'Sophie',      desc: 'Teenage female (13–17y)',            gender: 'female', minAge: 13,  maxAge: 17,  ageGroup: 'adolescent', pitchHint: 'medium-high' },
  // Young adult: 18–30
  { id: 'maya',       name: 'Kore',    label: 'Maya',        desc: 'Young adult female (18–30y)',        gender: 'female', minAge: 18,  maxAge: 30,  ageGroup: 'adult',      pitchHint: 'medium' },
  // Adult: 31–59
  { id: 'elena',      name: 'Zephyr',  label: 'Elena',       desc: 'Adult female (31–59y)',              gender: 'female', minAge: 31,  maxAge: 59,  ageGroup: 'adult',      pitchHint: 'medium' },
  // Senior: 60+
  { id: 'anna',       name: 'Kore',    label: 'Anna',        desc: 'Senior female (60y+)',               gender: 'female', minAge: 60,  maxAge: 120, ageGroup: 'senior',     pitchHint: 'medium-low' },

  // ── MALE ────────────────────────────────────────────────
  // Infant/toddler: 0–4 years — Orbit is the lightest male-mapped voice
  { id: 'baby-boy',   name: 'Puck',   label: 'Baby Boy',    desc: 'Infant/toddler male (0–4y)',         gender: 'male',   minAge: 0,   maxAge: 4,   ageGroup: 'infant',     pitchHint: 'very-high' },
  // Child: 5–12 years — pre-voice-break
  { id: 'charlie',    name: 'Puck',   label: 'Charlie',     desc: 'Young child male (5–9y)',            gender: 'male',   minAge: 5,   maxAge: 9,   ageGroup: 'child',      pitchHint: 'high' },
  { id: 'leo',        name: 'Puck',   label: 'Leo',         desc: 'Older child male (10–12y)',          gender: 'male',   minAge: 10,  maxAge: 12,  ageGroup: 'child',      pitchHint: 'high' },
  // Adolescent: 13–17 — voice breaking
  { id: 'sam',        name: 'Puck',    label: 'Sam',         desc: 'Teen male — voice breaking (13–17y)', gender: 'male',  minAge: 13,  maxAge: 17,  ageGroup: 'adolescent', pitchHint: 'medium-high' },
  // Young adult: 18–30
  { id: 'mateo',      name: 'Puck',    label: 'Mateo',       desc: 'Young adult male (18–30y)',          gender: 'male',   minAge: 18,  maxAge: 30,  ageGroup: 'adult',      pitchHint: 'medium' },
  // Adult: 31–59
  { id: 'arjun',      name: 'Fenrir',  label: 'Arjun',       desc: 'Adult male (31–59y)',                gender: 'male',   minAge: 31,  maxAge: 59,  ageGroup: 'adult',      pitchHint: 'medium-low' },
  // Senior: 60+
  { id: 'wei',        name: 'Charon',  label: 'Wei',         desc: 'Senior male (60y+)',                 gender: 'male',   minAge: 60,  maxAge: 120, ageGroup: 'senior',     pitchHint: 'low' },
];

export const EMOTION_PROFILES: Record<Emotion, { filter: string; description: string; animationSpeed: string }> = {
  [Emotion.STABLE]: { 
    filter: 'brightness(1) contrast(1)', 
    description: 'Neutral, calm expression. Steady gaze, relaxed jaw, breathing normally at a steady rate.',
    animationSpeed: '4s'
  },
  [Emotion.CONCERNED]: { 
    filter: 'brightness(0.9) contrast(1.1) saturate(1.2)', 
    description: 'Worried expression. Tense eyebrows, frequent eye contact, biting lip slightly, breathing slightly faster.',
    animationSpeed: '2.5s'
  },
  [Emotion.FATIGUED]: { 
    filter: 'brightness(0.8) contrast(0.9) saturate(0.7)', 
    description: 'Exhausted expression. Heavy eyelids, slow blinking, pale complexion, looking downward, slow labored breathing.',
    animationSpeed: '6s'
  },
  [Emotion.APPREHENSIVE]: { 
    filter: 'brightness(1.1) contrast(1.2)', 
    description: 'Nervous expression. Wide eyes, looking around the room, shallow rapid breathing, occasional trembling.',
    animationSpeed: '1.5s'
  },
  [Emotion.UNCOMFORTABLE]: { 
    filter: 'brightness(0.95) contrast(1.1) hue-rotate(10deg)', 
    description: 'Pained expression. Grimacing slightly, shifting weight, clenching jaw, irregular breathing patterns.',
    animationSpeed: '2s'
  },
  [Emotion.SKEPTICAL]: { 
    filter: 'brightness(1) contrast(1.3)', 
    description: 'Doubtful expression. One eyebrow raised, head tilted, lips pursed, steady but slow breathing.',
    animationSpeed: '3.5s'
  },
  [Emotion.DISTRESSED]: { 
    filter: 'brightness(1.2) contrast(1.4) saturate(1.5)', 
    description: 'Panicked expression. Acute distress, eyes darting, sweating, heavy rapid gasping for air.',
    animationSpeed: '1s'
  },
  [Emotion.COOPERATIVE]: { 
    filter: 'brightness(1.05) saturate(1.1)', 
    description: 'Friendly, open expression. Attentive, nodding slightly, calm and open expression, relaxed breathing.',
    animationSpeed: '3s'
  }
};
