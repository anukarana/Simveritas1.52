
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import { Server as SocketServer } from "socket.io";
import { createServer as createHttpServer } from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NCBI API Key (free): Sign up at ncbi.nlm.nih.gov/account
// Add NCBI_API_KEY=your_key_here to .env.local
// Without a key, rate limit is 3 req/sec (sufficient for this app)

async function startServer() {
  const app = express();
  const httpServer = createHttpServer(app);
  const io = new SocketServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e7 // 10MB limit for large payloads
  });
  const PORT = parseInt(process.env.PORT || "8080", 10);

  // Socket.io logic
  io.on("connection", (socket) => {
    console.log(`[Socket] User connected: ${socket.id}`);

    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      console.log(`[Socket] User ${socket.id} joined room: ${roomId}`);
    });

    socket.on("sync-simulation", (data) => {
      // Broadcast to all in the same room (or global for now)
      socket.broadcast.emit("simulation-update", data);
    });

    socket.on("sync-room-state", (data) => {
      socket.broadcast.emit("room-state-update", data);
    });

    socket.on("disconnect", () => {
      console.log(`[Socket] User disconnected: ${socket.id}`);
    });
  });

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  const SCENARIOS_FILE = path.join(__dirname, "custom_scenarios.json");
  const REPORTS_FILE = path.join(__dirname, "saved_reports.json");

  // Initialize files if they don't exist
  if (!fs.existsSync(SCENARIOS_FILE)) {
    fs.writeFileSync(SCENARIOS_FILE, JSON.stringify([]));
  }
  if (!fs.existsSync(REPORTS_FILE)) {
    fs.writeFileSync(REPORTS_FILE, JSON.stringify([]));
  }

  // API routes
  app.get("/api/ncbi/guidelines", async (req, res) => {
    try {
      const query = req.query.q as string;
      const specialty = req.query.specialty as string || '';
      const apiKey = process.env.NCBI_API_KEY
        ? `&api_key=${process.env.NCBI_API_KEY}` : '';

      // TIER 1: Society Guidelines (AHA, ACC, ASCO, ASA, IDSA, etc.)
      // Search explicitly for named society guideline publications
      const societyTerm = encodeURIComponent(
        `(${query}) AND (${specialty}) AND (
          "American Heart Association"[Affiliation] OR 
          "American College of Cardiology"[Affiliation] OR
          "American College of Physicians"[Affiliation] OR
          "American Academy of Pediatrics"[Affiliation] OR
          "American College of Emergency Physicians"[Affiliation] OR
          "Infectious Diseases Society of America"[Affiliation] OR
          "American Society of Clinical Oncology"[Affiliation] OR
          "American Academy of Neurology"[Affiliation] OR
          "Society of Critical Care Medicine"[Affiliation] OR
          "American College of Obstetricians"[Affiliation]
        ) AND (
          "Practice Guideline"[pt] OR 
          "Guideline"[pt] OR 
          "Consensus Development Conference"[pt]
        )`
      );

      // TIER 2: National Guidelines (NICE, CDC, NIH, WHO, USPSTF)
      const nationalTerm = encodeURIComponent(
        `(${query}) AND (${specialty}) AND (
          "NICE guideline"[Title] OR
          "CDC guideline"[Title] OR
          "NIH guideline"[Title] OR
          "WHO guideline"[Title] OR
          "USPSTF"[Title] OR
          "National Institute"[Affiliation] OR
          "Centers for Disease Control"[Affiliation] OR
          "World Health Organization"[Affiliation]
        ) AND (
          "Practice Guideline"[pt] OR 
          "Guideline"[pt]
        )`
      );

      // TIER 3: Consensus Statements and High-Quality Systematic Reviews
      // Fallback if Tier 1 and 2 return insufficient results
      const consensusTerm = encodeURIComponent(
        `(${query}) AND (${specialty}) AND (
          "consensus statement"[Title/Abstract] OR
          "clinical practice guideline"[Title/Abstract] OR
          "evidence-based guideline"[Title/Abstract] OR
          "joint guideline"[Title/Abstract]
        ) AND (
          "Practice Guideline"[pt] OR
          "Guideline"[pt] OR
          "Consensus Development Conference"[pt] OR
          "Meta-Analysis"[pt] OR
          "Systematic Review"[pt]
        )`
      );

      const baseUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmax=5&retmode=json&sort=relevance&datetype=pdat&mindate=2018${apiKey}`;

      // Run all three tier searches in parallel
      const [tier1Res, tier2Res, tier3Res] = await Promise.allSettled([
        fetch(`${baseUrl}&term=${societyTerm}`),
        fetch(`${baseUrl}&term=${nationalTerm}`),
        fetch(`${baseUrl}&term=${consensusTerm}`)
      ]);

      // Collect IDs preserving tier priority order
      let allIds: string[] = [];

      const extractIds = async (result: PromiseSettledResult<Response>) => {
        if (result.status === 'fulfilled' && result.value.ok) {
          const data = await result.value.json();
          return data.esearchresult?.idlist || [];
        }
        return [];
      };

      const [tier1Ids, tier2Ids, tier3Ids] = await Promise.all([
        extractIds(tier1Res),
        extractIds(tier2Res),
        extractIds(tier3Res)
      ]);

      // Merge deduplicated, tier priority preserved
      const seen = new Set<string>();
      for (const id of [...tier1Ids, ...tier2Ids, ...tier3Ids]) {
        if (!seen.has(id)) {
          seen.add(id);
          allIds.push(id);
        }
      }
      allIds = allIds.slice(0, 8); // Cap at 8 sources

      if (allIds.length === 0) {
        return res.json({
          guidelines: 'No society or national guidelines found. ' +
            'Use current standard of care for this specialty.',
          pmids: [],
          tierCounts: { tier1: 0, tier2: 0, tier3: 0 }
        });
      }

      // Fetch abstracts for all retrieved IDs
      const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${allIds.join(',')}&retmode=text&rettype=abstract${apiKey}`;

      const fetchRes = await fetch(fetchUrl);
      const abstracts = await fetchRes.text();

      res.json({
        guidelines: abstracts.slice(0, 8000),
        pmids: allIds,
        tierCounts: {
          tier1: tier1Ids.length,
          tier2: tier2Ids.length,
          tier3: tier3Ids.length
        },
        source: 'NCBI PubMed — Society & National Guidelines'
      });
    } catch (e: any) {
      console.error('NCBI high-authority search failed:', e);
      res.status(500).json({
        guidelines: '',
        pmids: [],
        error: e.message
      });
    }
  });

  app.get("/api/ncbi/bookshelf", async (req, res) => {
    try {
      const query = req.query.q as string;
      const apiKey = process.env.NCBI_API_KEY 
        ? `&api_key=${process.env.NCBI_API_KEY}` : '';
      
      const searchTerm = encodeURIComponent(
        `${query} diagnosis treatment management`
      );
      
      // Search Bookshelf (includes StatPearls, clinical references)
      const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=books&term=${searchTerm}&retmax=3&retmode=json${apiKey}`;
      
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();
      const ids = searchData.esearchresult?.idlist || [];
      
      if (ids.length === 0) return res.json({ content: '' });
      
      const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=books&id=${ids[0]}&retmode=text${apiKey}`;
      
      const fetchRes = await fetch(fetchUrl);
      const content = await fetchRes.text();
      
      res.json({ 
        content: content.slice(0, 4000),
        source: 'NCBI Bookshelf / StatPearls'
      });
    } catch (e: any) {
      console.error('Bookshelf fetch failed:', e);
      res.status(500).json({ content: '' });
    }
  });

  app.get("/api/ncbi/evidence", async (req, res) => {
    try {
      const query = req.query.q as string;
      const specialty = req.query.specialty as string || '';
      const apiKey = process.env.NCBI_API_KEY;
      const keyParam = apiKey ? `&api_key=${apiKey}` : '';

      // 1. Search PubMed for Clinical Guidelines
      const pmSearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query + ' "practice guideline"[Publication Type]')}&retmax=5&retmode=json${keyParam}`;
      const pmSearchRes = await fetch(pmSearchUrl);
      const pmSearchData = await pmSearchRes.json();
      const pmids = pmSearchData.esearchresult?.idlist || [];

      let combined = '';
      let titles: string[] = [];

      if (pmids.length > 0) {
        const pmSummaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json${keyParam}`;
        const pmSummaryRes = await fetch(pmSummaryUrl);
        const pmSummaryData = await pmSummaryRes.json();
        
        combined += `### PubMed Clinical Guidelines\n`;
        pmids.forEach((id: string) => {
          const item = pmSummaryData.result?.[id];
          if (item) {
            combined += `- **${item.title}** (${item.pubdate})\n`;
            titles.push(item.title);
          }
        });
        combined += `\n`;
      }

      // 2. Search Bookshelf
      const bkSearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=books&term=${encodeURIComponent(query)}&retmax=3&retmode=json${keyParam}`;
      const bkSearchRes = await fetch(bkSearchUrl);
      const bkSearchData = await bkSearchRes.json();
      const bkids = bkSearchData.esearchresult?.idlist || [];

      if (bkids.length > 0) {
        const bkSummaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=books&id=${bkids.join(',')}&retmode=json${keyParam}`;
        const bkSummaryRes = await fetch(bkSummaryUrl);
        const bkSummaryData = await bkSummaryRes.json();
        
        combined += `### NCBI Bookshelf / StatPearls\n`;
        bkids.forEach((id: string) => {
          const item = bkSummaryData.result?.[id];
          if (item) combined += `- **${item.title}** (${item.pubdate || 'N/A'})\n`;
        });
      }

      res.json({ 
        evidence: combined || 'No evidence retrieved.',
        pmids,
        titles,
        timestamp: Date.now()
      });
    } catch (e) {
      res.status(500).json({ evidence: '' });
    }
  });

  app.get("/api/ncbi/sources", async (req, res) => {
    try {
      const pmids = (req.query.pmids as string || '')
        .split(',').filter(Boolean).slice(0, 8);

      if (pmids.length === 0) return res.json({ sources: [] });

      const apiKey = process.env.NCBI_API_KEY
        ? `&api_key=${process.env.NCBI_API_KEY}` : '';

      const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml${apiKey}`;

      const fetchRes = await fetch(fetchUrl);
      const xmlText = await fetchRes.text();

      // Helper: extract value between XML tags near a PMID anchor
      const extractNear = (
        xml: string, 
        pmid: string, 
        openTag: string, 
        closeTag: string
      ): string => {
        const pmidPos = xml.indexOf(`>${pmid}<`);
        if (pmidPos === -1) return '';
        const searchFrom = Math.max(0, pmidPos - 100);
        const searchTo = Math.min(xml.length, pmidPos + 15000);
        const chunk = xml.slice(searchFrom, searchTo);
        const start = chunk.indexOf(openTag);
        const end = chunk.indexOf(closeTag, start);
        if (start === -1 || end === -1) return '';
        return chunk.slice(start + openTag.length, end).trim();
      };

      // Intelligent source categorization logic
      const categorizeSource = (
        title: string,
        journal: string,
        pubTypes: string,
        affiliations: string
      ): any => {

        const titleLower = title.toLowerCase();
        const journalLower = journal.toLowerCase();
        const affiliationsLower = affiliations.toLowerCase();

        // Society Practice Guideline detection
        const societyOrgs = [
          'aha', 'american heart association',
          'acc', 'american college of cardiology',
          'asco', 'american society of clinical oncology',
          'aap', 'american academy of pediatrics',
          'acep', 'american college of emergency physicians',
          'idsa', 'infectious diseases society',
          'aan', 'american academy of neurology',
          'acog', 'american college of obstetricians',
          'sccm', 'society of critical care',
          'ats', 'american thoracic society',
          'asa', 'american stroke association',
          'acr', 'american college of rheumatology',
          'acp', 'american college of physicians',
          'endocrine society', 'american diabetes association',
          'ada', 'american urological association',
          'aua', 'american gastroenterological'
        ];
        const isSociety = societyOrgs.some(org =>
          titleLower.includes(org) ||
          journalLower.includes(org) ||
          affiliationsLower.includes(org)
        );

        // National Guideline detection
        const nationalOrgs = [
          'nice', 'national institute for health and care',
          'cdc', 'centers for disease control',
          'nih', 'national institutes of health',
          'who', 'world health organization',
          'uspstf', 'preventive services task force',
          'ahrq', 'agency for healthcare research',
          'national cancer institute',
          'national heart, lung',
          'department of health'
        ];
        const isNational = nationalOrgs.some(org =>
          titleLower.includes(org) ||
          journalLower.includes(org) ||
          affiliationsLower.includes(org)
        );

        // Publication type detection
        const isGuideline = pubTypes.includes('Practice Guideline') ||
          pubTypes.includes('Guideline');
        const isConsensus = pubTypes.includes('Consensus') ||
          titleLower.includes('consensus statement') ||
          titleLower.includes('consensus guideline');
        const isMeta = pubTypes.includes('Meta-Analysis') ||
          titleLower.includes('meta-analysis');
        const isSR = pubTypes.includes('Systematic Review') ||
          titleLower.includes('systematic review');

        // Apply hierarchy
        if (isSociety && isGuideline) 
          return 'Society Practice Guideline';
        if (isNational && isGuideline) 
          return 'National Clinical Guideline';
        if (isConsensus) 
          return 'Consensus Statement';
        if (isGuideline) 
          return 'Clinical Practice Guideline';
        if (isMeta) 
          return 'Meta-Analysis';
        if (isSR) 
          return 'Systematic Review';
        return 'Clinical Reference';
      };

      const sources = pmids.map(pmid => {
        // Extract title
        const title = extractNear(
          xmlText, pmid, '<ArticleTitle>', '</ArticleTitle>'
        ).replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>');

        // Extract journal full name
        const journal = extractNear(
          xmlText, pmid, '<Title>', '</Title>'
        );

        // Extract year
        const year = extractNear(
          xmlText, pmid, '<Year>', '</Year>'
        );

        // Extract publication types
        const pmidIndex = xmlText.indexOf(`>${pmid}<`);
        const pubTypeChunk = xmlText.slice(
          Math.max(0, pmidIndex - 100),
          Math.min(xmlText.length, pmidIndex + 15000)
        );
        const pubTypes = (pubTypeChunk.match(
          /<PublicationType[^>]*>([^<]+)<\/PublicationType>/g
        ) || []).map(m => 
          m.replace(/<\/?PublicationType[^>]*>/g, '')
        ).join(', ');

        // Extract affiliations for org detection
        const affiliations = (pubTypeChunk.match(
          /<Affiliation>([^<]+)<\/Affiliation>/g
        ) || []).slice(0, 3)
         .map(m => m.replace(/<\/?Affiliation>/g, ''))
         .join(' ');

        // Extract first 3 authors
        const authorBlocks = pubTypeChunk.match(
          /<Author[^>]*>[\s\S]*?<\/Author>/g
        ) || [];
        const authors = authorBlocks.slice(0, 3).map(block => {
          const last = (block.match(
            /<LastName>([^<]+)<\/LastName>/
          ) || [])[1] || '';
          const initials = (block.match(
            /<Initials>([^<]+)<\/Initials>/
          ) || [])[1] || '';
          return `${last} ${initials}`.trim();
        }).filter(Boolean).join(', ');

        // Extract abstract
        const abstract = extractNear(
          xmlText, pmid, '<AbstractText>', '</AbstractText>'
        ).replace(/<[^>]+>/g, '').slice(0, 600);

        // Extract DOI if available
        const doi = extractNear(
          xmlText, pmid, 
          '<ArticleId IdType="doi">', '</ArticleId>'
        );

        const sourceType = categorizeSource(
          title, journal, pubTypes, affiliations
        );

        return {
          pmid,
          title: title || `PubMed Article ${pmid}`,
          authors: authors || 'Authors not available',
          journal: journal || 'Journal not available',
          year: year || 'Year not available',
          abstract: abstract || 'Abstract not available',
          url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
          doi: doi || null,
          sourceType,
          pubTypes
        };
      });

      // Sort by authority: Society > National > Consensus > Guideline
      const authorityOrder: Record<string, number> = {
        'Society Practice Guideline': 1,
        'National Clinical Guideline': 2,
        'Consensus Statement': 3,
        'Clinical Practice Guideline': 4,
        'Meta-Analysis': 5,
        'Systematic Review': 6,
        'Clinical Reference': 7
      };

      sources.sort((a, b) =>
        (authorityOrder[a.sourceType] || 9) -
        (authorityOrder[b.sourceType] || 9)
      );

      res.json({ sources });
    } catch (e: any) {
      console.error('NCBI source metadata failed:', e);
      res.status(500).json({ sources: [] });
    }
  });

  app.get("/api/scenarios", (req, res) => {
    try {
      const data = fs.readFileSync(SCENARIOS_FILE, "utf-8");
      res.json(JSON.parse(data));
    } catch (e) {
      res.status(500).json({ error: "Failed to read scenarios" });
    }
  });

  app.post("/api/scenarios", (req, res) => {
    try {
      fs.writeFileSync(SCENARIOS_FILE, JSON.stringify(req.body, null, 2));
      res.json({ status: "ok" });
    } catch (e) {
      res.status(500).json({ error: "Failed to save scenarios" });
    }
  });

  app.get("/api/reports", (req, res) => {
    try {
      const data = fs.readFileSync(REPORTS_FILE, "utf-8");
      res.json(JSON.parse(data));
    } catch (e) {
      res.status(500).json({ error: "Failed to read reports" });
    }
  });

  app.post("/api/reports", (req, res) => {
    try {
      fs.writeFileSync(REPORTS_FILE, JSON.stringify(req.body, null, 2));
      res.json({ status: "ok" });
    } catch (e) {
      res.status(500).json({ error: "Failed to save reports" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
