require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3335;

// Ensure uploads dir exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ─── Script extraction endpoint ───────────────────────────────────────────────
app.post('/api/extract-script', upload.single('file'), async (req, res) => {
  try {
    let rawText = '';

    if (req.body.text) {
      rawText = req.body.text;
    } else if (req.body.url) {
      rawText = await extractFromUrl(req.body.url);
    } else if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.html' || ext === '.htm') {
        const html = fs.readFileSync(req.file.path, 'utf-8');
        rawText = extractTextFromHtml(html);
      } else if (ext === '.txt') {
        rawText = fs.readFileSync(req.file.path, 'utf-8');
      } else {
        return res.status(400).json({ error: 'Unsupported file type for script. Use .txt or .html' });
      }
      fs.unlinkSync(req.file.path);
    } else {
      return res.status(400).json({ error: 'No input provided' });
    }

    if (!rawText.trim()) {
      return res.status(400).json({ error: 'Could not extract text from input' });
    }

    const sections = parseScriptSections(rawText);
    res.json({ sections });

  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PDF → images endpoint ─────────────────────────────────────────────────────
app.post('/api/upload-frames', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.pdf') {
      const pages = await pdfToImages(req.file.path);
      fs.unlinkSync(req.file.path);
      res.json({ frames: pages });
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      const data = fs.readFileSync(req.file.path);
      const b64 = data.toString('base64');
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : 'image/webp';
      fs.unlinkSync(req.file.path);
      res.json({ frames: [{ dataUrl: `data:${mime};base64,${b64}`, label: req.file.originalname }] });
    } else {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Unsupported file type. Use PDF, PNG, or JPG.' });
    }
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Export PDF endpoint ───────────────────────────────────────────────────────
app.post('/api/export-pdf', async (req, res) => {
  try {
    const { assignments, projectName } = req.body;
    if (!assignments || !Array.isArray(assignments)) {
      return res.status(400).json({ error: 'No assignments provided' });
    }

    const puppeteer = require('puppeteer');
    const html = buildExportHtml(assignments, projectName || 'Storyboard');

    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
        '--disable-dev-shm-usage', '--allow-file-access-from-files',
      ],
    });
    const page = await browser.newPage();

    // Write HTML to a temp file and navigate to it (avoids base64/setContent timeout issues)
    const tmpHtml = path.join(os.tmpdir(), `sb-export-${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, html, 'utf-8');
    try {
      await page.goto(`file://${tmpHtml}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Wait a moment for images to render
      await new Promise(r => setTimeout(r, 1500));
    } finally {
      fs.unlinkSync(tmpHtml);
    }

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${(projectName || 'storyboard').replace(/[^a-z0-9-_ ]/gi,'')}.pdf"`,
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Script parser (heuristic, no AI needed) ─────────────────────────────────
function parseScriptSections(rawText) {
  const lines = rawText.split('\n');
  const cleanLines = [];

  for (let line of lines) {
    let l = line.trim();

    // Skip empty
    if (!l) { cleanLines.push(''); continue; }

    // Skip lines that are purely annotations / production notes
    if (/^\[.*\]$/.test(l)) continue;                     // [CUT TO:], [MUSIC], etc
    if (/^\(.*\)$/.test(l)) continue;                     // (pause), (SFX) etc
    if (/^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(l)) continue; // pure timecodes 0:00 / 00:00:00
    if (/^--+$/.test(l)) continue;                         // --- dividers
    if (/^={3,}$/.test(l)) continue;                       // === dividers
    if (/^#{1,6}\s/.test(l)) { l = l.replace(/^#{1,6}\s+/, ''); }  // strip markdown headers but keep text

    // Strip inline annotations: [text], (text), <text>
    l = l.replace(/\[(?!.*\].*\[)[^\]]{0,60}\]/g, '');   // strip [annotations] under 60 chars
    l = l.replace(/<[^>]{0,40}>/g, '');                   // strip <tags>

    // Strip timecode prefixes: "00:00 - text", "0:00:00 text"
    l = l.replace(/^\d{1,2}:\d{2}(:\d{2})?(\s*[-–—]\s*)?/, '');

    // Strip speaker labels at line start: "VO:", "NARRATOR:", "HOST:", "JOHN:"
    l = l.replace(/^[A-Z][A-Z\s]{1,20}:\s*/, (m) => {
      // Only strip if ALL CAPS label (production convention)
      return /^[A-Z\s]+:/.test(m) ? '' : m;
    });

    l = l.trim();
    if (l) cleanLines.push(l);
    else cleanLines.push('');
  }

  // Join and re-split into paragraphs
  const text = cleanLines.join('\n');
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(p => p.length > 10);  // skip very short fragments

  if (!paragraphs.length) {
    throw new Error('No script content found after cleaning. Check your input format.');
  }

  // Try to detect natural scene/section breaks from the original text
  // Look for lines like "SCENE 1", "SECTION:", numbered items, etc.
  const namedSections = tryExtractNamedSections(rawText);
  if (namedSections.length >= 2) return namedSections;

  // Otherwise: auto-label each paragraph as a section
  return paragraphs.map((text, i) => ({
    id: i + 1,
    label: `Scene ${i + 1}`,
    text,
  }));
}

function tryExtractNamedSections(rawText) {
  // Look for lines that look like section headers:
  // "SCENE 1:", "1.", "Section 1", "INTRO", "HERO", "PROBLEM", etc.
  const HEADER_RE = /^(?:(scene|section|part|act|beat|slide|card|screen|shot|cut|int\.|ext\.)\s*[\d:.]*|[\d]+[.)]\s+\S|[A-Z][A-Z\s]{2,30}:?\s*$)/i;
  
  const lines = rawText.split('\n');
  const sections = [];
  let currentLabel = null;
  let currentLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip pure annotations
    if (/^\[.*\]$/.test(trimmed) || /^\(.*\)$/.test(trimmed)) continue;

    if (HEADER_RE.test(trimmed) && trimmed.length < 60) {
      // Save previous section
      if (currentLines.length > 0) {
        const text = currentLines.join(' ').trim();
        if (text.length > 5) {
          sections.push({ id: sections.length + 1, label: currentLabel || `Scene ${sections.length + 1}`, text });
        }
      }
      currentLabel = trimmed.replace(/:$/, '').trim();
      currentLines = [];
    } else {
      // Clean the line before adding
      let l = trimmed
        .replace(/\[(?!.*\].*\[)[^\]]{0,60}\]/g, '')
        .replace(/^\d{1,2}:\d{2}(:\d{2})?(\s*[-–—]\s*)?/, '')
        .replace(/^[A-Z][A-Z\s]{1,20}:\s*/, (m) => /^[A-Z\s]+:/.test(m) ? '' : m)
        .trim();
      if (l) currentLines.push(l);
    }
  }

  // Last section
  if (currentLines.length > 0) {
    const text = currentLines.join(' ').trim();
    if (text.length > 5) {
      sections.push({ id: sections.length + 1, label: currentLabel || `Scene ${sections.length + 1}`, text });
    }
  }

  return sections;
}

// ─── URL / Google Docs fetcher ────────────────────────────────────────────────
async function extractFromUrl(url) {
  const gdocsMatch = url.match(/docs\.google\.com\/document\/d\/([^\/]+)/);
  if (gdocsMatch) {
    const docId = gdocsMatch[1];
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=html`;
    const resp = await fetch(exportUrl);
    if (!resp.ok) throw new Error('Could not fetch Google Doc. Make sure sharing is set to "Anyone with the link".');
    const html = await resp.text();
    return extractTextFromHtml(html);
  }

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });
  if (!resp.ok) throw new Error(`Could not fetch URL (HTTP ${resp.status})`);
  const html = await resp.text();
  return extractTextFromHtml(html);
}

function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, aside, [role="navigation"], .nav, .footer, .header').remove();
  const text = $('body').text();
  return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
}

// ─── PDF → images via pdftoppm ────────────────────────────────────────────────
async function pdfToImages(pdfPath) {
  const { spawnSync } = require('child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pdf-'));
  const outPrefix = path.join(tmpDir, 'page');

  try {
    const result = spawnSync('pdftoppm', ['-r', '150', '-png', pdfPath, outPrefix], {
      timeout: 120000,
    });
    if (result.status !== 0) {
      throw new Error('PDF conversion failed: ' + (result.stderr?.toString() || 'unknown error'));
    }

    const files = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (!files.length) throw new Error('PDF produced no pages');

    return files.map((f, i) => {
      const data = fs.readFileSync(path.join(tmpDir, f));
      return {
        dataUrl: `data:image/png;base64,${data.toString('base64')}`,
        label: `Page ${i + 1}`,
      };
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Export HTML template ─────────────────────────────────────────────────────
function buildExportHtml(assignments, projectName) {
  const pages = assignments.map((a, i) => `
    <div class="page">
      <div class="frame-wrap">
        <img src="${a.frameDataUrl}" alt="Frame ${i + 1}" />
      </div>
      <div class="caption">
        <div class="caption-label">${escapeHtml(a.sectionLabel)}</div>
        <div class="caption-text">${escapeHtml(a.sectionText)}</div>
      </div>
      <div class="page-num">${escapeHtml(projectName)} &mdash; ${i + 1}&thinsp;/&thinsp;${assignments.length}</div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #fff; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #111; }

  .page {
    width: 210mm;
    min-height: 297mm;
    display: flex;
    flex-direction: column;
    page-break-after: always;
    break-after: page;
  }

  .frame-wrap {
    flex: 1;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    min-height: 160mm;
  }

  .frame-wrap img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .caption {
    padding: 18pt 24pt 12pt;
    border-top: 1.5pt solid #111;
  }

  .caption-label {
    font-size: 7.5pt;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #777;
    margin-bottom: 7pt;
  }

  .caption-text {
    font-size: 11pt;
    line-height: 1.6;
    color: #111;
    max-width: 160mm;
  }

  .page-num {
    padding: 8pt 24pt;
    font-size: 7pt;
    color: #bbb;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  @page { margin: 0; size: A4; }
</style>
</head>
<body>${pages}</body>
</html>`;
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Storyboard Builder → http://localhost:${PORT}`);
});
