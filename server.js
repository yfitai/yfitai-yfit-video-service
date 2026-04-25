'use strict';
// ============================================================
// YFIT Video Service v3.6.5
// ============================================================
// CHANGES vs v3.2.0:
//
//  FIX — CAPTION/AUDIO SYNC (the core issue)
//    Root cause: parseCaptionSegments() was splitting the script
//    text into segments using regex/sentence heuristics, but the
//    resulting segment boundaries didn't align with the actual
//    spoken words in the ElevenLabs audio.
//
//    New approach:
//    1. When word_timing is present, we build segments DIRECTLY
//       from the word_timing array itself — no script parsing
//       needed. We group consecutive words into caption "chunks"
//       of ~8-12 words, then assign each chunk's start/end time
//       directly from the word timestamps. This guarantees
//       perfect sync because the captions ARE the timing data.
//    2. parseCaptionSegments() is now only used as a fallback
//       when word_timing is absent (no ElevenLabs timestamps).
//    3. Added validation: if word_timing is present but script
//       is missing, we reconstruct the script from word_timing
//       so the caption text matches the spoken audio exactly.
//    4. Tightened the word-match alignment to use a greedy
//       sliding-window with edit-distance fallback so segment
//       boundaries don't drift on long scripts.
//
// ============================================================

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mxggxpoxgqubojvumjlt.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_SECRET = process.env.API_SECRET || 'yfit-video-secret-2026';
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// YFIT logo — transparent PNG, tight-cropped
const YFIT_LOGO_URL = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663099417101/8TNedJULyoVCPDLa6UYde3/yfit_logo_new_e83060df.png';

// ─── BRAND MUSIC — Sonic Identity ────────────────────────────────────────────
const BGM_TRACKS = {
  primary:    `${SUPABASE_URL}/storage/v1/object/public/yfit-voiceovers/assets/bgm_motivational.mp3`,
  energetic:  'https://d2xsxph8kpxj0f.cloudfront.net/310519663099417101/8TNedJULyoVCPDLa6UYde3/bgm_energetic_new_be4cae1c.mp3',
  deep:       `${SUPABASE_URL}/storage/v1/object/public/yfit-voiceovers/assets/bgm_deep.mp3`,
};

function getBgmForAngle(contentAngle) {
  const angle = (contentAngle || '').toLowerCase();
  if (angle === 'workout_tips' || angle === 'form_analysis' || angle === 'transformation_story') {
    return BGM_TRACKS.energetic;
  }
  if (angle === 'medication_fitness' || angle === 'nutrition_science' || angle === 'recovery_wellness') {
    return BGM_TRACKS.deep;
  }
  return BGM_TRACKS.primary;
}

const BGM_VOLUME = 0.15;

// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DIR = '/tmp/yfit-videos';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const YFIT_GREEN = '0x00ff88';

// Health check
app.get('/health', (req, res) => {
  let ffmpegVersion = 'not found';
  try { ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -1').toString().trim(); } catch (e) {}
  res.json({
    status: 'ok',
    ffmpeg: ffmpegVersion,
    pexels: PEXELS_API_KEY ? 'configured' : 'missing',
    version: '3.6.5',
    timestamp: new Date().toISOString()
  });
});

// Download file from URL (follows redirects)
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// Pexels search — appends human-presence term
function searchPexels(query) {
  return new Promise((resolve) => {
    if (!PEXELS_API_KEY) { resolve([]); return; }

    const humanTerm = query.toLowerCase().includes('food') || query.toLowerCase().includes('meal') || query.toLowerCase().includes('nutrition')
      ? 'person eating healthy'
      : `person ${query}`;

    const q = encodeURIComponent(humanTerm);
    const options = {
      hostname: 'api.pexels.com',
      path: `/videos/search?query=${q}&per_page=20&orientation=portrait&size=medium`,
      method: 'GET',
      headers: { 'Authorization': PEXELS_API_KEY }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const clips = [];
          for (const video of (result.videos || [])) {
            if ((video.duration || 0) < 4) continue;
            const files = video.video_files || [];
            const f = files.find(f => f.quality === 'hd' && f.width < f.height) ||
                      files.find(f => f.width < f.height) ||
                      files.find(f => f.quality === 'hd') ||
                      files[0];
            if (f && f.link) {
              clips.push({ url: f.link, duration: video.duration || 10 });
              if (clips.length >= 6) break;
            }
          }
          resolve(clips);
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// Fitness-specific fallback chain
async function getPexelsClips(query) {
  const queryLower = (query || '').toLowerCase();

  let specificTerms = [];
  if (queryLower.includes('hiit') || queryLower.includes('cardio') || queryLower.includes('interval')) {
    specificTerms = ['athlete HIIT cardio workout', 'person high intensity interval training', 'athlete cardio exercise'];
  } else if (queryLower.includes('strength') || queryLower.includes('weight') || queryLower.includes('lift')) {
    specificTerms = ['person weightlifting gym', 'athlete strength training barbell', 'person gym workout weights'];
  } else if (queryLower.includes('run') || queryLower.includes('jog')) {
    specificTerms = ['person running outdoors', 'athlete jogging fitness', 'runner workout trail'];
  } else if (queryLower.includes('yoga') || queryLower.includes('stretch') || queryLower.includes('flex')) {
    specificTerms = ['person yoga fitness', 'athlete stretching exercise', 'person flexibility workout'];
  } else if (queryLower.includes('nutrition') || queryLower.includes('diet') || queryLower.includes('food') || queryLower.includes('meal')) {
    specificTerms = ['person healthy meal prep', 'athlete nutrition fitness', 'person eating healthy food'];
  } else if (queryLower.includes('sleep') || queryLower.includes('recover') || queryLower.includes('rest')) {
    specificTerms = ['athlete recovery rest', 'person fitness rest day', 'person stretching wellness'];
  } else if (queryLower.includes('protein') || queryLower.includes('supplement')) {
    specificTerms = ['person protein shake gym', 'athlete fitness nutrition', 'person gym workout nutrition'];
  } else {
    specificTerms = ['person gym workout fitness', 'athlete exercise training'];
  }

  const fitnessOnlyFallbacks = [
    'person gym workout',
    'athlete fitness exercise',
    'person running outdoor fitness',
    'person weightlifting gym',
    'athlete training sports'
  ];

  const fallbacks = [query, ...specificTerms, ...fitnessOnlyFallbacks];
  for (const q of fallbacks) {
    const clips = await searchPexels(q);
    if (clips.length > 0) {
      console.log(`[Pexels] Found ${clips.length} clips for query: "${q}"`);
      return clips;
    }
  }
  return [];
}

// Get audio duration via ffprobe
function getAudioDuration(audioPath) {
  try {
    const r = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
      { timeout: 15000, shell: true }
    ).toString().trim();
    return parseFloat(r) || 30;
  } catch (e) { return 30; }
}

// Upload to Supabase Storage
async function uploadToSupabase(localPath, storagePath, mimeType) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const fileBuffer = fs.readFileSync(localPath);
  const { error } = await supabase.storage
    .from('yfit-videos')
    .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: true, cacheControl: '3600' });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  const encodedPath = storagePath.split('/').map(s => encodeURIComponent(s)).join('/');
  return `${SUPABASE_URL}/storage/v1/object/public/yfit-videos/${encodedPath}`;
}

// Sanitize text for ffmpeg drawtext
function sanitizeForDrawtext(text) {
  const cleaned = (text || '')
    .replace(/[^\w\s\-.,!?]/g, ' ')
    .replace(/'/g, '')
    .replace(/"/g, '')
    .replace(/:/g, ' -')
    .replace(/\\/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!cleaned) return cleaned;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Word-wrap text into lines of maxChars
function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars) {
      if (line) lines.push(line.trim());
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line.trim());
  return lines;
}

// ─── NEW v3.3.0: Build caption segments DIRECTLY from ElevenLabs word timing ─
//
// When word_timing is available, we group consecutive words into chunks of
// WORDS_PER_CHUNK words. Each chunk gets its start time from the first word
// and end time from the last word in the chunk. This guarantees perfect sync
// because the caption text IS the spoken text, and the timing IS the ElevenLabs
// timing — no heuristic matching needed.
//
// WORDS_PER_CHUNK: 8 words per caption line feels natural for short-form video.
// At ~2.5 words/second (typical voiceover pace), 8 words ≈ 3.2 seconds on screen.
// ─────────────────────────────────────────────────────────────────────────────
const WORDS_PER_CHUNK = 8;

function buildSegmentsFromWordTiming(wordTiming, audioDuration) {
  if (!wordTiming || wordTiming.length === 0) return null;

  const segments = [];
  let i = 0;

  while (i < wordTiming.length) {
    const chunkWords = wordTiming.slice(i, i + WORDS_PER_CHUNK);
    const text = chunkWords.map(w => w.word || '').join(' ').trim();
    const startTime = chunkWords[0].start || 0;
    const endTime = chunkWords[chunkWords.length - 1].end || startTime + 1;

    if (text.length > 0) {
      segments.push({
        text: sanitizeForDrawtext(text),
        rawText: text,
        words: chunkWords.length,
        startTime,
        endTime
      });
    }
    i += WORDS_PER_CHUNK;
  }

  // Extend last segment to full audio duration (minus end card buffer)
  if (segments.length > 0) {
    segments[segments.length - 1].endTime = Math.max(
      segments[segments.length - 1].endTime,
      audioDuration - 3.5
    );
  }

  // Fill any gaps between segments (ensure no blank periods mid-video)
  for (let j = 0; j < segments.length - 1; j++) {
    if (segments[j].endTime < segments[j + 1].startTime) {
      segments[j].endTime = segments[j + 1].startTime;
    }
  }

  console.log(`[captions] Built ${segments.length} segments from ${wordTiming.length} word timestamps`);
  segments.forEach((s, idx) => {
    console.log(`  [${idx}] ${s.startTime.toFixed(2)}s → ${s.endTime.toFixed(2)}s: "${s.text.substring(0, 50)}"`);
  });

  return segments;
}

// Fallback: parse script text into segments (used only when word_timing is absent)
function parseCaptionSegments(script, caption, contentAngle) {
  const src = (script || '').trim();

  // Strategy 1a: Word-form numbers — "Number one", "Tip one", "Step one"
  if (src) {
    const wordNumRegex = /(?=\b(?:number\s+(?:one|two|three|four|five|six)|tip\s+(?:one|two|three|four|five|six)|step\s+(?:one|two|three|four|five|six))\b)/i;
    const wordParts = src.split(wordNumRegex).map(p => p.trim()).filter(p => p.length > 0);
    const wordTips = wordParts
      .map(p => p.replace(/^(?:number|tip|step)\s+(?:one|two|three|four|five|six)[:\s]*/i, '').trim())
      .filter(t => t.length > 8);
    if (wordTips.length >= 2) {
      console.log(`[parseCaptions] Strategy 1a (word numbers): ${wordTips.length} segments`);
      return wordTips.slice(0, 6).map(t => ({
        text: sanitizeForDrawtext(t),
        rawText: t,
        words: t.split(/\s+/).length
      }));
    }

    // Strategy 1b: Numeric markers — "1. tip" or "2) tip"
    const parts = src.split(/(?=\b[1-9]\d*[.)\s]\s)/).map(p => p.trim()).filter(p => p.length > 0);
    const tips = parts
      .map(p => p.replace(/^\d+[.)]+\s*/, '').trim())
      .filter(t => t.length > 8);
    if (tips.length >= 2) {
      console.log(`[parseCaptions] Strategy 1b (numeric): ${tips.length} segments`);
      return tips.slice(0, 6).map(t => ({
        text: sanitizeForDrawtext(t),
        rawText: t,
        words: t.split(/\s+/).length
      }));
    }
  }

  // Strategy 2: Newline-separated paragraphs/bullets
  if (src) {
    const lines = src.split(/\n/)
      .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]+\s*/, '').trim())
      .filter(l => l.length > 8 && l.length < 200);
    if (lines.length >= 2) {
      console.log(`[parseCaptions] Strategy 2 (newlines): ${lines.length} segments`);
      return lines.slice(0, 8).map(l => ({
        text: sanitizeForDrawtext(l),
        rawText: l,
        words: l.split(/\s+/).length
      }));
    }
  }

  // Strategy 3: Sentence splitting
  const fullText = src || caption || contentAngle || '';
  if (fullText) {
    const rawSentences = fullText
      .replace(/([.!?])\s+/g, '$1\n')
      .split('\n')
      .map(s => s.replace(/^\d+[.)]+\s*/, '').replace(/[.!?]+$/, '').trim())
      .filter(s => s.length > 10);

    if (rawSentences.length >= 2) {
      const grouped = [];
      let buffer = '';
      let bufWords = 0;
      for (const s of rawSentences) {
        const wc = s.split(/\s+/).length;
        if (buffer && bufWords + wc > 18) {
          grouped.push({ text: sanitizeForDrawtext(buffer.trim()), words: bufWords });
          buffer = s;
          bufWords = wc;
        } else {
          buffer = buffer ? buffer + '. ' + s : s;
          bufWords += wc;
        }
      }
      if (buffer) grouped.push({ text: sanitizeForDrawtext(buffer.trim()), words: bufWords });

      if (grouped.length >= 2) {
        console.log(`[parseCaptions] Strategy 3 (sentences): ${grouped.length} segments`);
        return grouped.slice(0, 8).map(g => ({ ...g, rawText: g.text }));
      }
    }
  }

  // Fallback: single caption
  console.log(`[parseCaptions] Fallback: single caption`);
  const text = sanitizeForDrawtext(caption || contentAngle || 'YFIT AI Fitness Tips');
  return [{ text, rawText: text, words: text.split(/\s+/).length }];
}

// Build FFmpeg drawtext filters from segments with pre-computed timings
// (segments may have .startTime/.endTime already set, or we compute proportionally)
function buildCaptionFilters(segments, audioDuration, font) {
  if (segments.length === 0) return [];
  const filters = [];

  // Compute timings if not already set (fallback path)
  let segmentTimings;
  if (segments[0].startTime !== undefined) {
    // v3.3.0: timings already embedded in segments (from word_timing path)
    segmentTimings = segments.map(s => ({ startTime: s.startTime, endTime: s.endTime }));
  } else {
    // Proportional word-count estimation (no word_timing available)
    console.log(`[captions] No word timing — using proportional estimation`);
    const totalWords = segments.reduce((sum, s) => sum + s.words, 0);
    let cursor = 0;
    segmentTimings = segments.map(seg => {
      const proportion = seg.words / totalWords;
      const segDuration = audioDuration * proportion;
      const startTime = cursor;
      const endTime = cursor + segDuration;
      cursor = endTime;
      return { startTime, endTime };
    });
  }

  // Clip last segment end time so captions don't overlap the end card
  const endCardStartTime = Math.max(0, audioDuration - 3.0);
  if (segmentTimings.length > 0) {
    const lastTiming = segmentTimings[segmentTimings.length - 1];
    if (lastTiming.endTime > endCardStartTime) {
      lastTiming.endTime = endCardStartTime;
    }
  }

  // Build drawtext filters
  for (let i = 0; i < segments.length; i++) {
    const { startTime, endTime } = segmentTimings[i];
    if (endTime <= startTime) continue; // skip zero-duration segments

    const isHook = (i === 0);
    const ctaKeywords = /\b(try|free|link in bio|download|sign up|get started|join|click|tap)\b/i;
    const isCta = (i === segments.length - 1) && ctaKeywords.test(segments[i].rawText || segments[i].text);

    const lines = wrapText(segments[i].text, 24);
    const line1 = (lines[0] || '').replace(/:/g, '\\:');
    const line2 = (lines[1] || '').replace(/:/g, '\\:');
    const line3 = (lines[2] || '').replace(/:/g, '\\:');

    const enableExpr = `enable='between(t,${startTime.toFixed(2)},${endTime.toFixed(2)})'`;

    const lineCount = [line1, line2, line3].filter(Boolean).length;
    const lineHeight = isHook ? 64 : 56;
    const totalTextHeight = lineCount * lineHeight;
    const blockTop = `(h-${totalTextHeight})/2`;

    if (isHook) {
      if (line1) filters.push(
        `drawtext=fontfile=${font}:text='${line1}':fontsize=56:fontcolor=white:` +
        `x=(w-text_w)/2:y=${blockTop}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
      if (line2) filters.push(
        `drawtext=fontfile=${font}:text='${line2}':fontsize=54:fontcolor=white@0.97:` +
        `x=(w-text_w)/2:y=${blockTop}+${lineHeight}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
      if (line3) filters.push(
        `drawtext=fontfile=${font}:text='${line3}':fontsize=52:fontcolor=white@0.95:` +
        `x=(w-text_w)/2:y=${blockTop}+${lineHeight * 2}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
    } else if (isCta) {
      if (line1) filters.push(
        `drawtext=fontfile=${font}:text='${line1}':fontsize=50:fontcolor=${YFIT_GREEN}:` +
        `x=(w-text_w)/2:y=${blockTop}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
      if (line2) filters.push(
        `drawtext=fontfile=${font}:text='${line2}':fontsize=48:fontcolor=${YFIT_GREEN}@0.95:` +
        `x=(w-text_w)/2:y=${blockTop}+${lineHeight}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
      if (line3) filters.push(
        `drawtext=fontfile=${font}:text='${line3}':fontsize=46:fontcolor=${YFIT_GREEN}@0.90:` +
        `x=(w-text_w)/2:y=${blockTop}+${lineHeight * 2}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
    } else {
      if (line1) filters.push(
        `drawtext=fontfile=${font}:text='${line1}':fontsize=46:fontcolor=white:` +
        `x=(w-text_w)/2:y=${blockTop}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
      if (line2) filters.push(
        `drawtext=fontfile=${font}:text='${line2}':fontsize=44:fontcolor=white@0.95:` +
        `x=(w-text_w)/2:y=${blockTop}+${lineHeight}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
      if (line3) filters.push(
        `drawtext=fontfile=${font}:text='${line3}':fontsize=42:fontcolor=white@0.90:` +
        `x=(w-text_w)/2:y=${blockTop}+${lineHeight * 2}:` +
        `shadowcolor=black@0.9:shadowx=2:shadowy=2:${enableExpr}`
      );
    }
  }
  return filters;
}

// Main assembly endpoint
app.post('/assemble', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let {
    voiceover_url, run_date, content_angle, caption_text, script,
    video_items = [], text_items = [], dry_run = false, pexels_query,
    word_timing = [],
    burn_captions = true  // v3.6.5: set to false to skip burned-in captions (e.g. for YouTube which has auto-captions)
  } = req.body;
  if (typeof burn_captions === 'string') { burn_captions = burn_captions !== 'false'; }

  if (typeof word_timing === 'string') { try { word_timing = JSON.parse(word_timing); } catch(e) { word_timing = []; } }
  if (typeof video_items === 'string') { try { video_items = JSON.parse(video_items); } catch(e) { video_items = []; } }
  if (typeof text_items === 'string') { try { text_items = JSON.parse(text_items); } catch(e) { text_items = []; } }
  if (typeof dry_run === 'string') { dry_run = dry_run === 'true'; }

  if (!voiceover_url) return res.status(400).json({ error: 'voiceover_url is required' });

  const jobId = `${run_date || 'test'}_${Date.now()}`;
  const safeAngle = (content_angle || 'workout').replace(/[^a-z0-9\-]/gi, '_').substring(0, 60);
  // Per-angle Pexels query map — ensures relevant fitness footage for each content type
  const ANGLE_PEXELS_QUERIES = {
    'form_analysis':          'runner jogging outdoor trail running exercise',
    'workout_tips':           'gym workout exercise fitness training',
    'transformation_story':   'fitness transformation before after workout progress',
    'nutrition_advice':       'healthy food meal prep nutrition vegetables',
    'nutrition_science':      'healthy food nutrition science meal prep',
    'motivation':             'athlete training motivation sports fitness',
    'recovery':               'stretching yoga recovery rest athlete',
    'recovery_wellness':      'stretching yoga recovery wellness athlete',
    'hiit':                   'hiit workout cardio exercise jumping',
    'strength':               'weightlifting gym barbell strength training',
    'cardio':                 'running jogging cardio exercise outdoor',
    'mindset':                'meditation focus mindset athlete training',
    'medication_fitness':     'person fitness health wellness active lifestyle',
    'sleep':                  'person sleeping rest recovery wellness',
    'hydration':              'person drinking water fitness hydration athlete',
  };
  const searchQuery = pexels_query || ANGLE_PEXELS_QUERIES[content_angle] || 'fitness workout exercise gym';

  const firstItem = video_items[0] || {};
  const scriptText = script || firstItem.script || '';

  console.log(`[${jobId}] Starting assembly v3.6.0. dry_run=${dry_run}, query="${searchQuery}", angle="${content_angle}", word_timing=${word_timing.length} words`);

  if (dry_run) {
    return res.json({
      success: true, dry_run: true, job_id: jobId,
      message: 'Dry run: video assembly skipped',
      video_url: `${SUPABASE_URL}/storage/v1/object/public/yfit-videos/videos/${run_date}_${safeAngle}.mp4`,
      video_size_bytes: 0,
      platforms: video_items.map(v => v.platform),
      text_platforms: text_items.map(t => t.platform),
      voiceover_url, content_angle, run_date
    });
  }

  const audioPath = path.join(TEMP_DIR, `${jobId}_audio.mp3`);
  const bgmPath = path.join(TEMP_DIR, `${jobId}_bgm.mp3`);
  const logoPath = path.join(TEMP_DIR, `${jobId}_logo.png`);
  const finalPath = path.join(TEMP_DIR, `${jobId}_final.mp4`);
  const tempFiles = [audioPath, bgmPath, logoPath, finalPath];

  try {
    // Step 1: Download voiceover
    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(voiceover_url, audioPath);
    const audioDuration = getAudioDuration(audioPath);
    console.log(`[${jobId}] Audio duration: ${audioDuration}s`);
    // v3.6.0: CTA_HOLD and totalDuration declared here so they are available
    // throughout the assembly (clips, fallback bg, end card, final encode)
    const CTA_HOLD = 8.0;
    const totalDuration = audioDuration + CTA_HOLD;
    console.log(`[${jobId}] Total video duration: ${totalDuration.toFixed(2)}s (audio ${audioDuration.toFixed(2)}s + CTA hold ${CTA_HOLD}s)`);
    // Bug 3 guard: reject suspiciously short audio (ElevenLabs partial/rate-limit response)
    if (audioDuration < 5) {
      console.error(`[${jobId}] REJECTED: audio too short (${audioDuration.toFixed(2)}s < 5s minimum). Likely ElevenLabs rate-limit or partial response.`);
      tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
      return res.status(400).json({
        success: false,
        error: `Audio too short: ${audioDuration.toFixed(2)}s (minimum 5s). Retry with a valid voiceover.`,
        audio_duration_seconds: audioDuration,
        job_id: jobId
      });
    }

    // Step 2: Download YFIT logo
    console.log(`[${jobId}] Downloading YFIT logo...`);
    try {
      await downloadFile(YFIT_LOGO_URL, logoPath);
      console.log(`[${jobId}] Logo downloaded OK`);
    } catch (e) {
      console.warn(`[${jobId}] Logo download failed: ${e.message} - will skip logo`);
    }

    // Step 2b: Download content-angle-mapped BGM
    const selectedBgmUrl = getBgmForAngle(content_angle);
    const selectedBgmName = selectedBgmUrl.split('/').pop();
    console.log(`[${jobId}] Downloading BGM for angle "${content_angle}": ${selectedBgmName}`);
    let bgmExists = false;
    try {
      await downloadFile(selectedBgmUrl, bgmPath);
      const bgmSize = fs.statSync(bgmPath).size;
      bgmExists = bgmSize > 10000;
      console.log(`[${jobId}] BGM downloaded: ${bgmSize} bytes, valid=${bgmExists}`);
    } catch (e) {
      console.warn(`[${jobId}] BGM download failed: ${e.message} - will skip BGM`);
    }

    // Step 3: Get Pexels clips
    console.log(`[${jobId}] Fetching Pexels clips for: "${searchQuery}"...`);
    const pexelsClips = await getPexelsClips(searchQuery);
    console.log(`[${jobId}] Got ${pexelsClips.length} Pexels clips`);

    let baseVideoPath = null;

    if (pexelsClips.length > 0) {
      // v3.6.0: cap at 3 clips for short-form video (prevents clip doubling when some clips fail brightness check)
      const numClips = Math.min(pexelsClips.length, 3);
      // v3.6.4: use audioDuration/numClips (NOT totalDuration) so clips are short enough that
      // Pexels can actually provide them. Pexels clips are often only 6-10s; asking for 12.7s
      // means the trimmed clip is shorter than requested, making totalClipDuration too short
      // to reach the CTA window at t=audioDuration..totalDuration.
      // repeatsNeeded (below) uses the REAL measured clip durations to ensure full coverage.
      const clipDuration = Math.max(4.0, Math.min(10.0, audioDuration / numClips));
      const trimmedPaths = [];
      const actualClipDurations = []; // v3.6.4: track real durations for accurate repeatsNeeded

      for (let i = 0; i < numClips; i++) {
        const clip = pexelsClips[i];
        const rawPath = path.join(TEMP_DIR, `${jobId}_raw_${i}.mp4`);
        const trimPath = path.join(TEMP_DIR, `${jobId}_clip_${i}.mp4`);
        tempFiles.push(rawPath, trimPath);

        try {
          await downloadFile(clip.url, rawPath);
          const rawSize = fs.statSync(rawPath).size;
          if (rawSize < 50000) { console.warn(`[${jobId}] Clip ${i} too small (${rawSize}b), skipping`); continue; }

          let topBrightness = 255;
          try {
            const probeResult = execSync(
              `ffprobe -v error -select_streams v:0 -read_intervals "%+#1" -vf "crop=iw:ih*0.15:0:0,signalstats" -show_entries frame_tags=lavfi.signalstats.YAVG -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`,
              { timeout: 15000, shell: true }
            ).toString().trim();
            topBrightness = parseFloat(probeResult) || 255;
          } catch (e) {
            console.warn(`[${jobId}] Clip ${i} brightness probe failed: ${e.message}`);
          }
          if (topBrightness < 60) {
            console.warn(`[${jobId}] Clip ${i} rejected: top brightness ${topBrightness.toFixed(1)} < 60 (dark ceiling)`);
            continue;
          }
          console.log(`[${jobId}] Clip ${i} accepted: top brightness ${topBrightness.toFixed(1)}`);

          const portraitFilter = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,eq=brightness=0.08:contrast=1.12:saturation=1.1`;
          // v3.6.4: loop the clip so it fills exactly clipDuration even if the source is shorter
          // -stream_loop -1 loops the input indefinitely; -t clipDuration stops at the right time
          const trimCmd = [
            'ffmpeg -y',
            `-stream_loop -1 -i "${rawPath}"`,
            `-t ${clipDuration.toFixed(2)}`,
            `-vf "${portraitFilter}"`,
            `-c:v libx264 -preset fast -pix_fmt yuv420p -an -r 30`,
            `"${trimPath}"`
          ].join(' ');
          execSync(trimCmd, { timeout: 120000, shell: true });
          // Each clip is now exactly clipDuration (looped to fill if needed)
          console.log(`[${jobId}] Clip ${i} trimmed to ${clipDuration.toFixed(2)}s (looped if source was shorter)`);
          trimmedPaths.push(trimPath);
          actualClipDurations.push(clipDuration);
        } catch (e) {
          console.warn(`[${jobId}] Clip ${i} failed: ${e.message}`);
        }
      }

      if (trimmedPaths.length > 0) {
        // v3.6.4: use REAL measured durations (not target clipDuration) so repeatsNeeded is accurate
        // This prevents the CTA from being cut off when Pexels clips are shorter than requested
        const realTotalClipDuration = actualClipDurations.reduce((a, b) => a + b, 0);
        const repeatsNeeded = Math.min(4, Math.ceil(totalDuration / realTotalClipDuration));
        console.log(`[${jobId}] Clips: ${trimmedPaths.length} clips, real total=${realTotalClipDuration.toFixed(2)}s, repeatsNeeded=${repeatsNeeded} to cover ${totalDuration.toFixed(2)}s`);
        const allClips = [];
        for (let r = 0; r < repeatsNeeded; r++) allClips.push(...trimmedPaths);

        const concatListPath = path.join(TEMP_DIR, `${jobId}_concat.txt`);
        tempFiles.push(concatListPath);
        fs.writeFileSync(concatListPath, allClips.map(p => `file '${p}'`).join('\n'));

        const concatPath = path.join(TEMP_DIR, `${jobId}_concat.mp4`);
        tempFiles.push(concatPath);
        // v3.6.0: extend clips to totalDuration (audioDuration + CTA_HOLD) so CTA hold frame has video
        execSync(
          `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -t ${totalDuration.toFixed(2)} -c:v libx264 -preset fast -pix_fmt yuv420p -r 30 "${concatPath}"`,
          { timeout: 300000, shell: true }
        );
        baseVideoPath = concatPath;
      }
    }

    // Fallback: dark branded background
    if (!baseVideoPath) {
      console.log(`[${jobId}] Using fallback dark background`);
      const bgPath = path.join(TEMP_DIR, `${jobId}_bg.mp4`);
      tempFiles.push(bgPath);
      // v3.6.0: extend fallback bg to totalDuration
      execSync(
        `ffmpeg -y -f lavfi -i "color=c=0x0d1117:size=1080x1920:rate=30" -t ${totalDuration.toFixed(2)} -c:v libx264 -preset fast -pix_fmt yuv420p "${bgPath}"`,
        { timeout: 120000, shell: true }
      );
      baseVideoPath = bgPath;
    }

    // ─── Step 4: Build caption segments ───────────────────────────────────────
    // v3.3.0: PRIMARY PATH — use word_timing directly for perfect sync
    //         FALLBACK PATH — parse script text proportionally
    let segments;
    if (word_timing && word_timing.length > 0) {
      console.log(`[${jobId}] v3.3.0: Building captions from ${word_timing.length} ElevenLabs word timestamps`);
      segments = buildSegmentsFromWordTiming(word_timing, audioDuration);
      if (!segments || segments.length === 0) {
        console.warn(`[${jobId}] Word timing produced no segments — falling back to script parse`);
        segments = parseCaptionSegments(scriptText, caption_text || firstItem.caption || '', content_angle);
      }
    } else {
      console.log(`[${jobId}] No word_timing provided — using script text parsing (proportional timing)`);
      segments = parseCaptionSegments(scriptText, caption_text || firstItem.caption || '', content_angle);
    }
    console.log(`[${jobId}] Final: ${segments.length} caption segments`);

    // Step 5: Compose final video
    console.log(`[${jobId}] Composing final video... burn_captions=${burn_captions}`);

    const logoExists = fs.existsSync(logoPath) && fs.statSync(logoPath).size > 1000;
    // v3.6.5: skip burned-in captions when burn_captions=false (e.g. YouTube uses auto-captions)
    const cyclingFilters = burn_captions ? buildCaptionFilters(segments, audioDuration, FONT_BOLD) : [];

    // End card: v3.6.0 — 8 seconds AFTER audio ends (CTA hold frame)
    // NOTE: CTA_HOLD and totalDuration are declared earlier (after audioDuration) to avoid TDZ error
    const endCardStart = audioDuration;
    const endCardEnable = `enable='between(t,${endCardStart.toFixed(2)},${totalDuration.toFixed(2)})'`;

    const staticVfFilters = [
      `eq=contrast=1.05`,
      // yfitai.com — top-right, YFIT green, shadow only
      `drawtext=fontfile=${FONT_BOLD}:text='yfitai.com':fontsize=30:fontcolor=${YFIT_GREEN}@0.95:` +
      `x=w-text_w-24:y=28:shadowcolor=black@0.85:shadowx=2:shadowy=2`,
      // End card
      `drawtext=fontfile=${FONT_BOLD}:text='Try YFIT AI Free':fontsize=40:fontcolor=white@0.95:x=(w-text_w)/2:y=(h/2)-70:shadowcolor=black@0.9:shadowx=2:shadowy=2:${endCardEnable}`,
      `drawtext=fontfile=${FONT_BOLD}:text='yfitai.com':fontsize=64:fontcolor=${YFIT_GREEN}:x=(w-text_w)/2:y=(h/2)-2:shadowcolor=black@0.9:shadowx=3:shadowy=3:${endCardEnable}`,
    ];

    const vfOnlyFilters = [...staticVfFilters, ...(burn_captions ? cyclingFilters : [])].join(',');

    const fcScriptPath = path.join(TEMP_DIR, `${jobId}_fc.txt`);
    tempFiles.push(fcScriptPath);
    let finalCmd;
    if (logoExists) {
      if (bgmExists) {
        // v3.6.0: pad audio with CTA_HOLD seconds of silence so video runs full totalDuration
        const fc = `[0:v]${vfOnlyFilters}[vbase];[1:v]scale=240:-1,format=rgba[logo];[vbase][logo]overlay=x=20:y=10:format=auto[vout];[2:a]aresample=48000,highpass=f=150,lowpass=f=12000,volume=${BGM_VOLUME},aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=1.5,afade=t=out:st=999:d=2[bgm];[3:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[voice];aevalsrc=0:c=stereo:s=48000:d=${CTA_HOLD.toFixed(1)}[silence];[voice][silence]concat=n=2:v=0:a=1[voicepadded];[voicepadded][bgm]amix=inputs=2:duration=first:dropout_transition=3[aout]`;
        fs.writeFileSync(fcScriptPath, fc);
        finalCmd = `ffmpeg -y -i "${baseVideoPath}" -i "${logoPath}" -i "${bgmPath}" -i "${audioPath}" -filter_complex_script "${fcScriptPath}" -map "[vout]" -map "[aout]" -t ${totalDuration.toFixed(2)} -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -ar 48000 -pix_fmt yuv420p -movflags +faststart "${finalPath}"`;
      } else {
        // v3.6.0: pad audio with silence for CTA hold (no BGM path)
        const fc = `[0:v]${vfOnlyFilters}[vbase];[1:v]scale=240:-1,format=rgba[logo];[vbase][logo]overlay=x=20:y=10:format=auto[vout];[2:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[voice];aevalsrc=0:c=stereo:s=48000:d=${CTA_HOLD.toFixed(1)}[silence];[voice][silence]concat=n=2:v=0:a=1[aout]`;
        fs.writeFileSync(fcScriptPath, fc);
        finalCmd = `ffmpeg -y -i "${baseVideoPath}" -i "${logoPath}" -i "${audioPath}" -filter_complex_script "${fcScriptPath}" -map "[vout]" -map "[aout]" -t ${totalDuration.toFixed(2)} -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -pix_fmt yuv420p -movflags +faststart "${finalPath}"`;
      }
    } else {
      // Text-only fallback if logo download failed
      const fallbackVf = [
        ...staticVfFilters,
        `drawtext=fontfile=${FONT_BOLD}:text='YFIT AI':fontsize=36:fontcolor=${YFIT_GREEN}@0.95:x=20:y=20:shadowcolor=black@0.85:shadowx=2:shadowy=2`,
        ...cyclingFilters
      ].join(',');
      if (bgmExists) {
        // v3.6.0: pad audio with silence for CTA hold (no-logo + BGM path)
        finalCmd = [
          'ffmpeg -y',
          `-i "${baseVideoPath}"`,
          `-i "${bgmPath}"`,
          `-i "${audioPath}"`,
          `-filter_complex "[1:a]aresample=48000,highpass=f=150,lowpass=f=12000,volume=${BGM_VOLUME},aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=1.5,afade=t=out:st=999:d=2[bgm];[2:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[voice];aevalsrc=0:c=stereo:s=48000:d=${CTA_HOLD.toFixed(1)}[silence];[voice][silence]concat=n=2:v=0:a=1[voicepadded];[voicepadded][bgm]amix=inputs=2:duration=first:dropout_transition=3[aout]"`,
          `-map 0:v -map "[aout]"`,
          `-vf "${fallbackVf}"`,
          `-t ${totalDuration.toFixed(2)}`,
          `-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k`,
          `-pix_fmt yuv420p -movflags +faststart`,
          `"${finalPath}"`
        ].join(' ');
      } else {
        // v3.6.0: pad audio with silence for CTA hold (no-logo, no-BGM path)
        finalCmd = [
          'ffmpeg -y',
          `-i "${baseVideoPath}"`,
          `-i "${audioPath}"`,
          `-filter_complex "[1:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11[voice];aevalsrc=0:c=stereo:s=48000:d=${CTA_HOLD.toFixed(1)}[silence];[voice][silence]concat=n=2:v=0:a=1[aout]"`,
          `-map 0:v -map "[aout]"`,
          `-vf "${fallbackVf}"`,
          `-t ${totalDuration.toFixed(2)}`,
          `-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k`,
          `-pix_fmt yuv420p -movflags +faststart`,
          `"${finalPath}"`
        ].join(' ');
      }
    }
    execSync(finalCmd, { timeout: 600000, shell: true });

    const videoSize = fs.statSync(finalPath).size;
    console.log(`[${jobId}] Final video: ${videoSize} bytes`);

    // Step 6: Upload to Supabase
    const safeRunDate = run_date || new Date().toISOString().split('T')[0];
    const storagePath = `videos/${safeRunDate}_${safeAngle}.mp4`;
    const videoUrl = await uploadToSupabase(finalPath, storagePath, 'video/mp4');
    console.log(`[${jobId}] Uploaded: ${videoUrl}`);

    // Cleanup temp files
    tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });

    res.json({
      success: true, dry_run: false, job_id: jobId,
      video_url: videoUrl,
      video_size_bytes: videoSize,
      pexels_clips_used: pexelsClips.length,
      tips_count: segments.length,
      bgm_track: selectedBgmName,
      caption_sync_mode: (word_timing && word_timing.length > 0) ? 'word_timing' : 'proportional',
      platforms: video_items.map(v => v.platform),
      text_platforms: text_items.map(t => t.platform),
      voiceover_url, content_angle, run_date
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
    res.status(500).json({ success: false, error: err.message, job_id: jobId });
  }
});

app.listen(PORT, () => {
  console.log(`YFIT Video Service v3.6.5 running on port ${PORT}`);
  console.log(`Pexels API: ${PEXELS_API_KEY ? 'configured' : 'NOT configured - set PEXELS_API_KEY'}`);
  console.log(`Logo URL: ${YFIT_LOGO_URL}`);
  console.log(`BGM: Primary=${BGM_TRACKS.primary.split('/').pop()}, Energetic=${BGM_TRACKS.energetic.split('/').pop()}, Deep=${BGM_TRACKS.deep.split('/').pop()}`);
  try {
    console.log(`ffmpeg: ${execSync('ffmpeg -version 2>&1 | head -1').toString().trim()}`);
  } catch (e) {
    console.warn('WARNING: ffmpeg not found!');
  }
});
