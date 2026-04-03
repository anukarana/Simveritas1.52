import React, { useState } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { FeedbackReport, SimulationConfig, SavedReport } from './types';

interface FeedbackViewProps {
  report: FeedbackReport;
  config: SimulationConfig | null;
  scenarioTitle?: string;
  patientName?: string;
  onReset: () => void;
  onSave?: (report: SavedReport) => void;
}

const FeedbackView: React.FC<FeedbackViewProps> = ({ report, config, scenarioTitle, patientName, onReset, onSave }) => {
  if (!report) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4">
        <i className="fas fa-triangle-exclamation text-4xl text-amber-500"></i>
        <p className="font-black uppercase tracking-widest text-xs">Report Data Unavailable</p>
        <button onClick={onReset} className="px-6 py-2 bg-white/5 rounded-xl hover:bg-white/10 transition-all text-[10px] font-black uppercase tracking-widest">Return to Command Center</button>
      </div>
    );
  }

  const strengths = report.strengths || [];
  const improvements = report.improvements || [];
  const clinicalAnalysis = report.clinicalAnalysis || [];
  const keyInsights = report.keyInsights || [];

  const displayTitle = scenarioTitle || config?.scenario.title || 'Clinical Encounter';
  const displayPatient = patientName || config?.scenario.patientProfile.name || 'Participant';

  const handlePrint = () => {
    try {
      // Ensure the window is focused for printing
      window.focus();
      // Use a small timeout to allow any pending UI updates to settle
      setTimeout(() => {
        window.print();
      }, 100);
    } catch (e) {
      console.error('Print failed:', e);
      // Fallback for some restricted environments
      try {
        document.execCommand('print', false, undefined);
      } catch (innerE) {
        console.warn('Could not open print dialog. Please try using your browser\'s print function (Ctrl+P / Cmd+P).');
      }
    }
  };

  const handleSave = () => {
    if (!onSave) return;
    const savedReport: SavedReport = {
      id: `report-${Date.now()}`,
      timestamp: Date.now(),
      scenarioTitle: config?.scenario.title || scenarioTitle || 'Clinical Encounter',
      patientName: config?.scenario.patientProfile.name || patientName || 'Participant',
      report: report
    };
    onSave(savedReport);
  };

  const generateHospitalReport = async () => {
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginLeft = 20;
    const marginRight = 20;
    const contentWidth = pageWidth - marginLeft - marginRight;
    let y = 20;

    const colors = {
      navy: [15, 23, 42],
      white: [255, 255, 255],
      blue: [59, 130, 246],
      emerald: [16, 185, 129],
      slate400: [148, 163, 184],
      slate600: [71, 85, 105],
      slate900: [15, 23, 42],
      border: [226, 232, 240],
    };

    const drawHeader = () => {
      // SimVeritas Logo (Stylized)
      doc.setFillColor(...colors.blue as [number, number, number]);
      doc.roundedRect(marginLeft, y, 10, 10, 2, 2, 'F');
      doc.setTextColor(...colors.white as [number, number, number]);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text('SV', marginLeft + 2.5, y + 6.5);

      doc.setTextColor(...colors.navy as [number, number, number]);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('SimVeritas', marginLeft + 14, y + 5);
      
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colors.slate600 as [number, number, number]);
      doc.text('Clinical Simulation Systems', marginLeft + 14, y + 9);

      doc.setTextColor(...colors.slate400 as [number, number, number]);
      doc.setFontSize(8);
      doc.text('REPORT ID: SV-' + Math.random().toString(36).substr(2, 9).toUpperCase(), pageWidth - marginRight, y + 5, { align: 'right' });
      doc.text('DATE: ' + new Date().toLocaleDateString(), pageWidth - marginRight, y + 9, { align: 'right' });

      y += 20;
      doc.setDrawColor(...colors.border as [number, number, number]);
      doc.setLineWidth(0.5);
      doc.line(marginLeft, y, pageWidth - marginRight, y);
      y += 15;
    };

    const drawSectionTitle = (title: string) => {
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...colors.blue as [number, number, number]);
      doc.text(title.toUpperCase(), marginLeft, y);
      y += 6;
      doc.setDrawColor(...colors.blue as [number, number, number]);
      doc.setLineWidth(0.2);
      doc.line(marginLeft, y, marginLeft + 20, y);
      y += 10;
    };

    drawHeader();

    // Report Title
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.navy as [number, number, number]);
    doc.text('Clinical Performance Report', marginLeft, y);
    y += 15;

    // Patient & Scenario Info
    doc.setFillColor(248, 250, 252); // slate-50
    doc.roundedRect(marginLeft, y, contentWidth, 30, 2, 2, 'F');
    
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.slate600 as [number, number, number]);
    doc.text('PATIENT NAME', marginLeft + 5, y + 8);
    doc.text('SCENARIO TITLE', marginLeft + 80, y + 8);
    doc.text('OVERALL SCORE', marginLeft + 150, y + 8);

    doc.setFontSize(11);
    doc.setTextColor(...colors.navy as [number, number, number]);
    doc.text(displayPatient, marginLeft + 5, y + 18);
    doc.text(displayTitle, marginLeft + 80, y + 18);
    
    doc.setFontSize(16);
    doc.setTextColor(...colors.blue as [number, number, number]);
    doc.text(`${report.overallScore ?? 0}%`, marginLeft + 150, y + 20);

    y += 45;

    // Executive Summary
    drawSectionTitle('Executive Summary');
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.navy as [number, number, number]);
    const summaryLines = doc.splitTextToSize(report.summary || 'No summary provided.', contentWidth);
    doc.text(summaryLines, marginLeft, y);
    y += summaryLines.length * 5 + 15;

    // Key Strengths
    if (strengths.length > 0) {
      drawSectionTitle('Key Strengths');
      strengths.forEach((s: string) => {
        doc.setFillColor(...colors.emerald as [number, number, number]);
        doc.circle(marginLeft + 2, y - 1, 1, 'F');
        doc.setFontSize(10);
        doc.setTextColor(...colors.navy as [number, number, number]);
        const lines = doc.splitTextToSize(s, contentWidth - 10);
        doc.text(lines, marginLeft + 6, y);
        y += lines.length * 5 + 2;
      });
      y += 10;
    }

    // Areas for Improvement
    if (improvements.length > 0) {
      if (y > pageHeight - 60) { doc.addPage(); y = 20; drawHeader(); }
      drawSectionTitle('Areas for Improvement');
      improvements.forEach((s: string) => {
        doc.setFillColor(239, 68, 68); // red-500
        doc.circle(marginLeft + 2, y - 1, 1, 'F');
        doc.setFontSize(10);
        doc.setTextColor(...colors.navy as [number, number, number]);
        const lines = doc.splitTextToSize(s, contentWidth - 10);
        doc.text(lines, marginLeft + 6, y);
        y += lines.length * 5 + 2;
      });
      y += 10;
    }

    // Clinical Analysis Table
    if (clinicalAnalysis.length > 0) {
      if (y > pageHeight - 80) { doc.addPage(); y = 20; drawHeader(); }
      drawSectionTitle('Clinical Decision Analysis');
      
      // Table Header
      doc.setFillColor(241, 245, 249);
      doc.rect(marginLeft, y, contentWidth, 8, 'F');
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...colors.slate600 as [number, number, number]);
      doc.text('ACTION', marginLeft + 2, y + 5);
      doc.text('APPROPRIATENESS', marginLeft + 60, y + 5);
      doc.text('RATIONALE', marginLeft + 100, y + 5);
      y += 12;

      clinicalAnalysis.forEach((item: any) => {
        const actionLines = doc.splitTextToSize(item.action, 55);
        const rationaleLines = doc.splitTextToSize(item.explanation, 70);
        const rowHeight = Math.max(actionLines.length, rationaleLines.length) * 4 + 4;

        if (y + rowHeight > pageHeight - 20) { doc.addPage(); y = 20; drawHeader(); }

        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.navy as [number, number, number]);
        doc.text(actionLines, marginLeft + 2, y);
        
        const isGood = item.appropriateness?.toLowerCase().includes('good') || item.appropriateness?.toLowerCase().includes('correct');
        doc.setTextColor(...(isGood ? colors.emerald : [239, 68, 68]) as [number, number, number]);
        doc.text(item.appropriateness, marginLeft + 60, y);
        
        doc.setTextColor(...colors.navy as [number, number, number]);
        doc.text(rationaleLines, marginLeft + 100, y);
        
        y += rowHeight;
        doc.setDrawColor(241, 245, 249);
        doc.line(marginLeft, y - 2, pageWidth - marginRight, y - 2);
        y += 4;
      });
    }

    // Footer
    const totalPages = (doc as any).internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(...colors.slate400 as [number, number, number]);
      doc.text(`SimVeritas Clinical Performance Report - Confidential - Page ${i} of ${totalPages}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
    }

    doc.save(`SimVeritas_Report_${displayPatient.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  const generateEvidencePack = async () => {
    if (!report.evidenceSources || 
        report.evidenceSources.length === 0) return;

    // Access jsPDF from window (loaded via CDN)
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginLeft = 20;
    const marginRight = 20;
    const contentWidth = pageWidth - marginLeft - marginRight;
    let y = 0; // current vertical position

    // ── Color palette (RGB) ──────────────────────────────
    const colors = {
      navy:        [15,  23,  42],   // slate-900
      white:       [255, 255, 255],
      blue:        [59,  130, 246],
      lightBlue:   [219, 234, 254],
      slate400:    [148, 163, 184],
      slate600:    [71,  85,  105],
      slate800:    [30,  41,  59],
      emerald:     [16,  185, 129],
      amber:       [245, 158, 11],
      purple:      [139, 92,  246],
      indigo:      [99,  102, 241],
      teal:        [20,  184, 166],
      cyan:        [6,   182, 212],
      border:      [51,  65,  85],
    };

    // ── Authority badge colors ───────────────────────────
    const badgeColors: Record<string, number[]> = {
      'Society Practice Guideline':  colors.blue,
      'National Clinical Guideline': colors.indigo,
      'Consensus Statement':         colors.purple,
      'Clinical Practice Guideline': colors.emerald,
      'Meta-Analysis':               colors.teal,
      'Systematic Review':           colors.cyan,
      'Clinical Reference':          colors.slate400,
    };

    // ── Helper: safe page break ──────────────────────────
    const checkPageBreak = (needed: number) => {
      if (y + needed > pageHeight - 25) {
        doc.addPage();
        y = 20;
        drawPageFooter();
      }
    };

    // ── Helper: wrapped text block ───────────────────────
    const drawWrappedText = (
      text: string,
      x: number,
      startY: number,
      maxWidth: number,
      fontSize: number,
      color: number[],
      fontStyle: string = 'normal',
      lineHeight: number = 1.5
    ): number => {
      doc.setFontSize(fontSize);
      doc.setTextColor(...color as [number,number,number]);
      doc.setFont('helvetica', fontStyle);
      const lines = doc.splitTextToSize(text, maxWidth);
      lines.forEach((line: string, i: number) => {
        checkPageBreak(fontSize * lineHeight * 0.352778 + 1);
        doc.text(line, x, startY + 
          (i * fontSize * lineHeight * 0.352778));
      });
      return startY + 
        (lines.length * fontSize * lineHeight * 0.352778);
    };

    // ── Helper: filled rounded rect ─────────────────────
    const drawRoundedRect = (
      x: number, rectY: number, 
      w: number, h: number,
      r: number, fillColor: number[],
      strokeColor?: number[]
    ) => {
      doc.setFillColor(
        ...fillColor as [number,number,number]
      );
      if (strokeColor) {
        doc.setDrawColor(
          ...strokeColor as [number,number,number]
        );
        doc.roundedRect(x, rectY, w, h, r, r, 'FD');
      } else {
        doc.roundedRect(x, rectY, w, h, r, r, 'F');
      }
    };

    // ── Helper: authority badge pill ────────────────────
    const drawBadge = (
      text: string,
      x: number, 
      badgeY: number,
      badgeColor: number[]
    ): number => {
      doc.setFontSize(6.5);
      doc.setFont('helvetica', 'bold');
      const textWidth = doc.getTextWidth(text);
      const padH = 3;
      const padV = 1.5;
      const badgeW = textWidth + padH * 2;
      const badgeH = 4.5 + padV * 2;

      // Badge background (10% opacity approximated with 
      // light tint)
      const tintColor = badgeColor.map(c => 
        Math.round(c + (255 - c) * 0.85)
      );
      drawRoundedRect(
        x, badgeY, badgeW, badgeH, 1.5, tintColor
      );

      // Badge text
      doc.setTextColor(
        ...badgeColor as [number,number,number]
      );
      doc.text(text, x + padH, badgeY + badgeH - padV - 1);

      return badgeW + 3; // return width consumed + gap
    };

    // ── Helper: horizontal rule ──────────────────────────
    const drawRule = (ruleY: number, color: number[]) => {
      doc.setDrawColor(...color as [number,number,number]);
      doc.setLineWidth(0.3);
      doc.line(marginLeft, ruleY, 
        pageWidth - marginRight, ruleY);
    };

    // ── Helper: page footer ──────────────────────────────
    const drawPageFooter = () => {
      const footerY = pageHeight - 12;
      drawRule(footerY - 3, colors.border);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colors.slate600 as 
        [number,number,number]);
      doc.text(
        'SimVeritas 1.5 — Evidence Pack | ' +
        'Retrieved from NCBI PubMed via Entrez E-utilities',
        marginLeft, footerY
      );
      doc.text(
        `Page ${doc.getCurrentPageInfo().pageNumber}`,
        pageWidth - marginRight, 
        footerY, 
        { align: 'right' }
      );
    };

    // ════════════════════════════════════════════════════
    // PAGE 1: COVER PAGE
    // ════════════════════════════════════════════════════

    // Full-page navy background
    drawRoundedRect(0, 0, pageWidth, pageHeight, 0, 
      colors.navy);

    // Top accent bar (blue gradient simulation)
    drawRoundedRect(0, 0, pageWidth, 3, 0, colors.blue);

    // Logo area
    y = 35;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.blue as 
      [number,number,number]);
    doc.text('SIMVERITAS 1.5', marginLeft, y);

    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.slate400 as 
      [number,number,number]);
    doc.text('Hybrid Neural Clinical Engine', 
      marginLeft, y + 5);

    // Divider
    y += 15;
    drawRule(y, colors.border);

    // Main title
    y += 18;
    doc.setFontSize(26);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.white as 
      [number,number,number]);
    const titleLines = doc.splitTextToSize(
      'Clinical Evidence Reference Pack', 
      contentWidth
    );
    doc.text(titleLines, marginLeft, y);
    y += titleLines.length * 10 + 4;

    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.slate400 as 
      [number,number,number]);
    doc.text(
      'Sources used to evaluate your clinical performance',
      marginLeft, y
    );
    y += 20;

    // Scenario info card
    drawRoundedRect(
      marginLeft, y, contentWidth, 42, 3, 
      [22, 33, 56], colors.border
    );
    
    y += 8;
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.slate400 as 
      [number,number,number]);
    doc.text('SCENARIO', marginLeft + 8, y);
    
    y += 5;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.white as 
      [number,number,number]);
    doc.text(
      displayTitle.toUpperCase(), 
      marginLeft + 8, y
    );

    y += 8;
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.slate400 as 
      [number,number,number]);
    doc.text('PATIENT', marginLeft + 8, y);
    doc.text(
      'MASTERY SCORE', 
      marginLeft + contentWidth / 2, y
    );
    doc.text(
      'GUIDELINE ADHERENCE', 
      marginLeft + contentWidth * 0.75, y
    );

    y += 5;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.white as 
      [number,number,number]);
    doc.text(displayPatient, marginLeft + 8, y);
    
    doc.setTextColor(...colors.blue as 
      [number,number,number]);
    doc.text(
      `${report.overallScore ?? 0}%`, 
      marginLeft + contentWidth / 2, y
    );
    
    doc.setTextColor(...colors.amber as 
      [number,number,number]);
    doc.text(
      `${report.evidenceBasedScore ?? 0}%`, 
      marginLeft + contentWidth * 0.75, y
    );

    y += 20;

    // Source count summary
    const sourceCounts: Record<string, number> = {};
    report.evidenceSources.forEach(s => {
      sourceCounts[s.sourceType] = 
        (sourceCounts[s.sourceType] || 0) + 1;
    });

    const countEntries = Object.entries(sourceCounts);
    const pillW = contentWidth / Math.min(
      countEntries.length, 3
    );
    
    countEntries.forEach(([type, count], i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const pillX = marginLeft + col * pillW;
      const pillY = y + row * 18;
      const badgeColor = badgeColors[type] || 
        colors.slate400;
      
      checkPageBreak(20);
      drawRoundedRect(
        pillX + 1, pillY, pillW - 2, 14, 2, 
        [22, 33, 56], colors.border
      );
      
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(
        ...badgeColor as [number,number,number]
      );
      doc.text(
        String(count), 
        pillX + 6, pillY + 10
      );
      
      doc.setFontSize(6);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colors.slate400 as 
        [number,number,number]);
      const shortType = type
        .replace('Society Practice ', '')
        .replace('National Clinical ', '')
        .replace('Clinical Practice ', '');
      doc.text(shortType, pillX + 18, pillY + 6);
      doc.setFontSize(7);
      doc.text(type.split(' ').slice(0, 2).join(' '), 
        pillX + 18, pillY + 11);
    });

    y += Math.ceil(countEntries.length / 3) * 18 + 15;

    // Generated date + disclaimer
    drawRule(y, colors.border);
    y += 8;
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.slate400 as 
      [number,number,number]);
    doc.text(
      `Generated: ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', 
        month: 'long', day: 'numeric'
      })}`, 
      marginLeft, y
    );
    
    y += 6;
    const disclaimerLines = doc.splitTextToSize(
      'This evidence pack was automatically compiled from ' +
      'NCBI PubMed and StatPearls via the Entrez E-utilities ' +
      'API. Sources are prioritized by authority level: ' +
      'Society Guidelines → National Guidelines → Consensus ' +
      'Statements → Systematic Reviews. Always apply clinical ' +
      'judgment and consult current institutional protocols.',
      contentWidth
    );
    doc.text(disclaimerLines, marginLeft, y);

    // ════════════════════════════════════════════════════
    // PAGE 2+: EVIDENCE SOURCES
    // ════════════════════════════════════════════════════

    doc.addPage();
    y = 20;
    drawPageFooter();

    // Section header
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colors.white as 
      [number,number,number]);
    doc.text('Evidence Sources', marginLeft, y);
    
    y += 5;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colors.slate400 as 
      [number,number,number]);
    doc.text(
      `${report.evidenceSources.length} sources retrieved ` +
      `· Sorted by authority level`, 
      marginLeft, y
    );
    
    y += 4;
    drawRule(y, colors.border);
    y += 10;

    // Sort sources by authority before rendering
    const authorityOrder: Record<string, number> = {
      'Society Practice Guideline': 1,
      'National Clinical Guideline': 2,
      'Consensus Statement': 3,
      'Clinical Practice Guideline': 4,
      'Meta-Analysis': 5,
      'Systematic Review': 6,
      'Clinical Reference': 7
    };

    const sortedSources = [...report.evidenceSources]
      .sort((a, b) =>
        (authorityOrder[a.sourceType] || 9) -
        (authorityOrder[b.sourceType] || 9)
      );

    // Render each source card
    sortedSources.forEach((source, index) => {
      const badgeColor = badgeColors[source.sourceType] 
        || colors.slate400;

      // Estimate card height for page break check
      const titleLines = doc.splitTextToSize(
        source.title, contentWidth - 10
      );
      const abstractLines = source.abstract && 
        source.abstract !== 'Abstract not available'
        ? doc.splitTextToSize(source.abstract, contentWidth - 10)
          .slice(0, 6)
        : [];
      
      const cardHeight = 
        8 +          // badge row
        (titleLines.length * 5.5) + 4 + // title
        6 +          // authors/journal
        (abstractLines.length * 4.2) + 4 + // abstract
        8 +          // PMID + link row
        6;           // bottom padding

      checkPageBreak(cardHeight + 6);

      const cardStartY = y;

      // Card background
      drawRoundedRect(
        marginLeft, y, contentWidth, cardHeight, 3,
        [22, 33, 56], colors.border
      );

      y += 7;

      // Badge + index number + PMID on same row
      const indexBadgeW = drawBadge(
        `${index + 1}`, 
        marginLeft + 6, y - 4, colors.slate400
      );
      
      const typeBadgeW = drawBadge(
        source.sourceType.toUpperCase(), 
        marginLeft + 6 + indexBadgeW, 
        y - 4, badgeColor
      );

      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colors.slate600 as 
        [number,number,number]);
      doc.text(
        `PMID: ${source.pmid}`, 
        pageWidth - marginRight, y - 1.5, 
        { align: 'right' }
      );

      y += 5;

      // Title
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...colors.white as 
        [number,number,number]);
      const wrappedTitle = doc.splitTextToSize(
        source.title, contentWidth - 10
      );
      wrappedTitle.forEach((line: string) => {
        doc.text(line, marginLeft + 6, y);
        y += 5;
      });

      y += 2;

      // Authors + Journal + Year
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colors.slate400 as 
        [number,number,number]);
      
      const metaLine = [
        source.authors !== 'Authors not available' 
          ? `${source.authors} et al.` : '',
        source.journal !== 'Journal not available' 
          ? source.journal : '',
        source.year !== 'Year not available' 
          ? `(${source.year})` : ''
      ].filter(Boolean).join(' · ');
      
      const metaLines = doc.splitTextToSize(
        metaLine, contentWidth - 10
      );
      metaLines.slice(0, 2).forEach((line: string) => {
        doc.text(line, marginLeft + 6, y);
        y += 4;
      });

      y += 2;

      // Abstract (max 6 lines)
      if (abstractLines.length > 0) {
        doc.setFontSize(7.5);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(
          ...colors.slate400 as [number,number,number]
        );
        abstractLines.forEach((line: string) => {
          doc.text(line, marginLeft + 6, y);
          y += 4;
        });
        if (doc.splitTextToSize(
          source.abstract, contentWidth - 10
        ).length > 6) {
          doc.setTextColor(...colors.slate600 as 
            [number,number,number]);
          doc.text('[Abstract truncated...]', 
            marginLeft + 6, y);
          y += 4;
        }
        y += 2;
      }

      // PubMed URL row
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colors.blue as 
        [number,number,number]);
      doc.textWithLink(
        `pubmed.ncbi.nlm.nih.gov/${source.pmid}/`,
        marginLeft + 6, y,
        { url: `https://pubmed.ncbi.nlm.nih.gov/${source.pmid}/` }
      );

      // DOI if available
      if (source.doi) {
        doc.setTextColor(...colors.slate400 as 
          [number,number,number]);
        doc.text(
          `DOI: ${source.doi}`, 
          pageWidth - marginRight, y, 
          { align: 'right' }
        );
      }

      y += 10; // gap between cards
    });

    // ════════════════════════════════════════════════════
    // FINAL PAGE: CLINICAL DECISION MATRIX CITATIONS
    // ════════════════════════════════════════════════════

    const actionsWithRefs = (report.clinicalAnalysis || [])
      .filter(a => a.guidelineReference && 
        a.guidelineReference.trim().length > 0);

    if (actionsWithRefs.length > 0) {
      doc.addPage();
      y = 20;
      drawPageFooter();

      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...colors.white as 
        [number,number,number]);
      doc.text('Guideline Citations', marginLeft, y);

      y += 5;
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colors.slate400 as 
        [number,number,number]);
      doc.text(
        'Each learner action mapped to its authoritative source',
        marginLeft, y
      );

      y += 4;
      drawRule(y, colors.border);
      y += 10;

      actionsWithRefs.forEach((item, i) => {
        const isGood = 
          item.appropriateness?.toLowerCase()
            .includes('good') ||
          item.appropriateness?.toLowerCase()
            .includes('correct') ||
          item.appropriateness?.toLowerCase()
            .includes('high');

        const statusColor = isGood 
          ? colors.emerald : colors.amber;
        const badgeColor = item.sourceTypeBadge
          ? (badgeColors[item.sourceTypeBadge] 
            || colors.slate400)
          : colors.slate400;

        const actionLines = doc.splitTextToSize(
          `"${item.action}"`, contentWidth - 10
        );
        const explanationLines = doc.splitTextToSize(
          item.explanation, contentWidth - 10
        ).slice(0, 4);
        const refLines = doc.splitTextToSize(
          item.guidelineReference, contentWidth - 10
        );

        const cardH = 7 + 
          actionLines.length * 5 + 3 +
          explanationLines.length * 4 + 3 +
          refLines.length * 4 + 8;

        checkPageBreak(cardH + 6);

        // Card
        drawRoundedRect(
          marginLeft, y, contentWidth, cardH, 3,
          [22, 33, 56], colors.border
        );

        // Left status accent bar
        drawRoundedRect(
          marginLeft, y, 3, cardH, 1.5, statusColor
        );

        y += 6;

        // Appropriateness badge + index
        doc.setFontSize(7);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(
          ...statusColor as [number,number,number]
        );
        doc.text(
          `${i + 1}. ${item.appropriateness}`,
          marginLeft + 8, y
        );
        y += 5;

        // Action text
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colors.white as 
          [number,number,number]);
        actionLines.forEach((line: string) => {
          doc.text(line, marginLeft + 8, y);
          y += 5;
        });
        y += 1;

        // Explanation
        doc.setFontSize(7.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...colors.slate400 as 
          [number,number,number]);
        explanationLines.forEach((line: string) => {
          doc.text(line, marginLeft + 8, y);
          y += 4;
        });
        y += 2;

        // Guideline reference with badge
        if (item.sourceTypeBadge) {
          drawBadge(
            item.sourceTypeBadge.toUpperCase(),
            marginLeft + 8, y - 3, badgeColor
          );
          y += 4;
        }

        doc.setFontSize(7.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(
          ...badgeColor as [number,number,number]
        );

        // Make PMID portion a clickable link
        const pmidMatch = item.guidelineReference
          .match(/PMID\s*(\d+)/);
        if (pmidMatch) {
          const refText = item.guidelineReference
            .replace(/PMID\s*\d+/, '').trim()
            .replace(/—$/, '').trim();
          
          doc.setTextColor(...colors.slate400 as 
            [number,number,number]);
          const refLinesFmt = doc.splitTextToSize(
            refText, contentWidth - 18
          );
          refLinesFmt.forEach((line: string) => {
            doc.text(line, marginLeft + 8, y);
            y += 4;
          });
          
          doc.setTextColor(
            ...badgeColor as [number,number,number]
          );
          doc.textWithLink(
            `PMID ${pmidMatch[1]} →`,
            marginLeft + 8, y,
            { url: `https://pubmed.ncbi.nlm.nih.gov/${pmidMatch[1]}/` }
          );
        } else {
          refLines.forEach((line: string) => {
            doc.text(line, marginLeft + 8, y);
            y += 4;
          });
        }

        y += 10;
      });
    }

    // ════════════════════════════════════════════════════
    // SAVE THE PDF
    // ════════════════════════════════════════════════════

    const safeScenario = displayTitle
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()
      .slice(0, 30);
    const dateStr = new Date()
      .toISOString()
      .slice(0, 10);
    
    doc.save(
      `SimVeritas_EvidencePack_${safeScenario}_${dateStr}.pdf`
    );

    return doc.output('datauristring').split(',')[1];
  };

  return (
    <div id="feedback-view-root" className="max-w-5xl mx-auto p-6 md:p-12 animate-fade-in text-slate-100">
      <div id="feedback-card" className="bg-slate-900 border border-white/5 rounded-[3rem] shadow-2xl overflow-hidden">
        {/* Header Section */}
        <div className="p-8 md:p-12 border-b border-white/5 bg-slate-900/50 backdrop-blur-xl flex flex-col md:flex-row md:items-center justify-between gap-8">
          <div className="flex items-center gap-6">
            <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-2xl shadow-blue-500/20 border border-blue-400/30">
              <span className="text-2xl font-black tracking-tighter">SV</span>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-black uppercase tracking-[0.3em] text-blue-400">SimVeritas</span>
                <span className="w-1 h-1 rounded-full bg-slate-700"></span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Clinical Report</span>
              </div>
              <h1 className="text-3xl font-black text-white uppercase tracking-tighter leading-none">{displayTitle}</h1>
              <p className="text-slate-400 text-sm mt-2 font-medium">Patient: <span className="text-white">{displayPatient}</span></p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={generateHospitalReport}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase tracking-[0.2em] rounded-xl transition-all shadow-xl shadow-blue-900/20 flex items-center gap-2 active:scale-95"
            >
              <i className="fas fa-file-medical text-sm"></i>
              Hospital Report
            </button>
            <button 
              onClick={generateEvidencePack}
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-black uppercase tracking-[0.2em] rounded-xl transition-all shadow-xl shadow-emerald-900/20 flex items-center gap-2 active:scale-95"
            >
              <i className="fas fa-book-medical text-sm"></i>
              Evidence Pack
            </button>
            <button 
              onClick={handlePrint}
              className="p-3 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white rounded-xl transition-all active:scale-95"
              title="Print Report"
            >
              <i className="fas fa-print"></i>
            </button>
            <button 
              onClick={handleSave}
              className="p-3 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white rounded-xl transition-all active:scale-95"
              title="Save to Registry"
            >
              <i className="fas fa-save"></i>
            </button>
            <button 
              onClick={onReset}
              className="p-3 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white rounded-xl transition-all active:scale-95"
              title="Close Report"
            >
              <i className="fas fa-times"></i>
            </button>
          </div>
        </div>

        <div id="feedback-header" className="bg-slate-800/50 p-10 border-b border-white/5">
          <div className="flex flex-col md:flex-row justify-between items-start gap-8 mb-10">
            <div>
              <h2 className="text-4xl font-black text-white tracking-tight mb-2">Clinical Debrief</h2>
              <div className="flex flex-wrap gap-4 items-center mt-4">
                <div className="bg-blue-500/10 px-4 py-2 rounded-xl border border-blue-500/20">
                  <p className="text-[9px] font-black text-blue-400 uppercase tracking-widest mb-0.5">Scenario</p>
                  <p className="text-sm font-bold text-white">{displayTitle}</p>
                </div>
                <div className="bg-emerald-500/10 px-4 py-2 rounded-xl border border-emerald-500/20">
                  <p className="text-[9px] font-black text-emerald-400 uppercase tracking-widest mb-0.5">Patient</p>
                  <p className="text-sm font-bold text-white">{displayPatient}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 justify-end">
              <div className="bg-slate-950 p-4 rounded-2xl border border-white/5 text-center min-w-[130px] shadow-xl">
                <div className="text-2xl font-black text-blue-400 mb-0.5">{report?.overallScore ?? 0}%</div>
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">Mastery Score</div>
              </div>
              <div className="bg-slate-950 p-4 rounded-2xl border border-white/5 text-center min-w-[130px] shadow-xl">
                <div className="text-2xl font-black text-emerald-400 mb-0.5">{report?.clinicalAccuracy ?? 0}%</div>
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">Clinical Accuracy</div>
              </div>
              <div className="bg-slate-950 p-4 rounded-2xl border border-white/5 text-center min-w-[130px] shadow-xl">
                <div className="text-2xl font-black text-indigo-400 mb-0.5">{report?.communicationScore ?? 0}%</div>
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">Communication</div>
              </div>
              <div className="bg-slate-950 p-4 rounded-2xl border border-white/5 text-center min-w-[130px] shadow-xl border-amber-500/20">
                <div className="text-2xl font-black text-amber-400 mb-0.5">{report?.evidenceBasedScore ?? 0}%</div>
                <div className="text-[9px] font-black uppercase tracking-widest text-amber-500/70">Guideline Adherence</div>
              </div>
            </div>
          </div>
          
          <div className="bg-slate-950 p-8 rounded-[2rem] border border-white/5">
            <h3 className="text-xs font-black uppercase text-blue-400 tracking-[0.2em] mb-4">Executive Case Summary</h3>
            <p className="text-slate-200 leading-relaxed text-lg font-medium">{report?.summary || 'Performance synthesis complete.'}</p>
          </div>
        </div>

        {/* Competencies Section */}
        <div className="p-10 grid grid-cols-1 md:grid-cols-2 gap-10">
          <div className="space-y-6">
            <h3 className="text-lg font-black text-white flex items-center gap-3 uppercase tracking-tight">
              <i className="fas fa-circle-check text-emerald-500"></i>
              Core Strengths
            </h3>
            <ul className="space-y-4">
              {strengths.length > 0 ? strengths.map((s, i) => (
                <li key={i} className="text-[15px] text-slate-300 flex gap-4 leading-relaxed font-medium bg-emerald-500/5 p-4 rounded-2xl border border-emerald-500/10">
                  <span className="text-emerald-500 font-black">0{i+1}</span> {s}
                </li>
              )) : <li className="text-slate-500 italic">No specific strengths isolated.</li>}
            </ul>
          </div>

          <div className="space-y-6">
            <h3 className="text-lg font-black text-white flex items-center gap-3 uppercase tracking-tight">
              <i className="fas fa-arrow-trend-up text-blue-400"></i>
              Optimization Areas
            </h3>
            <ul className="space-y-4">
              {improvements.length > 0 ? improvements.map((s, i) => (
                <li key={i} className="text-[15px] text-slate-300 flex gap-4 leading-relaxed font-medium bg-blue-500/5 p-4 rounded-2xl border border-blue-500/10">
                  <span className="text-blue-400 font-black">0{i+1}</span> {s}
                </li>
              )) : <li className="text-slate-500 italic">No critical improvements isolated.</li>}
            </ul>
          </div>
        </div>

        {keyInsights.length > 0 && (
          <div className="px-10 pb-8 border-b border-white/5">
            <h3 className="text-xs font-black uppercase text-amber-400 tracking-[0.2em] mb-4 flex items-center gap-3">
              <i className="fas fa-bolt-lightning"></i>
              Key Insights
            </h3>
            <div className="flex flex-wrap gap-3">
              {keyInsights.map((insight, idx) => (
                <div key={idx} className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/10 rounded-2xl px-4 py-3 text-[13px] text-slate-300 font-medium leading-snug">
                  <span className="text-amber-400 font-black mt-0.5 shrink-0">•</span>
                  <span>{insight}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Detailed Analysis */}
        <div className="p-6 border-t border-white/5 bg-slate-950/30">
          <h3 className="text-lg font-black text-white mb-4 uppercase tracking-tight">Clinical Decision Matrix</h3>
          <div className="space-y-3">
            {clinicalAnalysis.length > 0 
              ? clinicalAnalysis.map((item, i) => (
              <div key={i} 
                className="bg-slate-900 p-5 rounded-2xl 
                border border-white/5 shadow-inner">
                
                {/* Header row */}
                <div className="flex flex-col md:flex-row 
                  justify-between items-start gap-3 mb-3">
                  <span className="text-[11px] font-black 
                    text-slate-500 uppercase tracking-widest">
                    Encounter Action Point
                  </span>
                  <span className={`text-[10px] font-black px-4 
                    py-1.5 rounded-full uppercase tracking-widest 
                    border shrink-0 ${
                    (item.appropriateness?.toLowerCase()
                      .includes('good') || 
                     item.appropriateness?.toLowerCase()
                      .includes('correct') || 
                     item.appropriateness?.toLowerCase()
                      .includes('high'))
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}>
                    {item.appropriateness}
                  </span>
                </div>

                {/* Action */}
                <p className="text-[14px] font-black text-white 
                  mb-2 leading-tight">
                  "{item.action}"
                </p>

                {/* Explanation */}
                <p className="text-[13px] text-slate-400 
                  leading-relaxed font-medium mb-3">
                  {item.explanation}
                </p>

                {/* Guideline reference with source type badge */}
                {item.guidelineReference && (
                  <div className="flex flex-wrap items-center 
                    gap-2 mt-3 pt-3 border-t border-white/5">
                    
                    {/* Source type authority badge */}
                    {item.sourceTypeBadge && (
                      <span className={`text-[8px] font-black 
                        px-2.5 py-1 rounded-full uppercase 
                        tracking-widest border shrink-0 ${
                        item.sourceTypeBadge === 
                          'Society Practice Guideline'
                        ? 'bg-blue-600/15 text-blue-300 border-blue-500/30'
                        : item.sourceTypeBadge === 
                          'National Clinical Guideline'
                        ? 'bg-indigo-600/15 text-indigo-300 border-indigo-500/30'
                        : item.sourceTypeBadge === 
                          'Consensus Statement'
                        ? 'bg-purple-600/15 text-purple-300 border-purple-500/30'
                        : item.sourceTypeBadge === 
                          'Meta-Analysis'
                        ? 'bg-teal-600/15 text-teal-300 border-teal-500/30'
                        : item.sourceTypeBadge === 
                          'Systematic Review'
                        ? 'bg-cyan-600/15 text-cyan-300 border-cyan-500/30'
                        : 'bg-slate-600/15 text-slate-400 border-slate-500/30'
                      }`}>
                        {item.sourceTypeBadge === 
                          'Society Practice Guideline' && 
                          <i className="fas fa-landmark mr-1"></i>}
                        {item.sourceTypeBadge === 
                          'National Clinical Guideline' && 
                          <i className="fas fa-flag mr-1"></i>}
                        {item.sourceTypeBadge === 
                          'Consensus Statement' && 
                          <i className="fas fa-users mr-1"></i>}
                        {item.sourceTypeBadge}
                      </span>
                    )}

                    {/* Guideline name + PMID with PubMed link */}
                    <span className="text-[11px] text-slate-400 
                      font-medium flex items-center gap-2 flex-wrap">
                      <i className="fas fa-book-open 
                        text-blue-400/60 text-xs"></i>
                      {item.guidelineReference.includes('PMID') ? (
                        <>
                          {/* Split name from PMID for linking */}
                          {item.guidelineReference
                            .split('—')[0]?.trim() || 
                            item.guidelineReference}
                          {item.guidelineReference.includes('PMID') && (
                            <a
                              id={`pubmed-link-${i}`}
                              href={`https://pubmed.ncbi.nlm.nih.gov/${
                                item.guidelineReference
                                  .match(/PMID\s*(\d+)/)?.[1]
                              }/`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center 
                                gap-1 text-blue-400 hover:text-blue-300 
                                font-black text-[9px] bg-blue-500/10 
                                hover:bg-blue-500/20 px-2 py-0.5 
                                rounded-lg border border-blue-500/20 
                                transition-all uppercase tracking-widest"
                            >
                              <i className="fas fa-arrow-up-right-from-square text-[8px]"></i>
                              {item.guidelineReference
                                .match(/PMID\s*\d+/)?.[0]}
                            </a>
                          )}
                        </>
                      ) : (
                        item.guidelineReference
                      )}
                    </span>
                  </div>
                )}
              </div>
            )) : (
              <p className="text-slate-500 italic text-center py-10">
                In-depth decision mapping unavailable.
              </p>
            )}
          </div>
        </div>

        {/* Evidence Sources */}
        {report.evidenceSources && report.evidenceSources.length > 0 && (
          <div className="p-10 border-t border-white/5 bg-slate-900/50">
            <h3 className="text-lg font-black text-white mb-6 uppercase tracking-tight flex items-center gap-3">
              <i className="fas fa-book-medical text-blue-400"></i>
              Evidence Sources
            </h3>
            <div className="space-y-6">
              {report.evidenceSources.map((source, i) => {
                const getSourceBadgeStyle = (sourceType: string) => {
                  switch(sourceType) {
                    case 'Society Practice Guideline':
                      return {
                        classes: 'bg-blue-600/15 text-blue-300 border-blue-500/30',
                        icon: 'fa-landmark',
                        description: 'Endorsed by a professional medical society'
                      };
                    case 'National Clinical Guideline':
                      return {
                        classes: 'bg-indigo-600/15 text-indigo-300 border-indigo-500/30',
                        icon: 'fa-flag',
                        description: 'Published by a national health authority'
                      };
                    case 'Consensus Statement':
                      return {
                        classes: 'bg-purple-600/15 text-purple-300 border-purple-500/30',
                        icon: 'fa-users',
                        description: 'Expert consensus from multiple institutions'
                      };
                    case 'Clinical Practice Guideline':
                      return {
                        classes: 'bg-emerald-600/15 text-emerald-300 border-emerald-500/30',
                        icon: 'fa-file-medical',
                        description: 'Peer-reviewed clinical practice guideline'
                      };
                    case 'Meta-Analysis':
                      return {
                        classes: 'bg-teal-600/15 text-teal-300 border-teal-500/30',
                        icon: 'fa-chart-bar',
                        description: 'Statistical synthesis of multiple studies'
                      };
                    case 'Systematic Review':
                      return {
                        classes: 'bg-cyan-600/15 text-cyan-300 border-cyan-500/30',
                        icon: 'fa-magnifying-glass-chart',
                        description: 'Comprehensive systematic literature review'
                      };
                    default:
                      return {
                        classes: 'bg-slate-600/15 text-slate-400 border-slate-500/30',
                        icon: 'fa-book',
                        description: 'Clinical reference'
                      };
                  }
                };
                const badge = getSourceBadgeStyle(source.sourceType);
                return (
                  <div key={i} className="bg-slate-900 border 
                    border-white/5 rounded-2xl p-5 
                    hover:border-blue-500/20 transition-all group">

                    {/* Authority badge row */}
                    <div className="flex items-start 
                      justify-between mb-3 flex-wrap gap-2">
                      <div className="flex flex-col gap-1">
                        <span className={`text-[9px] font-black 
                          px-3 py-1 rounded-full uppercase 
                          tracking-widest border inline-flex 
                          items-center gap-1.5 w-fit 
                          ${badge.classes}`}>
                          <i className={`fas ${badge.icon} text-[8px]`}>
                          </i>
                          {source.sourceType}
                        </span>
                        <span className="text-[8px] text-slate-600 
                          font-medium ml-1">
                          {badge.description}
                        </span>
                      </div>
                      <span className="text-[9px] font-black 
                        text-slate-600 uppercase tracking-widest 
                        shrink-0">
                        PMID: {source.pmid}
                      </span>
                    </div>

                    {/* Title */}
                    <p className="text-[14px] font-black text-white 
                      leading-snug mb-2 
                      group-hover:text-blue-300 transition-colors">
                      {source.title}
                    </p>

                    {/* Authors + Journal + Year */}
                    <p className="text-[11px] text-slate-500 
                      font-medium mb-3">
                      {source.authors && `${source.authors} et al. `}
                      <span className="text-slate-400 italic">
                        {source.journal}
                      </span>
                      {source.year && ` (${source.year})`}
                    </p>

                    {/* Abstract */}
                    {source.abstract && 
                      source.abstract !== 'Abstract not available' && (
                      <p className="text-[12px] text-slate-400 
                        leading-relaxed font-medium 
                        line-clamp-3 mb-4">
                        {source.abstract}...
                      </p>
                    )}

                    {/* Verified PubMed link */}
                    <a
                      id={`evidence-pubmed-link-${i}`}
                      href={`https://pubmed.ncbi.nlm.nih.gov/${source.pmid}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 
                        text-[10px] font-black uppercase 
                        tracking-widest text-blue-400 
                        hover:text-blue-300 transition-colors 
                        bg-blue-500/5 hover:bg-blue-500/10 
                        px-4 py-2 rounded-xl border 
                        border-blue-500/10 hover:border-blue-500/30"
                    >
                      <i className="fas fa-arrow-up-right-from-square 
                        text-xs"></i>
                      View on PubMed — Verified Direct Link
                    </a>

                    {/* DOI link if available */}
                    {source.doi && (
                      <a
                        id={`evidence-doi-link-${i}`}
                        href={`https://doi.org/${source.doi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 inline-flex items-center 
                          gap-2 text-[10px] font-black uppercase 
                          tracking-widest text-slate-500 
                          hover:text-slate-300 transition-colors 
                          bg-slate-500/5 hover:bg-slate-500/10 
                          px-4 py-2 rounded-xl border 
                          border-slate-500/10 
                          hover:border-slate-500/30"
                      >
                        <i className="fas fa-link text-xs"></i>
                        DOI
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
            
            <div className="mt-6 p-5 bg-slate-950/60 rounded-2xl 
              border border-white/5 space-y-3">
              
              {/* Evidence hierarchy legend */}
              <p className="text-[9px] font-black text-slate-500 
                uppercase tracking-widest mb-3">
                Evidence Authority Legend
              </p>
              <div className="flex flex-wrap gap-2 mb-4">
                {[
                  { type: 'Society Practice Guideline', 
                    color: 'text-blue-300', icon: 'fa-landmark' },
                  { type: 'National Clinical Guideline', 
                    color: 'text-indigo-300', icon: 'fa-flag' },
                  { type: 'Consensus Statement', 
                    color: 'text-purple-300', icon: 'fa-users' },
                  { type: 'Clinical Practice Guideline', 
                    color: 'text-emerald-300', icon: 'fa-file-medical' },
                  { type: 'Meta-Analysis', 
                    color: 'text-teal-300', icon: 'fa-chart-bar' },
                  { type: 'Systematic Review', 
                    color: 'text-cyan-300', icon: 'fa-magnifying-glass-chart' },
                ].map(item => (
                  <span key={item.type} 
                    className={`text-[8px] font-black 
                    uppercase tracking-widest ${item.color} 
                    flex items-center gap-1`}>
                    <i className={`fas ${item.icon} text-[8px]`}></i>
                    {item.type}
                  </span>
                ))}
              </div>

              {/* Attribution */}
              <div className="flex items-start gap-3 
                pt-3 border-t border-white/5">
                <i className="fas fa-database text-slate-600 
                  text-sm mt-0.5 shrink-0"></i>
                <p className="text-[10px] text-slate-600 
                  font-medium leading-relaxed">
                  Evidence automatically retrieved from 
                  <span className="text-slate-400 font-black"> 
                    NCBI PubMed
                  </span> via Entrez E-utilities. Sources are 
                  prioritized by authority: Society Guidelines → 
                  National Guidelines → Consensus Statements → 
                  Systematic Reviews. All PubMed links are direct 
                  and verified. Always apply clinical judgment and 
                  consult current institutional protocols.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div id="feedback-footer-actions" className="p-10 bg-slate-800/30 border-t border-white/5 flex flex-col md:flex-row items-center justify-center gap-4 print:hidden">
          <button 
            id="print-report-button"
            type="button"
            onClick={handlePrint}
            className="w-full md:w-auto px-10 py-4 bg-slate-700 text-white rounded-[2rem] font-black uppercase tracking-[0.2em] text-[13px] hover:bg-slate-600 transition-all shadow-xl active:scale-95 flex items-center justify-center gap-3"
          >
            <i className="fas fa-print"></i>
            Print Report
          </button>
          {report.evidenceSources && 
            report.evidenceSources.length > 0 && (
            <>
              <button
                id="download-evidence-pack-button"
                type="button"
                onClick={generateEvidencePack}
                className="w-full md:w-auto px-10 py-4 
                  bg-indigo-700 text-white rounded-[2rem] 
                  font-black uppercase tracking-[0.2em] 
                  text-[13px] hover:bg-indigo-600 
                  transition-all shadow-xl 
                  shadow-indigo-500/10 active:scale-95 
                  flex items-center justify-center gap-3"
              >
                <i className="fas fa-file-arrow-down"></i>
                Download Evidence Pack
              </button>
            </>
          )}
          {onSave && config && (
            <button 
              id="save-and-exit-button"
              onClick={handleSave}
              className="w-full md:w-auto px-10 py-4 bg-emerald-600 text-white rounded-[2rem] font-black uppercase tracking-[0.2em] text-[13px] hover:bg-emerald-500 transition-all shadow-xl shadow-emerald-500/10 active:scale-95 flex items-center justify-center gap-3"
            >
              <i className="fas fa-save"></i>
              Save and Exit
            </button>
          )}
          <button 
            id="return-to-command-center-button"
            onClick={onReset}
            className={`w-full md:w-auto px-10 py-4 rounded-[2rem] font-black uppercase tracking-[0.2em] text-[13px] transition-all shadow-xl active:scale-95 flex items-center justify-center gap-3 ${
              onSave && config 
              ? 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white' 
              : 'bg-blue-600 text-white hover:bg-blue-500 shadow-blue-500/10'
            }`}
          >
            <i className="fas fa-door-open"></i>
            {onSave && config ? 'Exit Without Saving' : 'Return to Command Center'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FeedbackView;