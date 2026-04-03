
import React, { useState, useRef, useEffect, useMemo, forwardRef, useImperativeHandle, useCallback } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { getApiKey } from './apiKey';
import * as mammoth from 'mammoth/mammoth.browser';
import { getDocument, GlobalWorkerOptions, version } from 'pdfjs-dist';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Scenario, ScenarioPhase, SimulationConfig, Emotion, VoiceName, AvatarRole, Language, CommunicationStyle, Accent, VisualMode, Specialty, CaregiverSubRole, SavedReport, AnalyticsData, DashboardHandle, CognitiveTrait } from './types';

// Configure PDF.js worker using a reliable CDN that matches the installed version
GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
import { DEFAULT_SCENARIOS, EMOTIONS, LANGUAGES, COMMUNICATION_STYLES, ACCENTS, VOICE_PROFILES, RACES, RELIGIONS, SPECIALTIES, SPECIALTY_COLORS, CAREGIVER_SUB_ROLES, COGNITIVE_TRAITS } from './constants';


// Robust fallback identity registry for high-demand scenarios
const FALLBACK_IDENTITY_MAP: Record<string, Record<string, string[]>> = {
  'Caucasian': {
    'male': ['James Miller', 'Thomas Wright', 'Benjamin Scott', 'Andrew Clark'],
    'female': ['Sarah Jenkins', 'Emma Thompson', 'Clara Rhodes', 'Laura Bennett']
  },
  'Black/African American': {
    'male': ['Malik Washington', 'Terrence Jordan', 'Isaiah Banks', 'Marcus Reed'],
    'female': ['Aaliyah Jackson', 'Nia Robinson', 'Zora Williams', 'Keisha Brooks']
  },
  'Hispanic/Latino': {
    'male': ['Mateo Hernandez', 'Diego Flores', 'Javier Morales', 'Carlos Ruiz'],
    'female': ['Elena Vasquez', 'Isabella Gomez', 'Sofia Castillo', 'Lucia Mendez']
  },
  'South Asian': {
    'male': ['Arjun Sharma', 'Rohan Patel', 'Aarav Gupta', 'Vikram Singh'],
    'female': ['Ananya Iyer', 'Priya Reddy', 'Saanvi Nair', 'Ishita Kapoor']
  },
  'East Asian': {
    'male': ['Wei Chen', 'Hiroshi Tanaka', 'Jun-ho Park', 'Kenji Sato'],
    'female': ['Mei Ling', 'Akiko Yamamoto', 'Ji-won Kim', 'Yuki Ito']
  },
  'Middle Eastern': {
    'male': ['Omar Al-Fayed', 'Zaid Mansour', 'Amir Haddad', 'Youssef Khalil'],
    'female': ['Fatima Zahra', 'Layla Abbas', 'Noor Al-Said', 'Mariam Hassan']
  }
};

function getNumericAge(age: number | string): number {
  if (typeof age === 'number') return age;
  const parts = age.trim().toLowerCase().split(' ');
  const value = parseFloat(parts[0]);
  if (isNaN(value)) return 0;
  if (parts.includes('day') || parts.includes('days') || parts.includes('d')) return value / 365;
  if (parts.includes('week') || parts.includes('weeks') || parts.includes('w')) return value / 52;
  if (parts.includes('month') || parts.includes('months') || parts.includes('m')) return value / 12;
  return value; // Assume years if no unit or 'year' or 'y'
}

function parseAgeString(age: string | number): { value: string, unit: string } {
  if (typeof age === 'number') return { value: age.toString(), unit: 'y' };
  const parts = age.trim().toLowerCase().split(' ');
  const val = parts[0] || '';
  const unitStr = parts[1] || '';
  if (unitStr.startsWith('d') || parts.includes('day') || parts.includes('days')) return { value: val, unit: 'd' };
  if (unitStr.startsWith('w') || parts.includes('week') || parts.includes('weeks')) return { value: val, unit: 'w' };
  if (unitStr.startsWith('m') || parts.includes('month') || parts.includes('months')) return { value: val, unit: 'm' };
  return { value: val, unit: 'y' };
}

function updateAgeInText(text: string, oldAge: string | number, newAge: string | number): string {
  if (!text) return text;
  const oldVal = typeof oldAge === 'number' ? oldAge.toString() : oldAge.trim().split(' ')[0];
  const newVal = typeof newAge === 'number' ? newAge.toString() : newAge.trim().split(' ')[0];
  
  if (!oldVal || !newVal || oldVal === newVal) return text;

  // Regex to find the old age value followed by age-related suffixes
  const regex = new RegExp(`\\b${oldVal}(\\s*|-)(year-old|yo|y/o|year old|y\\.o\\.|day-old|week-old|month-old)\\b`, 'gi');
  return text.replace(regex, (match, p1, p2) => `${newVal}${p1}${p2}`);
}

function formatAge(age: number | string): string {
  if (typeof age === 'string') {
    const lower = age.toLowerCase();
    if (lower.includes('day') || lower.includes('week') || lower.includes('month') || lower.includes('year')) {
      return age;
    }
    if (lower.includes(' d') || lower.includes(' w') || lower.includes(' m') || lower.includes(' y')) {
      return age.toUpperCase();
    }
    const val = parseFloat(age);
    if (!isNaN(val)) {
      // If it's a decimal less than 1, it might be a converted age (days/months)
      if (val < 1 && val > 0) {
        if (val < 0.02) return `${(val * 365).toFixed(0)} Days`;
        if (val < 0.08) return `${(val * 52).toFixed(0)} Weeks`;
        return `${(val * 12).toFixed(0)} Months`;
      }
      return `${age}Y`;
    }
    return age;
  }
  return `${age}Y`;
}

interface DashboardProps {
  onStart: (config: SimulationConfig) => void;
  customScenarios: Scenario[];
  onSaveScenario: (scenario: Scenario) => void;
  onDeleteScenario: (id: string) => void;
  bufferScenario: Scenario | null;
  setBufferScenario: (scenario: Scenario | null) => void;
  selectedScenarioId: string;
  setSelectedScenarioId: (id: string) => void;
  savedReports: SavedReport[];
  analyticsData: AnalyticsData[];
  onDeleteReport: (id: string) => void;
  onViewReport: (report: SavedReport) => void;
  hasApiKey: boolean;
  onSelectKey: () => void;
}

interface KnowledgeDoc {
  name: string;
  digest: string;
}

const Dashboard = forwardRef<DashboardHandle, DashboardProps>(({ 
  onStart, 
  customScenarios, 
  onSaveScenario, 
  onDeleteScenario,
  bufferScenario,
  setBufferScenario,
  selectedScenarioId,
  setSelectedScenarioId,
  savedReports,
  analyticsData,
  onDeleteReport,
  onViewReport,
  hasApiKey,
  onSelectKey
}, ref) => {
  const [editableScenario, setEditableScenario] = useState<Scenario>(() => {
    const found = [...DEFAULT_SCENARIOS, ...customScenarios].find(s => s.id === selectedScenarioId);
    if (selectedScenarioId === 'buffer' && bufferScenario) return bufferScenario;
    return found || DEFAULT_SCENARIOS[0];
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSpecialtyFilter, setActiveSpecialtyFilter] = useState<Specialty | 'All'>('All');
  const [notification, setNotification] = useState<{ message: string; type: 'error' | 'success' | 'info' } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ id: string; type: 'scenario' | 'report' } | null>(null);
  const [drawerTab, setDrawerTab] = useState<'reports' | 'analytics'>('reports');
  
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDoc[]>([]);
  const [debriefDocs, setDebriefDocs] = useState<KnowledgeDoc[]>(() => {
    const saved = localStorage.getItem('medsim_debrief_foundations_v1');
    return saved ? JSON.parse(saved) : [];
  });

  const [liveHistory, setLiveHistory] = useState(() => {
    const found = [...DEFAULT_SCENARIOS, ...customScenarios].find(s => s.id === selectedScenarioId);
    if (selectedScenarioId === 'buffer' && bufferScenario) return bufferScenario.patientProfile.medicalHistory;
    return (found || DEFAULT_SCENARIOS[0]).patientProfile.medicalHistory;
  });
  const [liveSymptoms, setLiveSymptoms] = useState(() => {
    const found = [...DEFAULT_SCENARIOS, ...customScenarios].find(s => s.id === selectedScenarioId);
    if (selectedScenarioId === 'buffer' && bufferScenario) return bufferScenario.patientProfile.currentSymptoms;
    return (found || DEFAULT_SCENARIOS[0]).patientProfile.currentSymptoms;
  });
  const [facilitatorInstructions, setFacilitatorInstructions] = useState('');

  const [selectedGender, setSelectedGender] = useState<'male' | 'female'>('male');
  const [avatarAge, setAvatarAge] = useState<number | string>(32);
  const lastKnownAgeRef = useRef<string | number>('');

  // Sync lastKnownAgeRef when editableScenario changes
  useEffect(() => {
    if (editableScenario.patientProfile.age) {
      lastKnownAgeRef.current = editableScenario.patientProfile.age;
    }
  }, [editableScenario.id]);

  const handleAgeChange = (newAge: string | number) => {
    const oldAge = lastKnownAgeRef.current;
    if (oldAge && newAge && oldAge !== newAge) {
      setEditableScenario(prev => ({
        ...prev,
        description: updateAgeInText(prev.description, oldAge, newAge),
        patientProfile: {
          ...prev.patientProfile,
          age: newAge,
          medicalHistory: updateAgeInText(prev.patientProfile.medicalHistory, oldAge, newAge),
          currentSymptoms: updateAgeInText(prev.patientProfile.currentSymptoms, oldAge, newAge)
        }
      }));
    } else {
      setEditableScenario(prev => ({
        ...prev,
        patientProfile: { ...prev.patientProfile, age: newAge }
      }));
    }
    lastKnownAgeRef.current = newAge;
  };

  const handleTempAgeChange = (newAge: string | number) => {
    if (!tempDocScenario) return;
    const oldAge = tempDocScenario.patientProfile.age;
    if (oldAge && newAge && oldAge !== newAge) {
      setTempDocScenario(prev => prev ? ({
        ...prev,
        description: updateAgeInText(prev.description, oldAge, newAge),
        patientProfile: {
          ...prev.patientProfile,
          age: newAge,
          medicalHistory: updateAgeInText(prev.patientProfile.medicalHistory, oldAge, newAge),
          currentSymptoms: updateAgeInText(prev.patientProfile.currentSymptoms, oldAge, newAge)
        }
      }) : null);
    } else {
      setTempDocScenario(prev => prev ? ({
        ...prev,
        patientProfile: { ...prev.patientProfile, age: newAge }
      }) : null);
    }
  };

  const [race, setRace] = useState(RACES[0]);
  const [religion, setReligion] = useState(RELIGIONS[0]);
  const [selectedRole, setSelectedRole] = useState<AvatarRole>('Patient');
  const [selectedCaregiverSubRole, setSelectedCaregiverSubRole] = useState<CaregiverSubRole>('Nurse');
  const [selectedEmotion, setSelectedEmotion] = useState<Emotion>(Emotion.STABLE);
  const [selectedVisualMode, setSelectedVisualMode] = useState<VisualMode>('Static');
  const [appearanceNotes, setAppearanceNotes] = useState('');

  const [selectedVoiceProfileId, setSelectedVoiceProfileId] = useState<string>(VOICE_PROFILES[0].id);
  const [selectedAccent, setSelectedAccent] = useState<Accent>('General American');
  const [selectedCommStyle, setSelectedCommStyle] = useState<CommunicationStyle>('Succinct');
  const [selectedCognitiveTraits, setSelectedCognitiveTraits] = useState<CognitiveTrait[]>([]);
  const [showCognitiveDropdown, setShowCognitiveDropdown] = useState(false);
  const [vocalizationNotes, setVocalizationNotes] = useState('');

  const [isParsingScenario, setIsParsingScenario] = useState(false);
  const [isGeneratingIdentity, setIsGeneratingIdentity] = useState(false);
  const [skipNextIdentityGen, setSkipNextIdentityGen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [showSpecialtyModal, setShowSpecialtyModal] = useState(false);
  const [showArchiveDrawer, setShowArchiveDrawer] = useState(false);
  const [showEvidenceBase, setShowEvidenceBase] = useState(false);
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [docModalScenario, setDocModalScenario] = useState<Scenario | null>(null);
  const [isEditingDoc, setIsEditingDoc] = useState(false);
  const [tempDocScenario, setTempDocScenario] = useState<Scenario | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{ name: string; content: string } | null>(null);
  const [showDocContent, setShowDocContent] = useState(false);

  const handlePrint = () => {
    try {
      window.print();
    } catch (error) {
      console.error('Print failed:', error);
      setNotification({ message: 'Printing failed. Please try opening in a new tab.', type: 'error' });
    }
  };

  const handleDownloadPDF = () => {
    if (!docModalScenario) return;
    const doc = new jsPDF();
    const scenario = docModalScenario;
    
    // Helper to add a new page if needed
    const checkPageOverflow = (currentY: number, needed: number) => {
      if (currentY + needed > 280) {
        doc.addPage();
        return 20;
      }
      return currentY;
    };

    // Header
    doc.setFillColor(79, 70, 229); // Indigo 600
    doc.rect(0, 0, 210, 40, 'F');
    
    doc.setFontSize(24);
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.text(scenario.title.toUpperCase(), 20, 25);
    
    doc.setFontSize(10);
    doc.setTextColor(200, 200, 255);
    doc.setFont("helvetica", "normal");
    doc.text("SIMVERITAS SCENARIO DOCUMENTATION", 20, 33);
    
    let y = 50;

    // Description Section
    doc.setFontSize(14);
    doc.setTextColor(79, 70, 229);
    doc.setFont("helvetica", "bold");
    doc.text("SCENARIO DESCRIPTION", 20, y);
    y += 8;
    
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    doc.setFont("helvetica", "normal");
    const splitDescription = doc.splitTextToSize(scenario.description, 170);
    splitDescription.forEach((line: string) => {
      y = checkPageOverflow(y, 5);
      doc.text(line, 20, y);
      y += 5;
    });
    
    y += 10;

    // Patient Profile Section
    y = checkPageOverflow(y, 40);
    doc.setFontSize(14);
    doc.setTextColor(79, 70, 229);
    doc.setFont("helvetica", "bold");
    doc.text("PATIENT PROFILE", 20, y);
    y += 8;

    autoTable(doc, {
      startY: y,
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 2 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } },
      body: [
        ['Name', scenario.patientProfile.name],
        ['Age / Sex', `${formatAge(scenario.patientProfile.age)} / ${scenario.patientProfile.gender}`],
        ['Medical History', scenario.patientProfile.medicalHistory],
        ['Current Symptoms', scenario.patientProfile.currentSymptoms]
      ],
      margin: { left: 20 },
    });
    
    // @ts-ignore
    y = (doc as any).lastAutoTable.finalY + 15;

    // Learning Objectives Section
    y = checkPageOverflow(y, 30);
    doc.setFontSize(14);
    doc.setTextColor(79, 70, 229);
    doc.setFont("helvetica", "bold");
    doc.text("LEARNING OBJECTIVES", 20, y);
    y += 8;

    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    doc.setFont("helvetica", "normal");
    scenario.learningObjectives.forEach((obj) => {
      const splitObj = doc.splitTextToSize(`• ${obj}`, 165);
      y = checkPageOverflow(y, splitObj.length * 5);
      doc.text(splitObj, 25, y);
      y += (splitObj.length * 5) + 2;
    });

    y += 10;

    // Simulation Phases Section
    if (scenario.phases && scenario.phases.length > 0) {
      y = checkPageOverflow(y, 20);
      doc.setFontSize(14);
      doc.setTextColor(79, 70, 229);
      doc.setFont("helvetica", "bold");
      doc.text("SIMULATION PHASES", 20, y);
      y += 10;

      scenario.phases.forEach((phase, index) => {
        y = checkPageOverflow(y, 60);
        
        // Phase Header
        doc.setFillColor(243, 244, 246); // Gray 100
        doc.rect(20, y - 5, 170, 8, 'F');
        doc.setFontSize(11);
        doc.setTextColor(31, 41, 55); // Gray 800
        doc.setFont("helvetica", "bold");
        doc.text(`PHASE ${index + 1}: ${phase.label.toUpperCase()}`, 25, y);
        y += 10;

        // Phase Details Table
        autoTable(doc, {
          startY: y,
          theme: 'grid',
          styles: { fontSize: 9, cellPadding: 3 },
          headStyles: { fillColor: [79, 70, 229], textColor: 255 },
          columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } },
          body: [
            ['Trigger Condition', phase.triggerCondition],
            ['Patient State', `Symptoms: ${phase.patientState.symptoms}\nEmotion: ${phase.patientState.emotion}\nVitals: ${phase.patientState.vitalsTrend}`],
            ['Expected Actions', phase.expectedLearnerActions.join('\n')],
          ],
          margin: { left: 20 },
        });

        // @ts-ignore
        y = doc.lastAutoTable.finalY + 5;

        // Escalation Triggers for this phase
        if (phase.escalationTriggers && phase.escalationTriggers.length > 0) {
          autoTable(doc, {
            startY: y,
            theme: 'striped',
            styles: { fontSize: 8, cellPadding: 2 },
            head: [['If Learner Does...', 'Patient Response', 'If Learner Fails...', 'Patient Deteriorates']],
            headStyles: { fillColor: [239, 68, 68], textColor: 255 }, // Red 500 for escalation
            body: phase.escalationTriggers.map(t => [
              t.ifLearnerDoes,
              t.thenPatientResponse,
              t.ifLearnerFails,
              t.thenPatientDeteriorates
            ]),
            margin: { left: 25 },
            tableWidth: 160
          });
          // @ts-ignore
          y = doc.lastAutoTable.finalY + 15;
        } else {
          y += 10;
        }
      });
    }

    // Facilitator Notes Section
    y = checkPageOverflow(y, 60);
    doc.setFontSize(14);
    doc.setTextColor(79, 70, 229);
    doc.setFont("helvetica", "bold");
    doc.text("FACILITATOR NOTES", 20, y);
    y += 8;

    try {
      // @ts-ignore
      doc.rect(20, y, 170, 40);
      // @ts-ignore
      doc.addField('notes', 'Type your notes here...', 20, y, 170, 40);
    } catch (e) {
      doc.setDrawColor(200, 200, 200);
      doc.rect(20, y, 170, 40);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text("Interactive field not supported - use this space for handwritten notes.", 25, y + 5);
    }

    y += 50;

    // Source Document Author Section
    if (scenario.sourceAuthors) {
      y = checkPageOverflow(y, 30);
      doc.setFontSize(14);
      doc.setTextColor(79, 70, 229);
      doc.setFont("helvetica", "bold");
      doc.text("SOURCE DOCUMENT AUTHOR", 20, y);
      y += 8;

      doc.setFontSize(10);
      doc.setTextColor(60, 60, 60);
      doc.setFont("helvetica", "normal");
      const splitAuthors = doc.splitTextToSize(scenario.sourceAuthors, 170);
      splitAuthors.forEach((line: string) => {
        y = checkPageOverflow(y, 5);
        doc.text(line, 20, y);
        y += 5;
      });
    }

    // Footer
    const pageCount = (doc as any).internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(`SimVeritas Clinical Simulation Platform - Page ${i} of ${pageCount}`, 105, 290, { align: 'center' });
    }

    doc.save(`${scenario.title.replace(/\s+/g, '_')}_Documentation.pdf`);
  };

  const handleAddPhase = () => {
    if (!tempDocScenario) return;
    const newPhase: ScenarioPhase = {
      id: crypto.randomUUID(),
      label: `Phase ${tempDocScenario.phases.length + 1}`,
      durationHint: 5,
      triggerCondition: 'Manual Transition',
      patientState: {
        vitalsTrend: 'Stable',
        emotion: 'Neutral' as Emotion,
        symptoms: 'No change'
      },
      expectedLearnerActions: ['Assess patient'],
      escalationTriggers: []
    };
    setTempDocScenario({
      ...tempDocScenario,
      phases: [...tempDocScenario.phases, newPhase]
    });
  };

  const handleRemovePhase = (idx: number) => {
    if (!tempDocScenario) return;
    const newPhases = [...tempDocScenario.phases];
    newPhases.splice(idx, 1);
    setTempDocScenario({
      ...tempDocScenario,
      phases: newPhases
    });
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const newImages: string[] = [];
    let processed = 0;

    Array.from(files).forEach((file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target?.result as string;
        if (base64) newImages.push(base64);
        processed++;
        
        if (processed === files.length) {
          if (isEditingDoc) {
            setTempDocScenario(prev => {
              if (!prev) return null;
              return {
                ...prev,
                attachedImages: [...(prev.attachedImages || []), ...newImages]
              };
            });
          } else {
            setEditableScenario(prev => ({
              ...prev,
              attachedImages: [...(prev.attachedImages || []), ...newImages]
            }));
          }
        }
      };
      reader.readAsDataURL(file);
    });
    
    if (event.target) event.target.value = '';
  };

  const handleClinicalDocUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const newDocs: { name: string; content: string }[] = [];
    
    const fileList = Array.from(files) as File[];
    for (const file of fileList) {
      try {
        const { text } = await extractDataFromFile(file);
        if (text) {
          newDocs.push({ name: file.name, content: text });
        }
      } catch (error) {
        console.error('Error extracting text from clinical doc:', error);
        setNotification({ message: `Failed to process ${file.name}`, type: 'error' });
      }
    }

    if (newDocs.length > 0) {
      if (isEditingDoc) {
        setTempDocScenario(prev => {
          if (!prev) return null;
          return {
            ...prev,
            attachedDocs: [...(prev.attachedDocs || []), ...newDocs]
          };
        });
      } else {
        setEditableScenario(prev => ({
          ...prev,
          attachedDocs: [...(prev.attachedDocs || []), ...newDocs]
        }));
      }
      setNotification({ message: `${newDocs.length} clinical document(s) attached`, type: 'success' });
    }

    if (event.target) event.target.value = '';
  };

  const removeAttachedImage = (index: number) => {
    if (isEditingDoc) {
      setTempDocScenario(prev => {
        if (!prev) return null;
        const newImages = [...(prev.attachedImages || [])];
        newImages.splice(index, 1);
        return { ...prev, attachedImages: newImages };
      });
    } else {
      setEditableScenario(prev => {
        const newImages = [...(prev.attachedImages || [])];
        newImages.splice(index, 1);
        return { ...prev, attachedImages: newImages };
      });
    }
  };

  const removeAttachedDoc = (index: number) => {
    if (isEditingDoc) {
      setTempDocScenario(prev => {
        if (!prev) return null;
        const newDocs = [...(prev.attachedDocs || [])];
        newDocs.splice(index, 1);
        return { ...prev, attachedDocs: newDocs };
      });
    } else {
      setEditableScenario(prev => {
        const newDocs = [...(prev.attachedDocs || [])];
        newDocs.splice(index, 1);
        return { ...prev, attachedDocs: newDocs };
      });
    }
  };

  const handleSaveDocChanges = () => {
    if (tempDocScenario) {
      onSaveScenario(tempDocScenario);
      setDocModalScenario(tempDocScenario);
      setIsEditingDoc(false);
      setNotification({ message: 'Scenario updated successfully', type: 'success' });
    }
  };

  useImperativeHandle(ref, () => ({
    openArchive: () => setShowArchiveDrawer(true)
  }));
  
  const docInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const caseMediaImageInputRef = useRef<HTMLInputElement>(null);
  const knowledgeInputRef = useRef<HTMLInputElement>(null);
  const clinicalDocInputRef = useRef<HTMLInputElement>(null);
  const debriefInputRef = useRef<HTMLInputElement>(null);
  const lastGeneratedParamsRef = useRef<string>('');

  const allScenarios = useMemo(() => {
    const base = [...DEFAULT_SCENARIOS, ...customScenarios];
    if (bufferScenario) return [bufferScenario, ...base];
    return base;
  }, [customScenarios, bufferScenario]);
  
  const filteredScenarios = useMemo(() => {
    return allScenarios.filter(s => {
      const query = searchQuery.toLowerCase();
      const matchesText = s.title.toLowerCase().includes(query) || 
                         s.description.toLowerCase().includes(query) ||
                         s.patientProfile.currentSymptoms.toLowerCase().includes(query) ||
                         s.patientProfile.medicalHistory.toLowerCase().includes(query);
      
      const matchesSpecialtyDirect = s.specialties.some(spec => spec.toLowerCase().includes(query));
      
      const keywordCategories: Record<string, Specialty[]> = {
        'heart': ['Cardiology', 'Emergency Medicine', 'Surgery'],
        'chest': ['Cardiology', 'Emergency Medicine'],
        'brain': ['Neurology', 'Psychiatry', 'Surgery'],
        'nerve': ['Neurology'],
        'child': ['Pediatrics'],
        'baby': ['Pediatrics'],
        'accident': ['Emergency Medicine', 'Surgery'],
        'injury': ['Emergency Medicine', 'Surgery'],
        'cancer': ['Surgery', 'General Medicine'],
        'fever': ['General Medicine', 'Infectious Disease', 'Pediatrics'],
        'virus': ['Infectious Disease', 'General Medicine']
      };

      const matchesKeywordCategory = Object.entries(keywordCategories).some(([key, specialties]) => 
        query.includes(key) && specialties.some(spec => s.specialties.includes(spec))
      );

      const matchesSearch = matchesText || matchesSpecialtyDirect || matchesKeywordCategory;
      const matchesSpecialtyFilter = activeSpecialtyFilter === 'All' || s.specialties.includes(activeSpecialtyFilter);
      
      return matchesSearch && matchesSpecialtyFilter;
    });
  }, [allScenarios, searchQuery, activeSpecialtyFilter]);

  const safeLocalStorageSetItem = useCallback((key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (e: any) {
      if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        console.warn(`[Dashboard] LocalStorage quota exceeded for key: ${key}. Attempting cleanup...`);
        
        // Signal to App.tsx to show the UI banner
        const ch = new BroadcastChannel('simveritas-app-sync');
        ch.postMessage({ type: 'LOCAL_STORAGE_QUOTA_EXCEEDED' });
        ch.close();

        // Cleanup strategy: Remove all keys starting with 'sim_' or 'simveritas_'
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('sim_') || k.startsWith('simveritas_'))) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        
        // Try again after cleanup
        try {
          localStorage.setItem(key, value);
        } catch (retryErr) {
          console.error(`[Dashboard] LocalStorage quota still exceeded after cleanup for key: ${key}`, retryErr);
        }
      } else {
        console.error(`[Dashboard] LocalStorage error for key: ${key}`, e);
      }
    }
  }, []);

  // Persist debrief foundations to local storage
  useEffect(() => {
    safeLocalStorageSetItem('medsim_debrief_foundations_v1', JSON.stringify(debriefDocs));
  }, [debriefDocs, safeLocalStorageSetItem]);

  // Sync scenario data when selection changes
  useEffect(() => {
    const found = allScenarios.find(s => s.id === selectedScenarioId);
    if (found) {
      // Use functional updates or check for changes to avoid redundant renders
      setEditableScenario(prev => {
        // Allow updates if IDs differ, or if it's the buffer scenario (which can change content with same ID)
        if (prev.id === found.id && prev.title === found.title && !prev.isCustom && prev.id !== 'buffer') return prev;
        return { ...found };
      });
      
      setLiveHistory(found.patientProfile.medicalHistory);
      setLiveSymptoms(found.patientProfile.currentSymptoms);
      
      if (found.patientProfile.race) setRace(prev => prev === found.patientProfile.race ? prev : found.patientProfile.race);
      if (found.patientProfile.religion) setReligion(prev => prev === found.patientProfile.religion ? prev : found.patientProfile.religion);
      
      setFacilitatorInstructions(prev => prev === (found.facilitatorInstructions || '') ? prev : (found.facilitatorInstructions || ''));
      
      if (found.debriefKnowledgeBase) {
        setDebriefDocs(prev => {
          if (prev.length === 1 && prev[0].digest === found.debriefKnowledgeBase) return prev;
          return [{ name: 'Scenario Knowledge Base', digest: found.debriefKnowledgeBase }];
        });
      } else {
        setDebriefDocs(prev => prev.length === 0 ? prev : []);
      }
      
      if (found.knowledgeBase) {
        setKnowledgeDocs(prev => {
          if (prev.length === 1 && prev[0].digest === found.knowledgeBase) return prev;
          return [{ name: 'Scenario Foundations', digest: found.knowledgeBase }];
        });
      } else {
        setKnowledgeDocs(prev => prev.length === 0 ? prev : []);
      }
    }
  }, [selectedScenarioId, allScenarios]);

  const filteredVoices = useMemo(() => {
    const numericAge = getNumericAge(avatarAge);
    const genderMatches = VOICE_PROFILES.filter(vp => vp.gender === selectedGender);
    
    // Primary filter: exact age range match
    const exactMatches = genderMatches.filter(vp => 
      numericAge >= vp.minAge && numericAge <= vp.maxAge
    );
    if (exactMatches.length > 0) return exactMatches;
    
    // Fallback: if no exact match (e.g., very young infant stored as decimal < 1),
    // find the profile whose range is closest to the given age
    const closest = genderMatches.reduce((best, vp) => {
      const distBest = Math.min(Math.abs(numericAge - best.minAge), Math.abs(numericAge - best.maxAge));
      const distThis = Math.min(Math.abs(numericAge - vp.minAge), Math.abs(numericAge - vp.maxAge));
      return distThis < distBest ? vp : best;
    }, genderMatches[0]);
    
    return closest ? [closest] : genderMatches;
  }, [selectedGender, avatarAge]);

  // Auto-select: always pick best age-appropriate profile when age/gender changes
  useEffect(() => {
    if (filteredVoices.length === 0) return;
    const currentProfile = filteredVoices.find(v => v.id === selectedVoiceProfileId);
    // Re-select if current profile is no longer in the filtered list
    // Prefer the first match (profiles are ordered youngest-first per gender above)
    if (!currentProfile) {
      setSelectedVoiceProfileId(filteredVoices[0].id);
    }
  }, [filteredVoices]);

  useEffect(() => {
    const params = `${race}|${religion}|${selectedGender}|${avatarAge}`;
    if (params === lastGeneratedParamsRef.current) return;
    
    const timer = setTimeout(() => {
      lastGeneratedParamsRef.current = params;
      generateCulturallyAppropriateIdentity();
    }, 800);
    return () => clearTimeout(timer);
  }, [race, religion, selectedGender, avatarAge]);

  const generateCulturallyAppropriateIdentity = async () => {
    if (skipNextIdentityGen) {
      setSkipNextIdentityGen(false);
      return;
    }
    setIsGeneratingIdentity(true);
    const maxRetries = 3;
    let attempt = 0;

    const execute = async () => {
      try {
        const apiKey = await getApiKey();
        if (!apiKey) throw new Error("API Key not found");
        const ai = new GoogleGenAI({ apiKey });
        const prompt = `Generate a culturally appropriate, realistic, and professional full name for a medical scenario participant. 
        Race: ${race}
        Religion: ${religion}
        Gender: ${selectedGender}
        Age: ${avatarAge}
        Respond with ONLY a JSON object: {"name": "First Last"}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite-preview',
          contents: [{ parts: [{ text: prompt }] }],
          config: { 
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING }
              },
              required: ['name']
            }
          }
        });
        const data = JSON.parse(response.text || '{"name": "Anonymous"}');
        if (data.name) {
          setEditableScenario(prev => ({
            ...prev,
            patientProfile: { ...prev.patientProfile, name: data.name }
          }));
        } else {
          throw new Error("Invalid response format");
        }
      } catch (e: any) {
        const errStr = e?.toString() || "";
        const errMessage = e?.message || "";
        const errStatus = e?.status || e?.error?.code || e?.code;
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
        
        if (isRetryable && attempt < 5) {
          attempt++;
          const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);
          await new Promise(resolve => setTimeout(resolve, delay));
          return execute();
        }

        console.warn("Identity synthesis failed, applying fallback logic...", e);
        if (e?.toString().includes("entity was not found") && (window as any).aistudio) {
          (window as any).aistudio.openSelectKey();
        }
        // Fallback logic for 503 errors or connectivity issues
        const raceGroup = FALLBACK_IDENTITY_MAP[race] || FALLBACK_IDENTITY_MAP['Caucasian'];
        const nameList = raceGroup[selectedGender] || raceGroup['male'];
        const fallbackName = nameList[Math.floor(Math.random() * nameList.length)];
        
        setEditableScenario(prev => ({
          ...prev,
          patientProfile: { ...prev.patientProfile, name: fallbackName }
        }));
      }
    };

    await execute();
    setIsGeneratingIdentity(false);
  };

  const handleCommitToRegistry = () => {
    setIsSaving(true);
    const updatedScenario: Scenario = {
      ...editableScenario,
      id: editableScenario.id === 'buffer' || !editableScenario.isCustom ? `registry-${Date.now()}` : editableScenario.id,
      isCustom: true,
      facilitatorInstructions,
      debriefKnowledgeBase: debriefDocs.map(d => d.digest).join('\n\n'),
      knowledgeBase: knowledgeDocs.map(d => d.digest).join('\n\n'),
      patientProfile: {
        ...editableScenario.patientProfile,
        medicalHistory: liveHistory,
        currentSymptoms: liveSymptoms,
        // Only overwrite patient age with avatar age if the avatar IS the patient
        age: selectedRole === 'Patient' ? avatarAge : editableScenario.patientProfile.age,
        gender: selectedGender.charAt(0).toUpperCase() + selectedGender.slice(1)
      }
    };
    onSaveScenario(updatedScenario);
    setSelectedScenarioId(updatedScenario.id);
    setTimeout(() => setIsSaving(false), 800);
  };

  const handleCommitClick = () => {
    if (!editableScenario.specialties || editableScenario.specialties.length === 0) {
      setShowSpecialtyModal(true);
    } else {
      handleCommitToRegistry();
    }
  };

  const extractDataFromFile = async (file: File): Promise<{ text: string, images: { data: string, mimeType: string }[] }> => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    const images: { data: string, mimeType: string }[] = [];
    let text = "";

    console.log(`Extracting data from .${extension} file: ${file.name} (${file.size} bytes)`);
    
    if (file.size === 0) {
      throw new Error(`The file "${file.name}" is empty (0 bytes).`);
    }

    try {
      if (extension === 'pdf') {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = getDocument({ 
          data: arrayBuffer,
          standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${version}/standard_fonts/`
        });
        const pdf = await loadingTask.promise;
        console.log(`PDF loaded: ${pdf.numPages} pages.`);
        
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          
          // Extract text
          const textContentObj = await page.getTextContent();
          const pageText = textContentObj.items
            .map((item: any) => (item as { str?: string }).str || '')
            .join(' ');
          fullText += pageText + '\n';

          // Render page to capture visuals (X-rays, charts, etc.)
          // Limit to first 5 pages to avoid payload issues
          if (i <= 5) {
            const viewport = page.getViewport({ scale: 1.0 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (context) {
              canvas.height = viewport.height;
              canvas.width = viewport.width;
              await page.render({ canvasContext: context, viewport } as any).promise;
              const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
              const base64Data = dataUrl.split(',')[1];
              
              // Only add if not too large (approx 200KB per image)
              if (base64Data.length < 300000) {
                images.push({ data: base64Data, mimeType: 'image/jpeg' });
              }
            }
          }
        }
        text = fullText;
      } else if (extension === 'docx') {
        const arrayBuffer = await file.arrayBuffer();
        const m = mammoth as any;
        
        // Extract text
        const textResult = await m.extractRawText({ arrayBuffer });
        text = textResult.value;

        // Extract images
        await m.convertToHtml({ arrayBuffer }, {
          convertImage: m.images.imgElement((image: any) => {
            return image.read("base64").then((imageBuffer: any) => {
              images.push({
                data: imageBuffer,
                mimeType: image.contentType
              });
              return { src: "" };
            });
          })
        });
      } else {
        text = await file.text();
      }
      return { text, images };
    } catch (err: any) {
      console.error(`Extraction error for .${extension}:`, err);
      throw new Error(`Failed to extract data from ${file.name}: ${err.message || "Unknown error"}`);
    }
  };

  const handleDocumentUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    console.log("handleDocumentUpload triggered");
    const file = event.target.files?.[0];
    if (!file) return;
    setIsParsingScenario(true);
    
    const maxRetries = 3;
    let attempt = 0;

    const execute = async () => {
      const modelsToTry = ['gemini-3.1-flash-lite-preview', 'gemini-3.1-pro-preview', 'gemini-flash-latest'];
      const currentModel = modelsToTry[Math.min(attempt, modelsToTry.length - 1)];
      
      try {
        console.log(`Starting clinical case parsing for file: ${file.name} using model: ${currentModel}`);
        const extension = file.name.split('.').pop()?.toLowerCase();
        if (extension !== 'docx' && extension !== 'txt' && extension !== 'pdf') {
          throw new Error(`Unsupported file type: .${extension}. Please upload a .docx, .pdf, or .txt file.`);
        }

        const apiKey = await getApiKey();
        if (!apiKey) {
          throw new Error("API Key not found. Please select an API key to enable clinical synthesis.");
        }
        
        let ai;
        try {
          ai = new GoogleGenAI({ apiKey });
        } catch (initErr: any) {
          console.error("Failed to initialize GoogleGenAI:", initErr);
          throw new Error(`Failed to initialize AI engine: ${initErr.message || initErr.toString()}`);
        }

        const { text: textContent, images: extractedImages } = await extractDataFromFile(file);
        
        if (!textContent || !textContent.trim()) {
          throw new Error(`The uploaded file "${file.name}" appears to be empty or contains no extractable text. If this is a scanned PDF, please ensure it has been OCR-processed.`);
        }

        console.log(`Sending case data (${textContent.length} chars, ${extractedImages.length} images) to ${currentModel} for synthesis...`);
        // Truncate text to avoid token limits while keeping essential clinical data
        const truncatedText = textContent.slice(0, 15000);
        
        const parts: any[] = [{ text: `Clinical case data: ${truncatedText}` }];
        
        // Add extracted images to the prompt so the AI can see them and match them
        extractedImages.forEach((img, idx) => {
          parts.push({
            inlineData: {
              data: img.data,
              mimeType: img.mimeType
            }
          });
          parts.push({ text: `[Extracted Image ${idx}]` });
        });

        const response = await ai.models.generateContent({
          model: currentModel,
          contents: [{ parts }],
          config: { 
            maxOutputTokens: 8192,
            systemInstruction: `You are a clinical case synthesizer. Parse the provided clinical data into a structured JSON format. 
            Detect all relevant medical specialties from this list: [General Medicine, Cardiology, Pediatrics, Emergency Medicine, Neurology, Psychiatry, Surgery, OB/GYN, Geriatrics, Infectious Disease].
            Ensure the patientProfile contains realistic medical history and symptoms extracted from the text. 
            Maintain the original day, week, month, year format for medical history and current symptoms; do not convert them to decimals there.
            However, for the 'age' field in patientProfile, if the age is in days, weeks, or months, provide it as a decimal representing years (e.g., '3 days' should be '0.0082', '2 months' should be '0.166'). 
            If the age is in years, provide it as a string number (e.g., '32').
            If a patient name is mentioned in the text, use it. If not, leave it as an empty string or 'Unknown'.
            
            SCENARIO PROGRESSION:
            Extract or synthesize a logical progression for the scenario into as many distinct phases as needed to represent the case accurately (limit to 5-7 phases maximum).
            Each phase must have:
            - A clear label (e.g., 'Initial Assessment', 'Acute Deterioration').
            - A trigger condition (what causes the phase to start).
            - A duration hint in minutes.
            - A patient state (symptoms, emotion, and vitals trend). Use one of these emotions: [Stable & Calm, Mildly Concerned, Fatigued/Tired, Apprehensive, Slightly Uncomfortable, Mildly Skeptical, Clinically Distressed, Cooperative].
            - Expected learner actions.
            - Escalation triggers (if the learner does X, then Y happens; if they fail to do Z, then deterioration occurs).
            
            CLINICAL ASSETS & MEDIA:
            Identify any clinical reports, labs, imaging, EKGs, or media mentioned in the case.
            You will be provided with a list of images extracted from the document (labeled [Extracted Image 0], [Extracted Image 1], etc.).
            - For each 'attachedImage', if it corresponds to one of the provided images, specify its index (0-based) in the 'imageIndex' field.
            - If an imaging finding is mentioned but no corresponding image was provided, set 'imageIndex' to -1.
            - For textual reports, lab results, or reference documents (e.g., 'Complete Blood Count', 'Discharge Summary', 'Pathology Report'), provide a 'name' and 'content' summary in 'attachedDocs'.
            - Ensure that any clinical data mentioned as a 'report' or 'result' is captured here. If a report is mentioned but no specific values are provided, still include it in 'attachedDocs' with a summary of its mention.
            
            SOURCE AUTHORS:
            Identify the original authors, creators, institutions, or references mentioned in the text as the source of this clinical case. 
            Look for keywords such as 'Author', 'Creator', 'Written by', 'Prepared by', 'Source', 'Reference', 'Contributor', 'Developed by', 'Case by', 'Case study by', 'Clinical case by', 'By:', 'From:', 'Origin:', 'Institution:', or similar terms that indicate who developed the case.
            Check the very beginning and very end of the document, as well as any headers or footers mentioned in the text.
            Include the full names of individuals or institutions found. If multiple authors are listed, include all of them separated by commas.
            If no author is found, leave it as an empty string.`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                specialties: { type: Type.ARRAY, items: { type: Type.STRING } },
                patientProfile: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    age: { type: Type.STRING },
                    gender: { type: Type.STRING },
                    medicalHistory: { type: Type.STRING },
                    currentSymptoms: { type: Type.STRING }
                  },
                  required: ['name', 'age', 'gender', 'medicalHistory', 'currentSymptoms']
                },
                learningObjectives: { type: Type.ARRAY, items: { type: Type.STRING } },
                sourceAuthors: { type: Type.STRING },
                attachedImages: { 
                  type: Type.ARRAY, 
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      imageIndex: { type: Type.INTEGER }
                    },
                    required: ['title', 'imageIndex']
                  },
                  description: "Imaging or visual findings matched to extracted images."
                },
                attachedDocs: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      content: { type: Type.STRING }
                    },
                    required: ['name', 'content']
                  }
                },
                phases: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      label: { type: Type.STRING },
                      triggerCondition: { type: Type.STRING },
                      durationHint: { type: Type.NUMBER },
                      patientState: {
                        type: Type.OBJECT,
                        properties: {
                          symptoms: { type: Type.STRING },
                          emotion: { type: Type.STRING },
                          vitalsTrend: { type: Type.STRING }
                        },
                        required: ['symptoms', 'emotion', 'vitalsTrend']
                      },
                      expectedLearnerActions: { type: Type.ARRAY, items: { type: Type.STRING } },
                      escalationTriggers: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            ifLearnerDoes: { type: Type.STRING },
                            thenPatientResponse: { type: Type.STRING },
                            ifLearnerFails: { type: Type.STRING },
                            thenPatientDeteriorates: { type: Type.STRING }
                          },
                          required: ['ifLearnerDoes', 'thenPatientResponse', 'ifLearnerFails', 'thenPatientDeteriorates']
                        }
                      }
                    },
                    required: ['id', 'label', 'triggerCondition', 'durationHint', 'patientState', 'expectedLearnerActions', 'escalationTriggers']
                  }
                }
              },
              required: ['title', 'description', 'specialties', 'patientProfile', 'learningObjectives', 'phases', 'sourceAuthors']
            }
          }
        });
;
        console.log("Case synthesis complete.");
        let rawText = response.text || '{}';
        
        let scenarioData;
        try {
          scenarioData = JSON.parse(rawText);
        } catch (parseErr) {
          console.error("Failed to parse AI response as JSON:", rawText);
          throw new Error("The AI generated an invalid response format. Please try again.");
        }
        
        // Process extracted images into real base64 URLs based on AI matching
        if (scenarioData.attachedImages && Array.isArray(scenarioData.attachedImages)) {
          scenarioData.attachedImages = scenarioData.attachedImages.map((imgInfo: any) => {
            if (typeof imgInfo === 'object' && imgInfo.imageIndex !== undefined && imgInfo.imageIndex >= 0 && imgInfo.imageIndex < extractedImages.length) {
              const img = extractedImages[imgInfo.imageIndex];
              return `data:${img.mimeType};base64,${img.data}`;
            }
            // Fallback to picsum if no index or invalid index
            const desc = typeof imgInfo === 'string' ? imgInfo : (imgInfo.title || 'Clinical Finding');
            const seed = desc.toLowerCase().replace(/[^a-z0-9]/g, '-');
            return `https://picsum.photos/seed/${seed}/800/600?blur=2`;
          });
        }

        // If the AI didn't find a name, we'll let the identity generator handle it later
        // But if it DID find a name, we want to keep it.
        if (scenarioData.patientProfile?.name && scenarioData.patientProfile.name !== 'Unknown' && scenarioData.patientProfile.name !== '') {
          setSkipNextIdentityGen(true);
        }

        const newBufferScenario = { ...scenarioData, id: 'buffer', isCustom: false };
        setBufferScenario(newBufferScenario);
        setEditableScenario(newBufferScenario);
        setSelectedScenarioId('buffer');
        setLiveHistory(newBufferScenario.patientProfile?.medicalHistory || '');
        setLiveSymptoms(newBufferScenario.patientProfile?.currentSymptoms || '');
        
        // Only sync avatar age if the role is Patient
        if (selectedRole === 'Patient') {
          setAvatarAge(newBufferScenario.patientProfile?.age || 32);
        }
        
        const scenarioGender = (newBufferScenario.patientProfile?.gender || 'male').toLowerCase();
        setSelectedGender(scenarioGender.includes('female') || scenarioGender === 'f' ? 'female' : 'male');
        
      } catch (e: any) { 
        const errStr = JSON.stringify(e) || e?.toString() || "";
        const errMessage = e?.message || "";
        const errStatus = e?.status || e?.error?.code || e?.code || (e?.error ? JSON.parse(JSON.stringify(e.error)).code : null);
        
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
                            errStr.includes("overloaded") ||
                            errStr.includes("deadline-exceeded") ||
                            errMessage.includes("Deadline exceeded") ||
                            errMessage.includes("max tokens") ||
                            errStr.includes("max tokens");
        
        if (isRetryable && attempt < 6) {
          attempt++;
          const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);
          console.warn(`Model ${currentModel} busy or limit reached (Attempt ${attempt}). Retrying in ${Math.round(delay)}ms...`);
          setNotification({ 
            message: `AI service is busy or limit reached (Attempt ${attempt}/6). Retrying in ${Math.round(delay/1000)}s...`,
            type: 'info'
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          return execute();
        }

        if (errMessage.includes("max tokens") || errStr.includes("max tokens")) {
          throw new Error("The clinical case is too complex for the current AI model to synthesize in one pass. Please try a simpler document or a different model.");
        }

        console.error("Scenario Import Error:", e);
        throw e;
      }
    };

    try {
      await execute();
    } catch (err: any) {
      console.error("Scenario Import Error:", err);
      const errStr = JSON.stringify(err) || err?.toString() || "";
      const errMessage = err?.message || "";
      
      const isKeyError = errStr.includes("entity was not found") || 
                         errMessage.includes("API Key not found") ||
                         errStr.includes("PERMISSION_DENIED") ||
                         errStr.includes("403");
      
      if (isKeyError && (window as any).aistudio) {
        onSelectKey();
      }

      let userFriendlyMessage = `Scenario parsing failed: ${err.message || "Unknown error"}.`;
      
      if (errStr.includes("quota") || errStr.includes("RESOURCE_EXHAUSTED")) {
        userFriendlyMessage = "AI synthesis quota exceeded. Please try again later or use a different API key.";
      } else if (errStr.includes("safety") || errMessage.includes("safety")) {
        userFriendlyMessage = "The document content triggered AI safety filters. Please ensure it contains only clinical/educational material.";
      } else if (errStr.includes("invalid-argument") || errStr.includes("400")) {
        userFriendlyMessage = "The document content was not recognized correctly. Please try a different file format (.txt is most reliable).";
      }

      setNotification({ 
        message: `${userFriendlyMessage} Ensure the document is not password protected and contains legible clinical text.`,
        type: 'error'
      });
    } finally {
      setIsParsingScenario(false); 
      if (event.target) event.target.value = '';
    }
  };

  const discardBuffer = () => {
    setBufferScenario(null);
    setSelectedScenarioId(DEFAULT_SCENARIOS[0].id);
  };

  const handleKnowledgeUpload = async (event: React.ChangeEvent<HTMLInputElement>, target: 'foundations' | 'debrief') => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const { text: digest } = await extractDataFromFile(file);
      if (!digest || !digest.trim()) {
        throw new Error(`The uploaded file "${file.name}" appears to be empty or contains no extractable text. If this is a scanned PDF, please ensure it has been OCR-processed.`);
      }
      
      const newDoc = { name: file.name, digest };
      target === 'foundations' ? setKnowledgeDocs(p => [...p, newDoc]) : setDebriefDocs(p => [...p, newDoc]);
    } catch (e: any) { 
      console.error("Knowledge upload error:", e);
      setNotification({ message: `Upload failed: ${e.message || e.toString()}`, type: 'error' });
    } finally {
      if (event.target) event.target.value = '';
    }
  };

  const toggleSpecialtyTag = (spec: Specialty) => {
    setEditableScenario(prev => {
      const current = prev.specialties || [];
      if (current.includes(spec)) {
        return { ...prev, specialties: current.filter(s => s !== spec) };
      } else {
        return { ...prev, specialties: [...current, spec] };
      }
    });
  };

  // Sync avatar age and gender with scenario when role is Patient or scenario changes
  useEffect(() => {
    if (selectedRole === 'Patient') {
      const targetAge = editableScenario.patientProfile.age || 32;
      if (avatarAge !== targetAge) setAvatarAge(targetAge);
      
      const g = editableScenario.patientProfile.gender.toLowerCase();
      if (g === 'male' || g === 'female') {
        if (selectedGender !== g) setSelectedGender(g as 'male' | 'female');
      }
    }
  }, [selectedRole, editableScenario.id, editableScenario.patientProfile.age, editableScenario.patientProfile.gender]);

  // Handle role-based age defaults
  useEffect(() => {
    const numericAge = getNumericAge(avatarAge);
    if (selectedRole === 'Parent' && numericAge < 18) {
      setAvatarAge(Math.max(30, numericAge + 20));
    } else if (selectedRole === 'Caregiver' && numericAge < 20) {
      setAvatarAge(28);
    }
  }, [selectedRole, avatarAge]);

  const handleStart = () => {
    console.log("Dashboard: handleStart triggered. Current editableScenario title:", editableScenario.title);
    const finalScenario: Scenario = {
      ...editableScenario,
      patientProfile: {
        ...editableScenario.patientProfile,
        medicalHistory: liveHistory,
        currentSymptoms: liveSymptoms,
        // Only overwrite patient age with avatar age if the avatar IS the patient
        age: selectedRole === 'Patient' ? avatarAge : editableScenario.patientProfile.age,
        gender: selectedGender.charAt(0).toUpperCase() + selectedGender.slice(1)
      }
    };

    console.log("Dashboard: Final scenario being sent to simulation:", finalScenario.title);

    const selectedVoiceProfile = VOICE_PROFILES.find(v => v.id === selectedVoiceProfileId) || VOICE_PROFILES[0];

    const config: SimulationConfig = {
      scenario: finalScenario,
      voice: selectedVoiceProfile.name,
      emotion: selectedEmotion,
      avatarRole: selectedRole,
      caregiverSubRole: selectedRole === 'Caregiver' ? selectedCaregiverSubRole : undefined,
      language: 'en-US',
      communicationStyle: selectedCommStyle,
      accent: selectedAccent,
      visualMode: selectedVisualMode,
      facilitatorInstructions,
      knowledgeBase: knowledgeDocs.map(d => d.digest).join('\n\n'),
      debriefKnowledgeBase: debriefDocs.map(d => d.digest).join('\n\n'),
      race,
      religion,
      avatarAge,
      gender: selectedGender,
      avatarAppearanceNotes: appearanceNotes,
      vocalizationNotes,
      cognitiveTraits: selectedCognitiveTraits
    };
    onStart(config);
  };

  return (
    <div id="dashboard-root" className="flex flex-col h-full bg-slate-950 overflow-hidden text-slate-100 font-sans">
      {/* Top Navigation Bar */}
      <nav id="dashboard-nav" className="h-20 border-b border-white/5 bg-slate-900/50 backdrop-blur-xl flex items-center justify-between px-8 shrink-0 z-50">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-2xl shadow-blue-500/20 border border-blue-400/30">
            <span className="text-xl font-black tracking-tighter">SV</span>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-black uppercase tracking-[0.3em] text-blue-400">SimVeritas</span>
              <span className="w-1 h-1 rounded-full bg-slate-700"></span>
              <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Command Center</span>
            </div>
            <h1 className="text-lg font-black text-white uppercase tracking-tighter leading-none">Clinical Simulation Registry</h1>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-8 mr-4">
            <div className="flex flex-col items-end">
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-1">Active Cases</span>
              <span className="text-sm font-black text-white">{(DEFAULT_SCENARIOS.length + customScenarios.length)}</span>
            </div>
            <div className="flex flex-col items-end border-l border-white/10 pl-8">
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-1">Completed Reports</span>
              <span className="text-sm font-black text-emerald-400">{savedReports.length}</span>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={onSelectKey}
              className={`p-3 rounded-xl transition-all active:scale-95 ${hasApiKey ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20 animate-pulse'}`}
              title={hasApiKey ? "Neural Link Active" : "Neural Link Required"}
            >
              <i className={`fas fa-${hasApiKey ? 'link' : 'link-slash'}`}></i>
            </button>
          </div>
        </div>
      </nav>

      {/* Notification Banner */}
      {notification && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[100] w-full max-w-xl animate-slide-down px-4">
          <div className={`p-4 rounded-2xl shadow-2xl border flex items-center justify-between gap-4 ${
            notification.type === 'error' ? 'bg-red-500/90 border-red-500/20 text-white' : 
            notification.type === 'success' ? 'bg-emerald-500/90 border-emerald-500/20 text-white' :
            'bg-blue-500/90 border-blue-500/20 text-white'
          } backdrop-blur-xl`}>
            <div className="flex items-center gap-3">
              <i className={`fas ${
                notification.type === 'error' ? 'fa-circle-exclamation' : 
                notification.type === 'success' ? 'fa-circle-check' : 
                'fa-circle-info'
              }`}></i>
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

      {/* Confirmation Modal */}
      {confirmAction && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-white/10 p-8 rounded-[2.5rem] shadow-2xl max-w-md w-full animate-scale-up">
            <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mb-6 mx-auto">
              <i className="fas fa-trash-can text-2xl text-red-500"></i>
            </div>
            <h3 className="text-xl font-black text-white text-center mb-2">Confirm Deletion</h3>
            <p className="text-slate-400 text-center mb-8">
              {confirmAction.type === 'scenario' 
                ? 'Are you sure you want to delete this case from the registry? This action cannot be undone.' 
                : 'Are you sure you want to delete this clinical report? This action cannot be undone.'}
            </p>
            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={() => setConfirmAction(null)}
                className="px-6 py-4 bg-white/5 hover:bg-white/10 text-white font-bold rounded-2xl transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  if (confirmAction.type === 'scenario') onDeleteScenario(confirmAction.id);
                  else onDeleteReport(confirmAction.id);
                  setConfirmAction(null);
                }}
                className="px-6 py-4 bg-red-500 hover:bg-red-600 text-white font-bold rounded-2xl transition-all shadow-lg shadow-red-500/20"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div id="dashboard-scroll-container" className="flex-1 overflow-y-auto custom-scrollbar p-3 md:p-6 pb-12 scroll-smooth">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6 max-w-[1600px] mx-auto">
          
          {/* Left Column: Case Registry (4/12) */}
          <div id="case-registry-column" className="lg:col-span-4 flex flex-col gap-4 md:gap-6">
            <section id="case-library-section" className="bg-slate-900/40 p-4 md:p-6 rounded-3xl border border-indigo-500/15 flex flex-col backdrop-blur-md">
            <div className="flex flex-col gap-4 border-b border-white/5 pb-4 mb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
                    <i className="fas fa-folder-tree text-lg"></i>
                  </div>
                  <div>
                    <h2 className="text-base font-black uppercase tracking-tight">Case Library</h2>
                    <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Registry Management</p>
                  </div>
                </div>
                  <div className="flex gap-2">
                   {selectedScenarioId === 'buffer' && (
                     <button 
                        onClick={discardBuffer}
                        className="px-5 py-3 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl text-[11px] font-black uppercase tracking-widest hover:bg-red-500 hover:text-white transition-all active:scale-95 min-h-[44px]"
                      >
                        Discard
                      </button>
                   )}

                  <button 
                    onClick={() => docInputRef.current?.click()} 
                    className="px-5 py-3 bg-indigo-500 text-white rounded-xl text-[11px] font-black uppercase tracking-widest hover:bg-indigo-400 transition-all flex items-center gap-2 shadow-lg shadow-indigo-500/20 active:scale-95 min-h-[44px]"
                  >
                    {isParsingScenario ? <i className="fas fa-spinner animate-spin"></i> : <i className="fas fa-file-import"></i>}
                    Import
                  </button>
                </div>
                <input ref={docInputRef} type="file" className="hidden" accept=".docx,.txt,.pdf" onChange={handleDocumentUpload} />
              </div>

              <div className="space-y-3">
                <div className="relative">
                  <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-[9px]"></i>
                  <input 
                    type="text" 
                    placeholder="Search registry..." 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-950/60 border border-white/5 rounded-xl pl-9 pr-3 py-2.5 text-[11px] text-slate-300 outline-none focus:border-indigo-500/50 transition-all font-medium"
                  />
                </div>
                <div className="flex flex-nowrap overflow-x-auto gap-2 pb-2 custom-scrollbar">
                  <button 
                    onClick={() => setActiveSpecialtyFilter('All')}
                    className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all ${activeSpecialtyFilter === 'All' ? 'bg-white text-black' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                  >
                    All
                  </button>
                  {SPECIALTIES.map(spec => (
                    <button 
                      key={spec}
                      onClick={() => setActiveSpecialtyFilter(spec)}
                      className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap ${activeSpecialtyFilter === spec ? 'bg-indigo-500 text-white' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                    >
                      {spec}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto pr-1 custom-scrollbar min-h-[300px] max-h-[500px]">
              {filteredScenarios.length > 0 ? filteredScenarios.map(s => (
                <div 
                  key={s.id} 
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedScenarioId(s.id)} 
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedScenarioId(s.id); }}
                  className={`w-full p-3 rounded-2xl text-left border-2 transition-all group relative overflow-hidden cursor-pointer ${selectedScenarioId === s.id ? (s.id === 'buffer' ? 'bg-amber-500/10 border-amber-500 shadow-xl' : 'bg-indigo-500/10 border-indigo-500 shadow-xl') : 'bg-slate-900/40 border-transparent hover:border-white/5'}`}
                >
                  <div className={`flex justify-between items-start ${selectedScenarioId === s.id ? 'mb-2' : 'mb-1.5'} relative z-10`}>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-3">
                        <h4 className={`text-[11px] font-black uppercase leading-tight ${selectedScenarioId === s.id ? (s.id === 'buffer' ? 'text-amber-300' : 'text-indigo-300') : 'text-slate-200'}`}>{s.title}</h4>
                        {s.isCustom && <span className="text-[8px] font-black text-emerald-500 border border-emerald-500/30 px-2 py-0.5 rounded-full uppercase tracking-tighter">Registry</span>}
                        {s.id === 'buffer' && <span className="text-[8px] font-black text-amber-500 border border-amber-500/30 px-2 py-0.5 rounded-full uppercase tracking-tighter animate-pulse">Unsaved Upload</span>}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {s.specialties.map(spec => (
                          <span key={spec} className={`px-1.5 py-0.5 rounded-md text-[7px] font-black uppercase tracking-widest text-white shadow-sm ${SPECIALTY_COLORS[spec] || 'bg-slate-700'}`}>
                            {spec}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                       <button 
                         onClick={(e) => {
                           e.stopPropagation();
                           setDocModalScenario(s);
                           setDocModalOpen(true);
                         }}
                         className="p-2 text-slate-500 hover:text-indigo-400 transition-colors"
                         title="View scenario details"
                       >
                         <i className="fas fa-file-lines text-xs"></i>
                       </button>
                       {s.isCustom && (
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmAction({ id: s.id, type: 'scenario' });
                          }}
                          className="p-2 text-slate-500 hover:text-red-500 transition-colors"
                          title="Delete case"
                        >
                          <i className="fas fa-trash-can text-xs"></i>
                        </button>
                      )}
                    </div>
                  </div>
                  {selectedScenarioId === s.id && <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed font-medium relative z-10">{s.description}</p>}
                  {selectedScenarioId === s.id && <div className="absolute right-0 bottom-0 p-3 opacity-20"><i className="fas fa-check-circle text-5xl text-indigo-500"></i></div>}
                </div>
              )) : (
                <div className="flex flex-col items-center justify-center py-24 opacity-20">
                  <i className="fas fa-magnifying-glass text-5xl mb-6"></i>
                  <p className="text-[10px] font-black uppercase tracking-widest">No Matches In Registry</p>
                </div>
              )}
            </div>
          </section>
        </div>

          {/* Middle Column: Clinical Synthesis (8/12) */}
          <div id="clinical-synthesis-column" className="lg:col-span-8 flex flex-col gap-4 md:gap-6 relative">
            <section id="encounter-parameters-section" className="bg-slate-900/40 p-4 md:p-6 rounded-3xl border border-emerald-500/15 flex flex-col backdrop-blur-md">
              <div className="flex items-center justify-between border-b border-white/5 pb-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
                    <i className="fas fa-flask-vial text-lg"></i>
                  </div>
                  <div>
                    <h2 className="text-base font-black uppercase tracking-tight">Clinical Synthesis</h2>
                    <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Encounter Parameters</p>
                  </div>
                </div>
                <button 
                  onClick={handleCommitClick} 
                  disabled={isSaving}
                  className={`px-6 py-3 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all flex items-center gap-2 active:scale-95 min-h-[44px] ${isSaving ? 'bg-emerald-500 text-white' : selectedScenarioId === 'buffer' ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/30 hover:bg-amber-400 ring-4 ring-amber-500/20' : 'bg-white/5 text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/20'}`}
                >
                  {isSaving ? <i className="fas fa-check"></i> : <i className="fas fa-cloud-arrow-up"></i>}
                  {isSaving ? 'Archived' : selectedScenarioId === 'buffer' ? 'Commit to Library' : 'Update Case'}
                </button>
              </div>

              <div className="flex-1 flex flex-col gap-6">
                <div className="space-y-4 flex flex-col">
                  <div className="space-y-2">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-heading text-[7px]"></i>
                      Case Title
                    </label>
                    <input 
                      type="text"
                      value={editableScenario.title}
                      onChange={(e) => setEditableScenario(prev => ({ ...prev, title: e.target.value }))}
                      className="w-full p-4 bg-slate-950/60 border border-white/5 rounded-2xl text-[12px] font-black uppercase tracking-tight text-emerald-400 outline-none focus:border-emerald-500/30 transition-all shadow-inner"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-align-left text-[7px]"></i>
                      Description
                    </label>
                    <textarea 
                      value={editableScenario.description}
                      onChange={(e) => setEditableScenario(prev => ({ ...prev, description: e.target.value }))}
                      className="w-full h-16 p-4 bg-slate-950/60 border border-white/5 rounded-2xl text-[11px] leading-relaxed text-slate-400 outline-none focus:border-emerald-500/30 transition-all resize-none font-medium custom-scrollbar shadow-inner"
                    />
                  </div>
                </div>

                  <div className="space-y-2">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-bullseye text-[7px]"></i>
                      Learning Objectives (comma separated)
                    </label>
                    <input 
                      type="text"
                      value={editableScenario.learningObjectives?.join(', ') || ''}
                      onChange={(e) => setEditableScenario(prev => ({ ...prev, learningObjectives: e.target.value.split(',').map(s => s.trim()).filter(s => s !== '') }))}
                      className="w-full p-4 bg-slate-950/60 border border-white/5 rounded-2xl text-[11px] text-slate-300 outline-none focus:border-emerald-500/30 transition-all shadow-inner"
                    />
                  </div>

                 <div className="flex items-center gap-2 px-1">
                   <div className="text-[11px] font-black uppercase text-emerald-400 flex items-center gap-2 flex-1">
                     <i className="fas fa-user-shield opacity-60"></i>
                     {isGeneratingIdentity ? (
                       <span className="animate-pulse">Synthesizing...</span>
                     ) : (
                       <div className="flex items-center gap-1">
                         <input 
                          type="text"
                          value={editableScenario.patientProfile.name}
                          onChange={(e) => setEditableScenario(prev => ({ ...prev, patientProfile: { ...prev.patientProfile, name: e.target.value } }))}
                          className="bg-transparent border-none outline-none text-emerald-400 font-black uppercase tracking-tight w-40 focus:ring-0 p-0"
                          placeholder="Patient Name"
                         />
                         <div className="flex items-center gap-1 shrink-0 bg-emerald-500/10 px-1.5 py-0.5 rounded-lg border border-emerald-500/20">
                           <span className="text-[8px] text-emerald-500/60 font-black">AGE</span>
                           <input 
                            type="text"
                            value={parseAgeString(editableScenario.patientProfile.age).value}
                            onChange={(e) => {
                               const val = e.target.value;
                               const unit = parseAgeString(editableScenario.patientProfile.age).unit;
                               handleAgeChange(`${val} ${unit}`);
                             }}
                            className="bg-transparent border-none outline-none text-emerald-400 font-black text-[10px] w-8 focus:ring-0 p-0 text-center"
                            placeholder="Age"
                           />
                           <select 
                             value={parseAgeString(editableScenario.patientProfile.age).unit}
                             onChange={(e) => {
                               const val = parseAgeString(editableScenario.patientProfile.age).value;
                               const unit = e.target.value;
                               handleAgeChange(`${val} ${unit}`);
                             }}
                             className="bg-transparent border-none outline-none text-emerald-400 font-black text-[10px] focus:ring-0 p-0 uppercase cursor-pointer"
                           >
                             <option value="d" className="bg-slate-900 text-white">d</option>
                             <option value="w" className="bg-slate-900 text-white">w</option>
                             <option value="m" className="bg-slate-900 text-white">m</option>
                             <option value="y" className="bg-slate-900 text-white">y</option>
                           </select>
                         </div>
                         <div className="flex items-center gap-1 shrink-0 bg-emerald-500/10 px-1.5 py-0.5 rounded-lg border border-emerald-500/20">
                           <span className="text-[8px] text-emerald-500/60 font-black">SEX</span>
                           <select 
                             value={editableScenario.patientProfile.gender}
                             onChange={(e) => setEditableScenario(prev => ({ ...prev, patientProfile: { ...prev.patientProfile, gender: e.target.value } }))}
                             className="bg-transparent border-none outline-none text-emerald-400 font-black text-[10px] focus:ring-0 p-0 uppercase"
                           >
                             <option value="Male" className="bg-slate-900 text-white">Male</option>
                             <option value="Female" className="bg-slate-900 text-white">Female</option>
                             <option value="Other" className="bg-slate-900 text-white">Other</option>
                           </select>
                         </div>
                         <button 
                           onClick={generateCulturallyAppropriateIdentity} 
                           className="flex items-center gap-1 px-2 py-0.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-[8px] font-black text-slate-400 hover:text-white uppercase tracking-widest transition-all shrink-0"
                         >
                           <i className="fas fa-rotate text-[7px]"></i>
                           Regen
                         </button>
                       </div>
                     )}
                     {selectedScenarioId === 'buffer' && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>}
                   </div>
                </div>

                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-3 flex flex-col">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-notes-medical text-[7px]"></i>
                      Patient History
                    </label>
                    <textarea 
                      value={liveHistory} 
                      onChange={(e) => setLiveHistory(e.target.value)} 
                      className="w-full h-16 p-4 bg-slate-950/60 border border-white/5 rounded-2xl text-[12px] leading-relaxed text-slate-200 outline-none focus:border-emerald-500/30 transition-all resize-none font-medium custom-scrollbar shadow-inner" 
                    />
                  </div>
                  <div className="space-y-3 flex flex-col">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-stethoscope text-[7px]"></i>
                      Acute Findings
                    </label>
                    <textarea 
                      value={liveSymptoms} 
                      onChange={(e) => setLiveSymptoms(e.target.value)} 
                      className="w-full h-16 p-4 bg-slate-950/60 border border-white/5 rounded-2xl text-[12px] leading-relaxed text-slate-200 outline-none focus:border-emerald-500/30 transition-all resize-none font-medium custom-scrollbar shadow-inner" 
                    />
                  </div>
                </div>

                <div className="space-y-3 flex flex-col">
                  <label className="text-[9px] font-black uppercase text-amber-500 tracking-widest px-1 flex items-center gap-2">
                    <i className="fas fa-bolt-lightning text-[7px]"></i>
                    Facilitator Protocol
                  </label>
                  <textarea 
                    value={facilitatorInstructions} 
                    onChange={(e) => setFacilitatorInstructions(e.target.value)} 
                    placeholder="Secret directives..."
                    className="w-full h-16 p-4 bg-slate-950/60 border border-amber-500/10 rounded-2xl text-[12px] leading-relaxed text-amber-100/60 outline-none focus:border-amber-500/30 transition-all resize-none font-medium custom-scrollbar shadow-inner" 
                  />
                </div>
              </div>
            </section>

            {/* Clinical Assets & Media Section */}
            <section id="clinical-assets-section" className="bg-slate-900/40 p-4 md:p-6 rounded-3xl border border-indigo-500/15 flex flex-col backdrop-blur-md">
              <div className="flex items-center justify-between border-b border-white/5 pb-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
                    <i className="fas fa-images text-lg"></i>
                  </div>
                  <div>
                    <h2 className="text-base font-black uppercase tracking-tight">Clinical Assets & Media</h2>
                    <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Case Media Library</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={() => caseMediaImageInputRef.current?.click()}
                    className="px-4 py-2 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-500 hover:text-white transition-all active:scale-95 flex items-center gap-2"
                  >
                    <i className="fas fa-image"></i> Add Image
                  </button>
                  <button 
                    onClick={() => clinicalDocInputRef.current?.click()}
                    className="px-4 py-2 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-500 hover:text-white transition-all active:scale-95 flex items-center gap-2"
                  >
                    <i className="fas fa-file-medical"></i> Add Report
                  </button>
                </div>
                <input ref={caseMediaImageInputRef} type="file" multiple accept="image/*" className="hidden" onChange={handleImageUpload} />
                <input ref={clinicalDocInputRef} type="file" multiple accept=".pdf,.docx,.txt" className="hidden" onChange={handleClinicalDocUpload} />
              </div>

              <div className="space-y-6">
                {/* Images Grid */}
                <div className="space-y-3">
                  <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                    <i className="fas fa-camera-retro text-[7px]"></i>
                    Imaging & Visuals
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {editableScenario.attachedImages?.map((img, idx) => (
                      <div key={idx} className="relative group aspect-square rounded-2xl overflow-hidden border border-white/5 bg-slate-950/40">
                        <img 
                          src={img} 
                          alt={`Clinical ${idx + 1}`} 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                        <button 
                          onClick={() => removeAttachedImage(idx)}
                          className="absolute top-2 right-2 w-6 h-6 bg-red-500 rounded-lg flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                        >
                          <i className="fas fa-times text-[10px]"></i>
                        </button>
                      </div>
                    ))}
                    {(!editableScenario.attachedImages || editableScenario.attachedImages.length === 0) && (
                      <div className="col-span-full py-8 border border-dashed border-white/5 rounded-2xl flex flex-col items-center justify-center opacity-20">
                        <i className="fas fa-image text-2xl mb-2"></i>
                        <p className="text-[9px] font-black uppercase tracking-widest">No clinical images attached</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Documents List */}
                <div className="space-y-3">
                  <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                    <i className="fas fa-file-waveform text-[7px]"></i>
                    Clinical Reports & Docs
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {editableScenario.attachedDocs?.map((doc, idx) => (
                      <div key={idx} className="flex items-center justify-between p-3 bg-slate-950/60 border border-white/5 rounded-xl group">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <i className="fas fa-file-pdf text-indigo-400"></i>
                          <div className="flex flex-col overflow-hidden">
                            <span className="text-[10px] font-bold text-slate-300 truncate">{doc.name}</span>
                            {doc.content && (
                              <span className="text-[8px] text-slate-500 truncate">{doc.content.substring(0, 50)}...</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {doc.content && (
                            <button 
                              onClick={() => {
                                setSelectedDoc(doc);
                                setShowDocContent(true);
                              }}
                              className="p-1.5 text-indigo-400 hover:text-indigo-300 transition-colors"
                            >
                              <i className="fas fa-eye text-[10px]"></i>
                            </button>
                          )}
                          <button 
                            onClick={() => removeAttachedDoc(idx)}
                            className="p-1.5 text-slate-500 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <i className="fas fa-trash-alt text-[10px]"></i>
                          </button>
                        </div>
                      </div>
                    ))}
                    {(!editableScenario.attachedDocs || editableScenario.attachedDocs.length === 0) && (
                      <div className="col-span-full py-4 border border-dashed border-white/5 rounded-xl flex items-center justify-center opacity-20">
                        <p className="text-[9px] font-black uppercase tracking-widest">No clinical reports attached</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {showSpecialtyModal && (
              <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl z-[200] flex items-center justify-center p-6 rounded-3xl">
                <div className="bg-slate-900 border border-white/10 p-10 rounded-[2.5rem] shadow-2xl max-w-md w-full animate-fade-in">
                  <h3 className="text-xl font-black text-white uppercase tracking-tight mb-2">Select Specialties</h3>
                  <p className="text-[11px] text-slate-400 font-medium leading-relaxed mb-8">Choose at least one specialty before committing this case to the library</p>
                  
                  <div className="flex flex-wrap gap-2 mb-8">
                    {SPECIALTIES.map(spec => {
                      const isSelected = editableScenario.specialties?.includes(spec);
                      return (
                        <button
                          key={spec}
                          onClick={() => toggleSpecialtyTag(spec)}
                          className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isSelected ? 'bg-emerald-500 text-white shadow-md' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}
                        >
                          {spec}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-col gap-3">
                    <button 
                      disabled={!editableScenario.specialties || editableScenario.specialties.length === 0}
                      onClick={() => {
                        handleCommitToRegistry();
                        setShowSpecialtyModal(false);
                      }}
                      className={`w-full py-4 rounded-2xl font-black uppercase tracking-[0.2em] text-[10px] transition-all active:scale-95 ${(!editableScenario.specialties || editableScenario.specialties.length === 0) ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-amber-500 text-white shadow-lg shadow-amber-500/20 hover:bg-amber-400'}`}
                    >
                      Confirm & Commit
                    </button>
                    <button 
                      onClick={() => setShowSpecialtyModal(false)}
                      className="w-full py-4 bg-white/5 text-slate-400 rounded-2xl font-black uppercase tracking-[0.2em] text-[10px] hover:bg-white/10 hover:text-white transition-all active:scale-95"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>


          <div className="lg:col-span-6">
            <section className="bg-slate-900/40 p-4 md:p-6 rounded-3xl border border-white/5 flex flex-col backdrop-blur-md h-full">
              <div className="flex items-center justify-between border-b border-white/5 pb-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-purple-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-purple-500/20">
                    <i className="fas fa-id-card-clip text-lg"></i>
                  </div>
                  <div>
                    <h2 className="text-base font-black uppercase tracking-tight">Identity</h2>
                    <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Demographics</p>
                  </div>
                </div>
                <div className="flex bg-slate-950/80 p-1.5 rounded-2xl border border-white/5 shadow-inner">
                  {(['Static', 'Video'] as VisualMode[]).map(m => (
                    <button 
                      key={m} 
                      onClick={() => setSelectedVisualMode(m)} 
                      className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all tracking-widest ${selectedVisualMode === m ? 'bg-purple-500 text-white shadow-md' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 flex-1">
                <div className="space-y-6">
                  <div className="space-y-3">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-user-tag text-[7px]"></i>
                      Role
                    </label>
                    <div className="grid grid-cols-1 gap-2">
                      {(['Patient', 'Parent', 'Caregiver'] as AvatarRole[]).map(r => (
                        <button key={r} onClick={() => setSelectedRole(r)} className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-[0.98] ${selectedRole === r ? 'bg-purple-500 text-white shadow-lg' : 'bg-slate-950/60 text-slate-400 hover:bg-slate-900 border border-white/5'}`}>
                          {r} {selectedRole === r && <i className="fas fa-circle-check"></i>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedRole === 'Caregiver' && (
                    <div className="space-y-3 animate-fade-in">
                      <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                        <i className="fas fa-id-badge text-[7px]"></i>
                        Sub-role
                      </label>
                      <div className="grid grid-cols-1 gap-2">
                        {CAREGIVER_SUB_ROLES.map(sr => (
                          <button key={sr.id} onClick={() => setSelectedCaregiverSubRole(sr.id)} className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all active:scale-[0.98] ${selectedCaregiverSubRole === sr.id ? 'bg-purple-500 text-white shadow-md' : 'bg-slate-950/60 text-slate-500 hover:bg-slate-900 border border-white/5'}`}>
                            <i className={`fas ${sr.icon} w-4 text-xs`}></i>
                            {sr.id}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-3">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-face-smile text-[7px]"></i>
                      Affect
                    </label>
                    <select 
                      value={selectedEmotion} 
                      onChange={(e) => setSelectedEmotion(e.target.value as Emotion)}
                      className="w-full px-4 py-3 bg-slate-950/60 border border-white/5 rounded-xl text-[10px] font-black uppercase text-slate-300 outline-none focus:border-purple-500/50 cursor-pointer shadow-inner appearance-none"
                    >
                      {EMOTIONS.map(e => <option key={e} value={e}>{e}</option>)}
                    </select>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="space-y-3">
                    <div className="flex justify-between items-center px-1">
                      <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
                        <i className="fas fa-calendar-day text-[7px]"></i>
                        Age
                      </label>
                      <span className="text-[11px] font-black text-purple-400 tracking-tighter bg-purple-500/10 px-2 py-0.5 rounded-full">{formatAge(avatarAge)}</span>
                    </div>
                    <div className="px-1 pt-1">
                      <input 
                        type="range" 
                        min="0" 
                        max="100" 
                        value={getNumericAge(avatarAge)} 
                        onChange={(e) => {
                          const newAge = parseInt(e.target.value);
                          setAvatarAge(newAge);
                          if (selectedRole === 'Patient') {
                            handleAgeChange(`${newAge} y`);
                          }
                        }} 
                        className="w-full h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer accent-purple-500" 
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <input 
                          type="text"
                          value={parseAgeString(avatarAge).value}
                          onChange={(e) => {
                            const val = e.target.value;
                            const unit = parseAgeString(avatarAge).unit;
                            const newAge = `${val} ${unit}`;
                            setAvatarAge(newAge);
                            if (selectedRole === 'Patient') {
                              handleAgeChange(newAge);
                            }
                          }}
                          className="flex-1 bg-slate-950/50 border border-white/10 rounded-lg px-3 py-1.5 text-[10px] font-bold text-slate-200 focus:outline-none focus:border-purple-500/50 transition-all"
                          placeholder="Value"
                        />
                        <select 
                          value={parseAgeString(avatarAge).unit}
                          onChange={(e) => {
                            const val = parseAgeString(avatarAge).value;
                            const unit = e.target.value;
                            const newAge = `${val} ${unit}`;
                            setAvatarAge(newAge);
                            if (selectedRole === 'Patient') {
                              handleAgeChange(newAge);
                            }
                          }}
                          className="bg-slate-950/50 border border-white/10 rounded-lg px-2 py-1.5 text-[10px] font-bold text-slate-200 focus:outline-none focus:border-purple-500/50 transition-all uppercase cursor-pointer"
                        >
                          <option value="d" className="bg-slate-900 text-white">d</option>
                          <option value="w" className="bg-slate-900 text-white">w</option>
                          <option value="m" className="bg-slate-900 text-white">m</option>
                          <option value="y" className="bg-slate-900 text-white">y</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-earth-americas text-[7px]"></i>
                      Heritage & Faith
                    </label>
                    <div className="space-y-2">
                      <select value={race} onChange={(e) => setRace(e.target.value)} className="w-full px-4 py-3 bg-slate-950/60 border border-white/5 rounded-xl text-[10px] font-black uppercase text-slate-300 outline-none focus:border-purple-500/50 cursor-pointer shadow-inner appearance-none">
                        {RACES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <select value={religion} onChange={(e) => setReligion(e.target.value)} className="w-full px-4 py-3 bg-slate-950/60 border border-white/5 rounded-xl text-[10px] font-black uppercase text-slate-300 outline-none focus:border-purple-500/50 cursor-pointer shadow-inner appearance-none">
                        {RELIGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-venus-mars text-[7px]"></i>
                      Sex
                    </label>
                    <div className="flex gap-2">
                      {(['male', 'female'] as const).map(s => (
                        <button 
                          key={s} 
                          onClick={() => {
                            setSelectedGender(s);
                            if (selectedRole === 'Patient') {
                              setEditableScenario(prev => ({
                                ...prev,
                                patientProfile: { ...prev.patientProfile, gender: s.charAt(0).toUpperCase() + s.slice(1) }
                              }));
                            }
                          }} 
                          className={`flex-1 py-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest active:scale-[0.98] ${selectedGender === s ? 'border-purple-500 bg-purple-500/10 text-purple-300 shadow-lg' : 'border-white/5 bg-slate-950/60 text-slate-500 hover:border-white/10'}`}
                        >
                          <i className={`fas fa-${s === 'male' ? 'mars' : 'venus'} text-xs`}></i> {s}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                      <i className="fas fa-eye text-[7px]"></i>
                      Visual Notes
                    </label>
                    <textarea 
                        value={appearanceNotes} 
                        onChange={(e) => setAppearanceNotes(e.target.value)} 
                        placeholder="Glasses, tubes..."
                        className="w-full h-20 p-4 bg-slate-950/60 border border-white/5 rounded-2xl text-[11px] leading-relaxed text-slate-200 outline-none focus:border-purple-500/30 transition-all resize-none font-medium custom-scrollbar shadow-inner" 
                      />
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div className="lg:col-span-6">
            <section className="bg-slate-900/40 p-4 md:p-6 rounded-3xl border border-white/5 flex flex-col backdrop-blur-md h-full">
              <div className="flex items-center gap-3 border-b border-white/5 pb-4 mb-4">
                <div className="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
                  <i className="fas fa-language text-lg"></i>
                </div>
                <div>
                  <h2 className="text-base font-black uppercase tracking-tight">Linguistics</h2>
                  <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Dialect Engine</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div className="space-y-3">
                  <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                    <i className="fas fa-comment-dots text-[7px]"></i>
                    Vernacular
                  </label>
                  <select 
                    value={selectedAccent} 
                    onChange={(e) => setSelectedAccent(e.target.value as Accent)} 
                    className="w-full px-4 py-3 bg-slate-950/60 border border-white/5 rounded-xl text-[10px] font-black text-slate-300 outline-none focus:border-blue-500/50 transition-all cursor-pointer shadow-inner appearance-none"
                  >
                    {ACCENTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </div>

                <div className="space-y-3">
                  <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                    <i className="fas fa-bullhorn text-[7px]"></i>
                    Output Mode
                  </label>
                  <select value={selectedCommStyle} onChange={(e) => setSelectedCommStyle(e.target.value as CommunicationStyle)} className="w-full px-4 py-3 bg-slate-950/60 border border-white/5 rounded-xl text-[10px] font-black text-slate-300 outline-none focus:border-blue-500/50 cursor-pointer shadow-inner appearance-none">
                    {COMMUNICATION_STYLES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
                <div className="space-y-3 flex flex-col min-h-0">
                  <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                    <i className="fas fa-waveform-lines text-[7px]"></i>
                    Voice Profile
                  </label>
                  <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 max-h-[200px]">
                    <div className="grid grid-cols-1 gap-2">
                      {filteredVoices.map(vp => {
                        const ageGroupColor: Record<string, string> = {
                          'infant':     'bg-pink-500/20 text-pink-300 border-pink-500/30',
                          'child':      'bg-purple-500/20 text-purple-300 border-purple-500/30',
                          'adolescent': 'bg-amber-500/20 text-amber-300 border-amber-500/30',
                          'adult':      'bg-blue-500/20 text-blue-300 border-blue-500/30',
                          'senior':     'bg-slate-500/20 text-slate-300 border-slate-500/30',
                        };
                        const badgeClass = ageGroupColor[(vp as any).ageGroup] || ageGroupColor['adult'];
                        const isSelected = selectedVoiceProfileId === vp.id;

                        return (
                          <button
                            key={vp.id}
                            onClick={() => setSelectedVoiceProfileId(vp.id)}
                            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-[0.98] ${
                              isSelected
                                ? 'bg-blue-500 text-white shadow-lg'
                                : 'bg-slate-950/60 text-slate-400 hover:bg-slate-900 border border-white/5'
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <i className={`fas fa-waveform-lines w-4 text-xs ${isSelected ? 'text-white' : 'text-blue-400'}`}></i>
                              <div className="text-left">
                                <div className={`text-[10px] font-black uppercase tracking-wider leading-none ${isSelected ? 'text-white' : 'text-blue-300'}`}>
                                  {vp.label}
                                </div>
                                <div className={`text-[8px] font-bold uppercase tracking-widest mt-1 opacity-80 ${isSelected ? 'text-blue-100' : 'text-slate-500'}`}>
                                  {vp.desc}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {/* Age group badge */}
                              <span className={`text-[7px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full border ${isSelected ? 'bg-white/20 text-white border-white/30' : badgeClass}`}>
                                {(vp as any).ageGroup}
                              </span>
                              {isSelected && <i className="fas fa-circle-check"></i>}
                            </div>
                          </button>
                        );
                      })}
                      {filteredVoices.length === 0 && (
                        <div className="p-4 bg-slate-950/40 rounded-2xl border border-white/5 text-center">
                          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">No matching voices for this age/sex.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-3 flex flex-col min-h-0 relative">
                  <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                    <i className="fas fa-brain text-[7px]"></i>
                    Cognitive & Behavioral Traits
                  </label>
                  
                  <div className="relative">
                    <button
                      onClick={() => setShowCognitiveDropdown(!showCognitiveDropdown)}
                      className="w-full px-4 py-3 bg-slate-950/60 border border-white/5 rounded-xl text-[10px] font-black text-slate-300 outline-none focus:border-blue-500/50 transition-all cursor-pointer shadow-inner flex items-center justify-between group"
                    >
                      <span className="truncate pr-4">
                        {selectedCognitiveTraits.length === 0 
                          ? 'Select Traits...' 
                          : `${selectedCognitiveTraits.length} Trait${selectedCognitiveTraits.length > 1 ? 's' : ''} Selected`}
                      </span>
                      <i className={`fas fa-chevron-down text-[8px] transition-transform duration-300 ${showCognitiveDropdown ? 'rotate-180' : ''} text-slate-500 group-hover:text-blue-400`}></i>
                    </button>

                    {showCognitiveDropdown && (
                      <>
                        <div 
                          className="fixed inset-0 z-40" 
                          onClick={() => setShowCognitiveDropdown(false)}
                        />
                        <div className="absolute top-full left-0 right-0 mt-2 bg-slate-900 border border-white/10 rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-in">
                          <div className="max-h-[280px] overflow-y-auto custom-scrollbar p-2 space-y-1">
                            {COGNITIVE_TRAITS.map(trait => {
                              const isSelected = selectedCognitiveTraits.includes(trait.id);
                              return (
                                <button
                                  key={trait.id}
                                  onClick={() => {
                                    setSelectedCognitiveTraits(prev => 
                                      isSelected ? prev.filter(t => t !== trait.id) : [...prev, trait.id]
                                    );
                                  }}
                                  className={`w-full flex items-start gap-3 p-3 rounded-xl transition-all text-left ${isSelected ? 'bg-blue-500/10 border border-blue-500/20' : 'hover:bg-white/5 border border-transparent'}`}
                                >
                                  <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-white/10 bg-slate-950'}`}>
                                    {isSelected && <i className="fas fa-check text-[8px] text-white"></i>}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className={`text-[10px] font-black uppercase tracking-wider leading-none mb-1 ${isSelected ? 'text-blue-400' : 'text-slate-300'}`}>{trait.label}</div>
                                    <div className={`text-[8px] font-bold uppercase tracking-widest opacity-60 ${isSelected ? 'text-blue-200/60' : 'text-slate-500'}`}>{trait.desc}</div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                          {selectedCognitiveTraits.length > 0 && (
                            <div className="p-2 border-t border-white/5 bg-slate-950/40 flex justify-between items-center">
                              <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest px-2">
                                {selectedCognitiveTraits.length} selected
                              </span>
                              <button 
                                onClick={() => setSelectedCognitiveTraits([])}
                                className="text-[8px] font-black text-red-400 uppercase tracking-widest hover:text-red-300 transition-colors px-2 py-1"
                              >
                                Clear All
                              </button>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {selectedCognitiveTraits.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {selectedCognitiveTraits.map(traitId => (
                        <span 
                          key={traitId}
                          className="inline-flex items-center gap-1.5 px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded-lg text-[8px] font-black text-blue-400 uppercase tracking-widest"
                        >
                          {traitId}
                          <button 
                            onClick={() => setSelectedCognitiveTraits(prev => prev.filter(t => t !== traitId))}
                            className="hover:text-blue-200 transition-colors"
                          >
                            <i className="fas fa-times"></i>
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-3 mt-6">
                <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest px-1 flex items-center gap-2">
                  <i className="fas fa-microphone-lines text-[7px]"></i>
                  Vocalization notes
                </label>
                <textarea 
                  value={vocalizationNotes} 
                  onChange={(e) => setVocalizationNotes(e.target.value)} 
                  placeholder="Stuttering, wheezing, specific vocal tics..."
                  className="w-full h-20 p-4 bg-slate-950/60 border border-white/5 rounded-2xl text-[11px] leading-relaxed text-slate-200 outline-none focus:border-blue-500/30 transition-all resize-none font-medium custom-scrollbar shadow-inner" 
                />
              </div>
            </section>
          </div>

          <div className="lg:col-span-12">
            <div className="border border-amber-500/15 rounded-3xl overflow-hidden bg-slate-900/40 backdrop-blur-md">
              <button
                onClick={() => setShowEvidenceBase(!showEvidenceBase)}
                className="w-full flex items-center justify-between p-4 md:p-5 hover:bg-amber-500/5 transition-all group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-amber-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-amber-500/20 shrink-0">
                    <i className="fas fa-layer-group text-lg"></i>
                  </div>
                  <div className="text-left">
                    <h2 className="text-base font-black uppercase tracking-tight text-white">Evidence Base</h2>
                    <p className="text-[9px] text-amber-500/60 font-bold uppercase tracking-widest">Uploaded Guidelines & Rubrics — Optional</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {(knowledgeDocs.length > 0 || debriefDocs.length > 0) && (
                    <span className="text-[8px] font-black text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded-full uppercase tracking-widest">
                      {knowledgeDocs.length + debriefDocs.length} {knowledgeDocs.length + debriefDocs.length === 1 ? 'doc' : 'docs'} loaded
                    </span>
                  )}
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center border transition-all ${showEvidenceBase ? 'bg-amber-500/20 border-amber-500/30 text-amber-400' : 'bg-white/5 border-white/5 text-slate-500 group-hover:border-amber-500/20 group-hover:text-amber-400'}`}>
                    <i className={`fas fa-chevron-down text-[10px] transition-transform duration-300 ${showEvidenceBase ? 'rotate-180' : ''}`}></i>
                  </div>
                </div>
              </button>

              {showEvidenceBase && (
                <div className="border-t border-amber-500/10 p-4 md:p-6 animate-fade-in">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-slate-950/40 p-5 rounded-2xl border border-white/5 flex flex-col shadow-inner">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-[10px] font-black uppercase text-slate-300 tracking-widest">Knowledge Base</h4>
                        <button onClick={() => knowledgeInputRef.current?.click()} className="text-[10px] font-black text-amber-400 uppercase tracking-widest hover:text-amber-300 transition-colors p-2">Attach</button>
                        <input ref={knowledgeInputRef} type="file" className="hidden" accept=".docx,.txt,.pdf" onChange={(e) => handleKnowledgeUpload(e, 'foundations')} />
                      </div>
                      <div className="flex-1 space-y-2 max-h-[180px] overflow-y-auto custom-scrollbar pr-1">
                        {knowledgeDocs.length > 0 ? knowledgeDocs.map((d, i) => (
                          <div key={i} className="flex items-center justify-between p-3 bg-slate-900/60 rounded-xl border border-white/5 shadow-sm">
                            <span className="text-[10px] text-slate-300 truncate pr-3 font-bold uppercase tracking-tight">{d.name}</span>
                            <button onClick={() => setKnowledgeDocs(p => p.filter((_, idx) => idx !== i))} className="text-red-500/50 hover:text-red-400 transition-colors p-1.5"><i className="fas fa-trash-can text-[10px]"></i></button>
                          </div>
                        )) : <div className="text-[10px] text-slate-600 italic py-4 text-center font-medium uppercase tracking-widest opacity-40">Default Clinical Consensus.</div>}
                      </div>
                    </div>

                    <div className="bg-slate-950/40 p-5 rounded-2xl border border-white/5 flex flex-col shadow-inner">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-[10px] font-black uppercase text-slate-300 tracking-widest">Debrief Logic</h4>
                        <button onClick={() => debriefInputRef.current?.click()} className="text-[10px] font-black text-amber-400 uppercase tracking-widest hover:text-amber-300 transition-colors p-2">Set Rubrics</button>
                        <input ref={debriefInputRef} type="file" className="hidden" accept=".docx,.txt,.pdf" onChange={(e) => handleKnowledgeUpload(e, 'debrief')} />
                      </div>
                      <div className="flex-1 space-y-2 max-h-[180px] overflow-y-auto custom-scrollbar pr-1">
                        {debriefDocs.length > 0 ? debriefDocs.map((d, i) => (
                          <div key={i} className="flex items-center justify-between p-3 bg-slate-900/60 rounded-xl border border-white/5 shadow-sm">
                            <span className="text-[10px] text-slate-300 truncate pr-3 font-bold uppercase tracking-tight">{d.name}</span>
                            <button onClick={() => setDebriefDocs(p => p.filter((_, idx) => idx !== i))} className="text-red-500/50 hover:text-red-400 transition-colors p-1.5"><i className="fas fa-trash-can text-[10px]"></i></button>
                          </div>
                        )) : <div className="text-[10px] text-slate-600 italic py-4 text-center font-medium uppercase tracking-widest opacity-40">SimVeritas 1.52 Foundations.</div>}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      <div className="shrink-0 p-8 md:p-12 bg-slate-950/95 backdrop-blur-3xl border-t border-white/5 z-50 flex flex-col items-center">
        {selectedVisualMode === 'Video' && !hasApiKey ? (
          <button 
            onClick={onSelectKey} 
            className="w-full max-w-2xl py-6 bg-amber-600 text-white rounded-[2.5rem] font-black uppercase tracking-[0.45em] text-[13px] shadow-2xl shadow-amber-500/20 hover:bg-amber-500 transition-all active:scale-[0.97] flex items-center justify-center gap-6 group mb-4"
          >
            Authorize Video Synthesis
            <i className="fas fa-fingerprint text-[16px] transition-transform"></i>
          </button>
        ) : (
          <button 
            onClick={handleStart} 
            className="w-full max-w-2xl py-6 bg-blue-600 text-white rounded-[2.5rem] font-black uppercase tracking-[0.45em] text-[13px] shadow-2xl shadow-blue-500/30 hover:bg-blue-500 transition-all active:scale-[0.97] flex items-center justify-center gap-6 group"
          >
            Engage Encounter Environment
            <i className="fas fa-circle-play text-[16px] group-hover:translate-x-1.5 transition-transform"></i>
          </button>
        )}
        {selectedVisualMode === 'Video' && (
          <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-[9px] font-bold text-slate-500 uppercase tracking-widest hover:text-blue-400 transition-colors mt-3 opacity-60">Neural Tier Billing Documentation (External)</a>
        )}
      </div>

      <style>{`
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          height: 18px;
          width: 18px;
          border-radius: 50%;
          background: #a855f7;
          cursor: pointer;
          border: 3px solid #020617;
          box-shadow: 0 0 12px rgba(168, 85, 247, 0.5);
          transition: scale 0.2s ease;
        }
        input[type=range]::-webkit-slider-thumb:hover {
          scale: 1.2;
        }
        select {
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2364748b'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 1.5rem center;
          background-size: 1rem;
        }
        select option {
          background-color: #020617;
          color: #f1f5f9;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
      `}</style>

      {/* Archive Drawer */}
      {showArchiveDrawer && (
        <div 
          className="fixed inset-0 bg-black/40 z-[190] animate-fade-in" 
          onClick={() => setShowArchiveDrawer(false)}
        />
      )}
      
      <div className={`fixed top-0 right-0 h-full w-[420px] md:w-[500px] bg-slate-950/90 backdrop-blur-xl border-l border-white/10 z-[200] transition-transform duration-500 ease-in-out shadow-[-20px_0_60px_rgba(0,0,0,0.6)] flex flex-col ${showArchiveDrawer ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-8 border-b border-white/5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
              <i className="fas fa-box-archive text-xl"></i>
            </div>
            <div>
              <h2 className="text-xl font-black text-white uppercase tracking-tight">Outcomes Registry</h2>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Performance & Analytics</p>
            </div>
          </div>
          <button 
            onClick={() => setShowArchiveDrawer(false)}
            className="w-10 h-10 rounded-xl bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all flex items-center justify-center"
          >
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="px-8 py-4 border-b border-white/5 flex gap-4 shrink-0">
          <button 
            onClick={() => setDrawerTab('reports')}
            className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${drawerTab === 'reports' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
          >
            Reports
          </button>
          <button 
            onClick={() => setDrawerTab('analytics')}
            className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${drawerTab === 'analytics' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
          >
            Analytics
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar space-y-3">
          {drawerTab === 'reports' ? (
            savedReports.length > 0 ? savedReports.map(r => (
              <div 
                key={r.id} 
                className="w-full rounded-3xl bg-slate-900/40 border border-white/5 hover:border-blue-500/30 transition-all group overflow-hidden"
              >
                <div 
                  className="p-4 cursor-pointer flex justify-between items-start"
                  onClick={() => setExpandedReportId(expandedReportId === r.id ? null : r.id)}
                >
                  <div className="flex flex-col gap-0.5">
                    <h4 className="text-[12px] font-black uppercase leading-tight text-slate-200">{r.scenarioTitle}</h4>
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] font-black text-blue-400 uppercase tracking-widest">{r.patientName}</span>
                      <span className="text-[8px] text-slate-500 font-medium">• {new Date(r.timestamp).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20">
                      <span className="text-[9px] font-black text-blue-400">{r.report.overallScore || 0}%</span>
                    </div>
                    <i className={`fas fa-chevron-down text-[9px] text-slate-500 transition-transform ${expandedReportId === r.id ? 'rotate-180' : ''}`}></i>
                  </div>
                </div>

                {expandedReportId === r.id && (
                  <div className="px-4 pb-4 pt-2 border-t border-white/5 animate-fade-in">
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-slate-950/40 p-3 rounded-xl border border-white/5">
                          <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Clinical</p>
                          <p className="text-xs font-black text-emerald-400">{r.report.clinicalAccuracy || 0}%</p>
                        </div>
                        <div className="bg-slate-950/40 p-3 rounded-xl border border-white/5">
                          <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Comm.</p>
                          <p className="text-xs font-black text-blue-400">{r.report.communicationScore || 0}%</p>
                        </div>
                      </div>
                      
                      <div className="bg-slate-950/40 p-3 rounded-xl border border-white/5">
                        <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Insights</p>
                        <ul className="space-y-1">
                          {(r.report.keyInsights || []).slice(0, 2).map((insight, idx) => (
                            <li key={idx} className="text-[10px] text-slate-300 flex gap-1.5 leading-tight">
                              <span className="text-blue-500">•</span>
                              {insight}
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="flex gap-2">
                        <button 
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onViewReport(r);
                          }}
                          className="flex-1 py-3 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-500 transition-all active:scale-95 flex items-center justify-center gap-2 min-h-[44px]"
                        >
                          <i className="fas fa-file-lines"></i>
                          Details
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmAction({ id: r.id, type: 'report' });
                          }}
                          className="px-4 py-3 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl hover:bg-red-500 hover:text-white transition-all min-h-[44px] min-w-[44px]"
                        >
                          <i className="fas fa-trash-can text-[11px]"></i>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )) : (
              <div className="flex flex-col items-center justify-center py-20 opacity-20">
                <i className="fas fa-folder-open text-4xl mb-4"></i>
                <p className="text-[9px] font-black uppercase tracking-widest">Archive Empty</p>
              </div>
            )
          ) : (
            analyticsData.length > 0 ? analyticsData.map(a => (
              <div 
                key={a.id} 
                className="w-full rounded-3xl bg-slate-900/40 border border-white/5 p-4 space-y-3"
              >
                <div className="flex justify-between items-start">
                  <div className="flex flex-col gap-0.5">
                    <h4 className="text-[12px] font-black uppercase leading-tight text-slate-200">{a.scenarioTitle}</h4>
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] font-black text-blue-400 uppercase tracking-widest">{a.patientName}</span>
                      <span className="text-[8px] text-slate-500 font-medium">• {new Date(a.timestamp).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20">
                    <span className="text-[9px] font-black text-blue-400">{a.overallScore}%</span>
                  </div>
                </div>
                
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-slate-950/40 p-2 rounded-lg border border-white/5 text-center">
                    <p className="text-[6px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Clinical</p>
                    <p className="text-[10px] font-black text-emerald-400">{a.clinicalAccuracy}%</p>
                  </div>
                  <div className="bg-slate-950/40 p-2 rounded-lg border border-white/5 text-center">
                    <p className="text-[6px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Comm.</p>
                    <p className="text-[10px] font-black text-blue-400">{a.communicationScore}%</p>
                  </div>
                  <div className="bg-slate-950/40 p-2 rounded-lg border border-white/5 text-center">
                    <p className="text-[6px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Evidence</p>
                    <p className="text-[10px] font-black text-amber-400">{a.evidenceBasedScore}%</p>
                  </div>
                </div>
              </div>
            )) : (
              <div className="flex flex-col items-center justify-center py-20 opacity-20">
                <i className="fas fa-chart-line text-4xl mb-4"></i>
                <p className="text-[9px] font-black uppercase tracking-widest">No Analytics Data</p>
              </div>
            )
          )}
        </div>
      </div>
      {/* Document Modal */}
      {docModalOpen && docModalScenario && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 md:p-8 animate-fade-in print:p-0 print:static">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md print:hidden" onClick={() => {
            if (isEditingDoc) {
              setShowDiscardConfirm(true);
            } else {
              setDocModalOpen(false);
            }
          }} />
          <div className="relative w-full max-w-4xl max-h-[90vh] bg-slate-900 border border-white/10 rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden print:max-h-none print:w-full print:border-none print:shadow-none print:rounded-none print:bg-white print:text-black">
            <div className="p-6 md:p-8 border-b border-white/5 flex items-center justify-between shrink-0 print:border-black print:p-4">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-indigo-500 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-500/20 print:hidden">
                  <i className="fas fa-file-medical text-xl"></i>
                </div>
                <div>
                  {isEditingDoc ? (
                    <input 
                      type="text"
                      value={tempDocScenario?.title || ''}
                      onChange={(e) => setTempDocScenario(prev => prev ? { ...prev, title: e.target.value } : null)}
                      className="text-xl font-black text-white uppercase tracking-tight bg-slate-950/50 border border-white/10 rounded-lg px-3 py-1 w-full focus:outline-none focus:border-indigo-500"
                    />
                  ) : (
                    <h2 className="text-xl font-black text-white uppercase tracking-tight print:text-black print:text-2xl">{docModalScenario.title}</h2>
                  )}
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest print:text-black">Scenario Documentation</p>
                </div>
              </div>
              <div className="flex items-center gap-2 print:hidden">
                {!isEditingDoc ? (
                  <>
                    <button 
                      onClick={handlePrint}
                      className="w-10 h-10 rounded-xl bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all flex items-center justify-center"
                      title="Print Documentation"
                    >
                      <i className="fas fa-print"></i>
                    </button>
                    <button 
                      onClick={handleDownloadPDF}
                      className="w-10 h-10 rounded-xl bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all flex items-center justify-center"
                      title="Download PDF (Editable)"
                    >
                      <i className="fas fa-file-pdf"></i>
                    </button>
                    <button 
                      onClick={() => {
                        setTempDocScenario(docModalScenario);
                        setIsEditingDoc(true);
                      }}
                      className="w-10 h-10 rounded-xl bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all flex items-center justify-center"
                      title="Edit Documentation"
                    >
                      <i className="fas fa-edit"></i>
                    </button>
                  </>
                ) : (
                  <>
                    <button 
                      onClick={handleSaveDocChanges}
                      className="px-4 py-2 bg-emerald-600 text-white rounded-xl font-bold uppercase tracking-widest text-[10px] hover:bg-emerald-500 transition-all"
                    >
                      Save
                    </button>
                    <button 
                      onClick={() => setShowDiscardConfirm(true)}
                      className="px-4 py-2 bg-white/5 text-slate-400 rounded-xl font-bold uppercase tracking-widest text-[10px] hover:bg-white/10 hover:text-white transition-all"
                    >
                      Cancel
                    </button>
                  </>
                )}
                <button 
                  onClick={() => {
                    if (isEditingDoc) {
                      setShowDiscardConfirm(true);
                    } else {
                      setDocModalOpen(false);
                    }
                  }}
                  className="w-10 h-10 rounded-xl bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all flex items-center justify-center"
                >
                  <i className="fas fa-times"></i>
                </button>
              </div>
            </div>

            {showDiscardConfirm && (
              <div className="absolute inset-0 z-[400] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm animate-fade-in">
                <div className="bg-slate-900 border border-white/10 p-8 rounded-3xl shadow-2xl max-w-sm w-full text-center space-y-6">
                  <div className="w-16 h-16 bg-amber-500/20 text-amber-500 rounded-full flex items-center justify-center mx-auto text-2xl">
                    <i className="fas fa-exclamation-triangle"></i>
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold text-white">Discard Changes?</h3>
                    <p className="text-sm text-slate-400">You have unsaved changes. Are you sure you want to discard them?</p>
                  </div>
                  <div className="flex gap-3">
                    <button 
                      onClick={() => setShowDiscardConfirm(false)}
                      className="flex-1 px-4 py-3 bg-white/5 text-white rounded-xl font-bold hover:bg-white/10 transition-all"
                    >
                      Keep Editing
                    </button>
                    <button 
                      onClick={() => {
                        setIsEditingDoc(false);
                        setShowDiscardConfirm(false);
                        setDocModalOpen(false);
                      }}
                      className="flex-1 px-4 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-500 transition-all shadow-lg shadow-red-600/20"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-6 md:p-8 custom-scrollbar space-y-8 print:overflow-visible print:p-4 print:text-black">
              <section className="space-y-3">
                <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest flex items-center gap-2 print:text-black print:text-xs">
                  <i className="fas fa-info-circle print:hidden"></i>
                  Overview
                </h3>
                {isEditingDoc ? (
                  <textarea 
                    value={tempDocScenario?.description || ''}
                    onChange={(e) => setTempDocScenario(prev => prev ? { ...prev, description: e.target.value } : null)}
                    className="w-full text-sm text-slate-300 leading-relaxed font-medium bg-slate-950/50 border border-white/10 rounded-xl p-4 focus:outline-none focus:border-indigo-500 min-h-[100px]"
                  />
                ) : (
                  <p className="text-sm text-slate-300 leading-relaxed font-medium print:text-black">{docModalScenario.description}</p>
                )}
              </section>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 print:grid-cols-1 print:gap-4">
                <section className="space-y-3">
                  <h3 className="text-[10px] font-black text-emerald-400 uppercase tracking-widest flex items-center gap-2 print:text-black print:text-xs">
                    <i className="fas fa-user-circle print:hidden"></i>
                    Patient Profile
                  </h3>
                  <div className="bg-slate-950/40 p-4 rounded-2xl border border-white/5 space-y-3 print:bg-white print:border-black print:text-black">
                    <div className="flex justify-between items-center border-b border-white/5 pb-2 print:border-black">
                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest print:text-black">Name</span>
                      {isEditingDoc ? (
                        <input 
                          type="text"
                          value={tempDocScenario?.patientProfile.name || ''}
                          onChange={(e) => setTempDocScenario(prev => prev ? { ...prev, patientProfile: { ...prev.patientProfile, name: e.target.value } } : null)}
                          className="text-[11px] font-bold text-slate-200 bg-slate-950/50 border border-white/10 rounded px-2 py-0.5 focus:outline-none"
                        />
                      ) : (
                        <span className="text-[11px] font-bold text-slate-200 print:text-black">{docModalScenario.patientProfile.name}</span>
                      )}
                    </div>
                    <div className="flex justify-between items-center border-b border-white/5 pb-2 print:border-black">
                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest print:text-black">Age / Sex</span>
                      {isEditingDoc ? (
                        <div className="flex gap-2">
                          <div className="flex items-center gap-1 bg-slate-950/50 border border-white/10 rounded px-2 py-0.5">
                            <input 
                              type="text"
                              value={parseAgeString(tempDocScenario?.patientProfile.age || '').value}
                              onChange={(e) => {
                                const val = e.target.value;
                                const unit = parseAgeString(tempDocScenario?.patientProfile.age || '').unit;
                                handleTempAgeChange(`${val} ${unit}`);
                              }}
                              className="w-10 text-[11px] font-bold text-slate-200 bg-transparent border-none outline-none focus:outline-none"
                              placeholder="Age"
                            />
                            <select 
                              value={parseAgeString(tempDocScenario?.patientProfile.age || '').unit}
                              onChange={(e) => {
                                const val = parseAgeString(tempDocScenario?.patientProfile.age || '').value;
                                const unit = e.target.value;
                                handleTempAgeChange(`${val} ${unit}`);
                              }}
                              className="text-[11px] font-bold text-slate-200 bg-transparent border-none outline-none focus:outline-none uppercase cursor-pointer"
                            >
                              <option value="d" className="bg-slate-900 text-white">d</option>
                              <option value="w" className="bg-slate-900 text-white">w</option>
                              <option value="m" className="bg-slate-900 text-white">m</option>
                              <option value="y" className="bg-slate-900 text-white">y</option>
                            </select>
                          </div>
                          <select 
                            value={tempDocScenario?.patientProfile.gender || 'male'}
                            onChange={(e) => setTempDocScenario(prev => prev ? { ...prev, patientProfile: { ...prev.patientProfile, gender: e.target.value as any } } : null)}
                            className="text-[11px] font-bold text-slate-200 bg-slate-950/50 border border-white/10 rounded px-2 py-0.5 focus:outline-none"
                          >
                            <option value="male">Male</option>
                            <option value="female">Female</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                      ) : (
                        <span className="text-[11px] font-bold text-slate-200 print:text-black">{formatAge(docModalScenario.patientProfile.age)} / {docModalScenario.patientProfile.gender}</span>
                      )}
                    </div>
                    <div className="space-y-1">
                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest print:text-black">Medical History</span>
                      {isEditingDoc ? (
                        <textarea 
                          value={tempDocScenario?.patientProfile.medicalHistory || ''}
                          onChange={(e) => setTempDocScenario(prev => prev ? { ...prev, patientProfile: { ...prev.patientProfile, medicalHistory: e.target.value } } : null)}
                          className="w-full text-[10px] text-slate-400 leading-relaxed bg-slate-950/50 border border-white/10 rounded p-2 focus:outline-none min-h-[60px]"
                        />
                      ) : (
                        <p className="text-[10px] text-slate-400 leading-relaxed print:text-black">{docModalScenario.patientProfile.medicalHistory}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest print:text-black">Current Symptoms</span>
                      {isEditingDoc ? (
                        <textarea 
                          value={tempDocScenario?.patientProfile.currentSymptoms || ''}
                          onChange={(e) => setTempDocScenario(prev => prev ? { ...prev, patientProfile: { ...prev.patientProfile, currentSymptoms: e.target.value } } : null)}
                          className="w-full text-[10px] text-slate-400 leading-relaxed bg-slate-950/50 border border-white/10 rounded p-2 focus:outline-none min-h-[60px]"
                        />
                      ) : (
                        <p className="text-[10px] text-slate-400 leading-relaxed print:text-black">{docModalScenario.patientProfile.currentSymptoms}</p>
                      )}
                    </div>
                  </div>
                </section>

                <section className="space-y-3">
                  <h3 className="text-[10px] font-black text-amber-400 uppercase tracking-widest flex items-center gap-2 print:text-black print:text-xs">
                    <i className="fas fa-bullseye print:hidden"></i>
                    Learning Objectives
                  </h3>
                  <div className="space-y-2">
                    {(isEditingDoc ? tempDocScenario?.learningObjectives : docModalScenario.learningObjectives)?.map((obj, i) => (
                      <div key={i} className="flex items-start gap-3 p-3 bg-slate-950/40 rounded-xl border border-white/5 print:bg-white print:border-black print:text-black">
                        <div className="w-5 h-5 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500 shrink-0 print:border print:border-black print:text-black">
                          <span className="text-[10px] font-black">{i + 1}</span>
                        </div>
                        {isEditingDoc ? (
                          <div className="flex-1 flex gap-2">
                            <input 
                              type="text"
                              value={obj}
                              onChange={(e) => {
                                if (!tempDocScenario) return;
                                const newObjs = [...tempDocScenario.learningObjectives];
                                newObjs[i] = e.target.value;
                                setTempDocScenario({ ...tempDocScenario, learningObjectives: newObjs });
                              }}
                              className="flex-1 text-[11px] text-slate-300 font-medium leading-tight bg-slate-950/50 border border-white/10 rounded px-2 py-1 focus:outline-none"
                            />
                            <button 
                              onClick={() => {
                                if (!tempDocScenario) return;
                                const newObjs = tempDocScenario.learningObjectives.filter((_, idx) => idx !== i);
                                setTempDocScenario({ ...tempDocScenario, learningObjectives: newObjs });
                              }}
                              className="text-red-500 hover:text-red-400"
                            >
                              <i className="fas fa-trash"></i>
                            </button>
                          </div>
                        ) : (
                          <p className="text-[11px] text-slate-300 font-medium leading-tight print:text-black">{obj}</p>
                        )}
                      </div>
                    ))}
                    {isEditingDoc && (
                      <button 
                        onClick={() => {
                          if (!tempDocScenario) return;
                          setTempDocScenario({ ...tempDocScenario, learningObjectives: [...tempDocScenario.learningObjectives, 'New Objective'] });
                        }}
                        className="w-full p-2 border border-dashed border-white/10 rounded-xl text-[10px] text-slate-500 hover:text-slate-300 hover:border-white/20 transition-all"
                      >
                        + Add Objective
                      </button>
                    )}
                  </div>
                </section>
              </div>

              {/* Scenario Phases Timeline */}
              {((isEditingDoc ? tempDocScenario : docModalScenario)?.phases?.length ?? 0) > 0 && (
                <section className="space-y-6 pt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[10px] font-black text-blue-400 uppercase tracking-widest flex items-center gap-2 print:text-black print:text-xs">
                      <i className="fas fa-route print:hidden"></i>
                      Scenario Progression
                    </h3>
                    <div className="flex items-center gap-4">
                      <span className="text-[8px] font-black text-slate-500 bg-white/5 px-2 py-1 rounded-full uppercase tracking-widest print:text-black">
                        {(isEditingDoc ? tempDocScenario?.phases.length : docModalScenario.phases.length)} Phases
                      </span>
                      {isEditingDoc && (
                        <button 
                          onClick={handleAddPhase}
                          className="px-3 py-1 bg-blue-600/20 text-blue-400 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-blue-600/30 transition-all"
                        >
                          + Add Phase
                        </button>
                      )}
                    </div>
                  </div>
                  
                  <div className="space-y-4 relative before:absolute before:left-[18px] before:top-2 before:bottom-2 before:w-px before:bg-white/5 print:before:bg-black">
                    {(isEditingDoc ? tempDocScenario?.phases : docModalScenario.phases)?.map((phase, idx) => (
                      <div key={phase.id || idx} className="relative pl-12 group">
                        <div className="absolute left-0 top-0 w-9 h-9 rounded-xl bg-slate-950 border border-white/10 flex items-center justify-center z-10 group-hover:border-blue-500/50 transition-colors print:bg-white print:border-black print:text-black">
                          <span className="text-[11px] font-black text-blue-400 print:text-black">{idx + 1}</span>
                        </div>
                        
                        <div className="bg-slate-950/40 p-5 rounded-2xl border border-white/5 space-y-4 group-hover:border-white/10 transition-all print:bg-white print:border-black print:text-black">
                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                            {isEditingDoc ? (
                              <input 
                                type="text"
                                value={phase.label}
                                onChange={(e) => {
                                  if (!tempDocScenario) return;
                                  const newPhases = [...tempDocScenario.phases];
                                  newPhases[idx] = { ...newPhases[idx], label: e.target.value };
                                  setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                }}
                                className="text-[12px] font-black text-white uppercase tracking-tight bg-slate-950/50 border border-white/10 rounded px-2 py-1 focus:outline-none"
                              />
                            ) : (
                              <h4 className="text-[12px] font-black text-white uppercase tracking-tight print:text-black">{phase.label}</h4>
                            )}
                            <div className="flex items-center gap-3">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest print:text-black">Duration:</span>
                                {isEditingDoc ? (
                                  <input 
                                    type="text"
                                    value={phase.durationHint}
                                    onChange={(e) => {
                                      if (!tempDocScenario) return;
                                      const newPhases = [...tempDocScenario.phases];
                                      newPhases[idx] = { ...newPhases[idx], durationHint: parseInt(e.target.value) };
                                      setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                    }}
                                    className="w-10 text-[8px] font-black text-slate-500 bg-slate-950/50 border border-white/10 rounded px-1 py-0.5 focus:outline-none"
                                  />
                                ) : (
                                  <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest print:text-black">{phase.durationHint} MIN</span>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest print:text-black">Trigger:</span>
                                {isEditingDoc ? (
                                  <input 
                                    type="text"
                                    value={phase.triggerCondition}
                                    onChange={(e) => {
                                      if (!tempDocScenario) return;
                                      const newPhases = [...tempDocScenario.phases];
                                      newPhases[idx] = { ...newPhases[idx], triggerCondition: e.target.value };
                                      setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                    }}
                                    className="text-[8px] font-black text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 rounded px-2 py-0.5 focus:outline-none"
                                  />
                                ) : (
                                  <span className="text-[8px] font-black text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full uppercase tracking-widest print:text-black print:bg-transparent print:border print:border-black">
                                    {phase.triggerCondition}
                                  </span>
                                )}
                              </div>
                              {isEditingDoc && (
                                <button 
                                  onClick={() => handleRemovePhase(idx)}
                                  className="text-red-500 hover:text-red-400 ml-2"
                                >
                                  <i className="fas fa-trash-alt text-[10px]"></i>
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 print:grid-cols-1 print:gap-2">
                            <div className="space-y-1.5">
                              <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest print:text-black">Patient State</p>
                              <div className="text-[10px] text-slate-400 leading-relaxed print:text-black">
                                {isEditingDoc ? (
                                  <div className="space-y-2">
                                    <div className="flex flex-col gap-1">
                                      <span className="text-[7px] text-slate-500 uppercase">Symptoms</span>
                                      <input 
                                        type="text"
                                        value={phase.patientState.symptoms}
                                        onChange={(e) => {
                                          if (!tempDocScenario) return;
                                          const newPhases = [...tempDocScenario.phases];
                                          newPhases[idx] = { ...newPhases[idx], patientState: { ...newPhases[idx].patientState, symptoms: e.target.value } };
                                          setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                        }}
                                        className="bg-slate-950/50 border border-white/10 rounded px-2 py-1 text-[9px] focus:outline-none"
                                      />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                      <span className="text-[7px] text-slate-500 uppercase">Emotion</span>
                                      <select 
                                        value={phase.patientState.emotion}
                                        onChange={(e) => {
                                          if (!tempDocScenario) return;
                                          const newPhases = [...tempDocScenario.phases];
                                          newPhases[idx] = { ...newPhases[idx], patientState: { ...newPhases[idx].patientState, emotion: e.target.value as any } };
                                          setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                        }}
                                        className="bg-slate-950/50 border border-white/10 rounded px-2 py-1 text-[9px] focus:outline-none"
                                      >
                                        {EMOTIONS.map(e => <option key={e} value={e}>{e}</option>)}
                                      </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                      <span className="text-[7px] text-slate-500 uppercase">Vitals</span>
                                      <input 
                                        type="text"
                                        value={phase.patientState.vitalsTrend}
                                        onChange={(e) => {
                                          if (!tempDocScenario) return;
                                          const newPhases = [...tempDocScenario.phases];
                                          newPhases[idx] = { ...newPhases[idx], patientState: { ...newPhases[idx].patientState, vitalsTrend: e.target.value } };
                                          setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                        }}
                                        className="bg-slate-950/50 border border-white/10 rounded px-2 py-1 text-[9px] focus:outline-none"
                                      />
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <p><span className="text-slate-500 print:text-black print:font-bold">Symptoms:</span> {phase.patientState.symptoms}</p>
                                    <p><span className="text-slate-500 print:text-black print:font-bold">Emotion:</span> {phase.patientState.emotion}</p>
                                    <p><span className="text-slate-500 print:text-black print:font-bold">Vitals:</span> {phase.patientState.vitalsTrend}</p>
                                  </>
                                )}
                              </div>
                            </div>
                            
                            <div className="space-y-1.5">
                              <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest print:text-black">Expected Actions</p>
                              <ul className="space-y-1">
                                {phase.expectedLearnerActions.map((action, i) => (
                                  <li key={i} className="text-[10px] text-slate-400 flex gap-2 print:text-black">
                                    <span className="text-blue-500 print:text-black">•</span>
                                    {isEditingDoc ? (
                                      <div className="flex-1 flex gap-2">
                                        <input 
                                          type="text"
                                          value={action}
                                          onChange={(e) => {
                                            if (!tempDocScenario) return;
                                            const newPhases = [...tempDocScenario.phases];
                                            const newActions = [...newPhases[idx].expectedLearnerActions];
                                            newActions[i] = e.target.value;
                                            newPhases[idx] = { ...newPhases[idx], expectedLearnerActions: newActions };
                                            setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                          }}
                                          className="flex-1 bg-slate-950/50 border border-white/10 rounded px-2 py-0.5 text-[9px] focus:outline-none"
                                        />
                                        <button 
                                          onClick={() => {
                                            if (!tempDocScenario) return;
                                            const newPhases = [...tempDocScenario.phases];
                                            const newActions = newPhases[idx].expectedLearnerActions.filter((_, aIdx) => aIdx !== i);
                                            newPhases[idx] = { ...newPhases[idx], expectedLearnerActions: newActions };
                                            setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                          }}
                                          className="text-red-500 hover:text-red-400"
                                        >
                                          <i className="fas fa-times"></i>
                                        </button>
                                      </div>
                                    ) : (
                                      action
                                    )}
                                  </li>
                                ))}
                                {isEditingDoc && (
                                  <button 
                                    onClick={() => {
                                      if (!tempDocScenario) return;
                                      const newPhases = [...tempDocScenario.phases];
                                      newPhases[idx] = { ...newPhases[idx], expectedLearnerActions: [...newPhases[idx].expectedLearnerActions, 'New Action'] };
                                      setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                    }}
                                    className="w-full p-1 border border-dashed border-white/10 rounded text-[8px] text-slate-500 hover:text-slate-300"
                                  >
                                    + Add Action
                                  </button>
                                )}
                              </ul>
                            </div>

                            <div className="space-y-1.5">
                              <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest print:text-black">Escalation Triggers</p>
                              <div className="space-y-2">
                                {phase.escalationTriggers.map((trigger, i) => (
                                  <div key={i} className="text-[9px] p-2 bg-red-500/5 rounded-lg border border-red-500/10 print:bg-white print:border-black print:text-black">
                                    {isEditingDoc ? (
                                      <div className="space-y-2">
                                        <div className="flex justify-between items-center">
                                          <span className="text-[7px] text-red-400 uppercase font-bold">Trigger {i + 1}</span>
                                          <button 
                                            onClick={() => {
                                              if (!tempDocScenario) return;
                                              const newPhases = [...tempDocScenario.phases];
                                              const newTriggers = newPhases[idx].escalationTriggers.filter((_, tIdx) => tIdx !== i);
                                              newPhases[idx] = { ...newPhases[idx], escalationTriggers: newTriggers };
                                              setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                            }}
                                            className="text-red-500 hover:text-red-400"
                                          >
                                            <i className="fas fa-trash-alt"></i>
                                          </button>
                                        </div>
                                        <div className="space-y-1">
                                          <p className="text-[7px] text-slate-500 uppercase">IF Learner Fails:</p>
                                          <input 
                                            type="text"
                                            value={trigger.ifLearnerFails}
                                            onChange={(e) => {
                                              if (!tempDocScenario) return;
                                              const newPhases = [...tempDocScenario.phases];
                                              const newTriggers = [...newPhases[idx].escalationTriggers];
                                              newTriggers[i] = { ...newTriggers[i], ifLearnerFails: e.target.value };
                                              newPhases[idx] = { ...newPhases[idx], escalationTriggers: newTriggers };
                                              setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                            }}
                                            className="w-full bg-slate-950/50 border border-white/10 rounded px-2 py-1 text-[9px] focus:outline-none"
                                          />
                                        </div>
                                        <div className="space-y-1">
                                          <p className="text-[7px] text-slate-500 uppercase">THEN Deteriorates:</p>
                                          <input 
                                            type="text"
                                            value={trigger.thenPatientDeteriorates}
                                            onChange={(e) => {
                                              if (!tempDocScenario) return;
                                              const newPhases = [...tempDocScenario.phases];
                                              const newTriggers = [...newPhases[idx].escalationTriggers];
                                              newTriggers[i] = { ...newTriggers[i], thenPatientDeteriorates: e.target.value };
                                              newPhases[idx] = { ...newPhases[idx], escalationTriggers: newTriggers };
                                              setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                            }}
                                            className="w-full bg-slate-950/50 border border-white/10 rounded px-2 py-1 text-[9px] focus:outline-none"
                                          />
                                        </div>
                                      </div>
                                    ) : (
                                      <>
                                        <p className="text-red-400 font-bold mb-1 print:text-black">IF: {trigger.ifLearnerFails}</p>
                                        <p className="text-slate-400 print:text-black">THEN: {trigger.thenPatientDeteriorates}</p>
                                      </>
                                    )}
                                  </div>
                                ))}
                                {isEditingDoc && (
                                  <button 
                                    onClick={() => {
                                      if (!tempDocScenario) return;
                                      const newPhases = [...tempDocScenario.phases];
                                      newPhases[idx] = { ...newPhases[idx], escalationTriggers: [...newPhases[idx].escalationTriggers, { ifLearnerFails: 'Failure condition', thenPatientDeteriorates: 'Deterioration effect' }] };
                                      setTempDocScenario({ ...tempDocScenario, phases: newPhases });
                                    }}
                                    className="w-full p-1 border border-dashed border-white/10 rounded text-[8px] text-slate-500 hover:text-slate-300"
                                  >
                                    + Add Trigger
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Attached Images Section */}
              <section className="space-y-4 pt-4 border-t border-white/5 print:border-black print:text-black">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest flex items-center gap-2 print:text-black print:text-xs">
                    <i className="fas fa-images print:hidden"></i>
                    Clinical Assets & Images
                  </h3>
                  {isEditingDoc && (
                    <button 
                      onClick={() => imageInputRef.current?.click()}
                      className="px-3 py-1 bg-indigo-600/20 text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-indigo-600/30 transition-all"
                    >
                      + Add Image
                    </button>
                  )}
                </div>
                
                <input 
                  ref={imageInputRef}
                  type="file"
                  multiple
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageUpload}
                />

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {(isEditingDoc ? tempDocScenario?.attachedImages : docModalScenario.attachedImages)?.map((img, idx) => (
                    <div key={idx} className="relative group aspect-square rounded-2xl overflow-hidden border border-white/10 bg-slate-950/40 print:border-black">
                      <img 
                        src={img} 
                        alt={`Attached ${idx + 1}`} 
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                      {isEditingDoc && (
                        <button 
                          onClick={() => removeAttachedImage(idx)}
                          className="absolute top-2 right-2 w-6 h-6 bg-red-500 rounded-lg flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                        >
                          <i className="fas fa-times text-[10px]"></i>
                        </button>
                      )}
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                        <span className="text-[8px] font-black text-white uppercase tracking-widest">View Image</span>
                      </div>
                    </div>
                  ))}
                  {(!(isEditingDoc ? tempDocScenario?.attachedImages : docModalScenario.attachedImages)?.length) && (
                    <div className="col-span-full py-8 border border-dashed border-white/5 rounded-2xl flex flex-col items-center justify-center opacity-30 print:hidden">
                      <i className="fas fa-image text-2xl mb-2"></i>
                      <p className="text-[9px] font-black uppercase tracking-widest">No images attached</p>
                    </div>
                  )}
                </div>
              </section>

              {/* Attached Documents Section */}
              <section className="space-y-4 pt-8 border-t border-white/5 print:border-black print:text-black">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest flex items-center gap-2 print:text-black print:text-xs">
                    <i className="fas fa-file-waveform print:hidden"></i>
                    Clinical Reports & Documents
                  </h3>
                  {isEditingDoc && (
                    <button 
                      onClick={() => clinicalDocInputRef.current?.click()}
                      className="px-3 py-1 bg-indigo-600/20 text-indigo-400 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-indigo-600/30 transition-all"
                    >
                      + Add Report
                    </button>
                  )}
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(isEditingDoc ? tempDocScenario?.attachedDocs : docModalScenario.attachedDocs)?.map((doc, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-slate-950/60 border border-white/5 rounded-xl group print:border-black print:bg-transparent">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <i className="fas fa-file-pdf text-indigo-400 print:text-black"></i>
                        <div className="flex flex-col overflow-hidden">
                          <span className="text-[10px] font-bold text-slate-300 truncate print:text-black">{doc.name}</span>
                          {doc.content && (
                            <span className="text-[8px] text-slate-500 truncate print:text-black">{doc.content.substring(0, 50)}...</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {doc.content && (
                          <button 
                            onClick={() => {
                              setSelectedDoc(doc);
                              setShowDocContent(true);
                            }}
                            className="p-1.5 text-indigo-400 hover:text-indigo-300 transition-colors"
                          >
                            <i className="fas fa-eye text-[10px]"></i>
                          </button>
                        )}
                        {isEditingDoc && (
                          <button 
                            onClick={() => removeAttachedDoc(idx)}
                            className="p-1.5 text-slate-500 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <i className="fas fa-trash-alt text-[10px]"></i>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {(!(isEditingDoc ? tempDocScenario?.attachedDocs : docModalScenario.attachedDocs)?.length) && (
                    <div className="col-span-full py-4 border border-dashed border-white/5 rounded-xl flex items-center justify-center opacity-30 print:hidden">
                      <p className="text-[9px] font-black uppercase tracking-widest">No reports attached</p>
                    </div>
                  )}
                </div>
              </section>

              {/* Source Authors Section */}
              <section className="pt-8 border-t border-white/5 space-y-3 print:border-black print:text-black">
                <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2 print:text-black print:text-xs">
                  <i className="fas fa-pen-nib print:hidden"></i>
                  Source Document Authors
                </h3>
                {isEditingDoc ? (
                  <input 
                    type="text"
                    placeholder="Enter original author(s) information..."
                    value={tempDocScenario?.sourceAuthors || ''}
                    onChange={(e) => setTempDocScenario(prev => prev ? { ...prev, sourceAuthors: e.target.value } : null)}
                    className="w-full text-[11px] text-slate-400 italic bg-slate-950/50 border border-white/10 rounded-lg px-4 py-2 focus:outline-none focus:border-indigo-500"
                  />
                ) : (
                  <p className="text-[11px] text-slate-400 italic print:text-black">
                    {docModalScenario.sourceAuthors || 'No author information available.'}
                  </p>
                )}
              </section>
            </div>

            <div className="p-6 md:p-8 bg-slate-950/50 border-t border-white/5 flex justify-end shrink-0 print:hidden">
              <button 
                onClick={() => {
                  if (isEditingDoc) {
                    handleSaveDocChanges();
                  }
                  setSelectedScenarioId(docModalScenario.id);
                  setDocModalOpen(false);
                }}
                className="px-8 py-3 bg-indigo-600 text-white rounded-xl font-black uppercase tracking-widest text-[11px] shadow-lg hover:bg-indigo-500 transition-all active:scale-95"
              >
                {isEditingDoc ? 'Save & Select Scenario' : 'Select Scenario'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Document Content Modal */}
      {showDocContent && selectedDoc && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-white/10 rounded-[2rem] shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200">
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-slate-900/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-500/20 rounded-xl flex items-center justify-center text-indigo-400">
                    <i className="fas fa-file-medical text-lg"></i>
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-white uppercase tracking-tight">{selectedDoc.name}</h3>
                    <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">Clinical Report Content</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowDocContent(false)}
                  className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <i className="fas fa-times"></i>
                </button>
              </div>
              <div className="p-8 overflow-y-auto custom-scrollbar">
                <div className="prose prose-invert prose-slate max-w-none">
                  <div className="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap font-medium">
                    {selectedDoc.content}
                  </div>
                </div>
              </div>
              <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end">
                <button 
                  onClick={() => setShowDocContent(false)}
                  className="px-6 py-2 bg-indigo-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-400 transition-all active:scale-95 shadow-lg shadow-indigo-500/20"
                >
                  Close Report
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
});

export default Dashboard;
