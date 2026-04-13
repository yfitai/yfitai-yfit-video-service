'use strict';
// ============================================================
// YFIT Video Service v3.0.0
// ============================================================
// CHANGES vs v2.8.0:
//
//  FIX 1 — BRAND MUSIC (sonic identity)
//    Replaced random 5-track pool with content-angle-mapped
//    signature tracks. bgm_motivational is the YFIT primary
//    signature. bgm_energetic plays for high-intensity angles
//    (workout_tips, form_analysis). bgm_deep plays for
//    science/medical angles (medication_fitness, nutrition_science).
//    Consistent audio = instant brand recall across all platforms.
//
//  FIX 2 — TEXT OVERLAY POSITION (center-screen)
//    Moved caption text from bottom-of-screen (y=h-295) to
//    center-screen (y=(h/2)-offset). Added semi-transparent
//    dark pill/box behind each text line for readability on any
//    background. Bottom black bar removed — it blocked platform
//    UI on TikTok/Instagram Reels. Brand URL moved to top-right.
//
//  FIX 3 — HOOK CARD STYLING (first 1.5s visual punch)
//    Segment 0 (the script hook) now renders at 56px bold white
//    with YFIT green (#00ff88) shadow — visually distinct from
//    body segments (46px white). Hook always starts at t=0.
//    This matches the Gymshark/Peloton hook-card pattern.
//
//  FIX 4 — PEOPLE IN MOTION (Pexels query improvement)
//    All Pexels queries now append "person" or "athlete" to
//    maximise the probability of returning clips with a human
//    body in motion. Clips under 4 seconds are rejected (too
//    short to show meaningful motion). Minimum 6 clips requested
//    per query (up from 12 results filtered to 6).
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

// YFIT logo hosted on Supabase (transparent background PNG)
const YFIT_LOGO_URL = `${SUPABASE_URL}/storage/v1/object/public/yfit-videos/assets/yfit-logo-transparent.png`;

// ─── FIX 1: BRAND MUSIC — Sonic Identity ─────────────────────────────────────
// YFIT uses a consistent signature track per content angle rather than random
// selection. This builds instant audio brand recognition across all platforms.
//
// Primary signature:  bgm_motivational  — warm, uplifting, universal YFIT sound
// High-intensity alt: bgm_energetic     — workout_tips, form_analysis
// Science/calm alt:   bgm_deep          — medication_fitness, nutrition_science
//
// All three tracks are royalty-free and stored in Supabase.
const BGM_TRACKS = {
  primary:    `${SUPABASE_URL}/storage/v1/object/public/yfit-voiceovers/assets/bgm_motivational.mp3`,
  energetic:  `${SUPABASE_URL}/storage/v1/object/public/yfit-voiceovers/assets/bgm_energetic.mp3`,
  deep:       `${SUPABASE_URL}/storage/v1/object/public/yfit-voiceovers/assets/bgm_deep.mp3`,
};

// Map content angle → BGM track
function getBgmForAngle(contentAngle) {
  const angle = (contentAngle || '').toLowerCase();
  if (angle === 'workout_tips' || angle === 'form_analysis' || angle === 'transformation_story') {
    return BGM_TRACKS.energetic;
  }
  if (angle === 'medication_fitness' || angle === 'nutrition_science' || angle === 'recovery_wellness') {
    return BGM_TRACKS.deep;
  }
  // Default: primary YFIT signature for myth_busting, general content, unknown angles
  return BGM_TRACKS.primary;
}

// BGM at 12% — subtle presence, industry standard for background music under voiceover.
// 45% was too loud and sounded like a hum competing with the voice.
const BGM_VOLUME = 0.12;

// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DIR = '/tmp/yfit-videos';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

// YFIT brand green — used for hook card and logo accent
const YFIT_GREEN = '0x00ff88';

// Health check
app.get('/health', (req, res) => {
  let ffmpegVersion = 'not found';
  try { ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -1').toString().trim(); } catch (e) {}
  res.json({
    status: 'ok',
    ffmpeg: ffmpegVersion,
    pexels: PEXELS_API_KEY ? 'configured' : 'missing',
    version: '3.0.8',
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

// ─── FIX 4: PEOPLE IN MOTION — Pexels search ─────────────────────────────────
// Appends "person" or "athlete" to every query so Pexels returns clips with
// a human body in motion rather than empty gyms or equipment close-ups.
// Clips under 4 seconds are rejected — too short to show meaningful motion.
function searchPexels(query) {
  return new Promise((resolve) => {
    if (!PEXELS_API_KEY) { resolve([]); return; }

    // Always append a human-presence term to maximise motion clips
    const humanTerm = query.toLowerCase().includes('food') || query.toLowerCase().includes('meal') || query.toLowerCase().includes('nutrition')
      ? 'person eating healthy'   // nutrition queries: person eating, not just food
      : `person ${query}`;        // all other queries: person doing the activity

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
            // FIX 4b: Reject clips under 4 seconds — too short to show motion
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

// Fitness-specific fallback chain — always returns clips with people in motion
async function getPexelsClips(query) {
  const queryLower = (query || '').toLowerCase();

  // Build topic-specific fallbacks with human-presence terms
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

  // Always-reliable fitness fallbacks with human presence
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
      { timeout: 30000 }
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

// Sanitize text for ffmpeg drawtext (removes special chars that break ffmpeg filter syntax)
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
    .replace(/^[.\s]+/, '')   // strip leading periods and whitespace
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

// Parse script into caption segments for cycling
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

// ─── FIX 2 + 3: CENTER-SCREEN TEXT OVERLAY with HOOK CARD STYLING ────────────
//
// Layout (9:16 portrait, 1080×1920):
//   - Caption text: centered vertically at ~45% height (slightly above center)
//     so it clears the platform's bottom UI (like/comment/share buttons)
//     and the top UI (profile name, follow button).
//   - Dark semi-transparent pill box behind each text line for readability
//     on any background (bright outdoor, dark gym, etc.)
//   - Segment 0 (the HOOK): 56px bold, YFIT green shadow — visually distinct
//     to create the "hook card" effect in the first 1.5 seconds.
//   - Body segments: 46px bold, white with dark shadow.
//   - Brand URL: top-right corner, small, always visible.
//
// Why center not bottom:
//   Bottom 20% of frame is covered by platform UI on TikTok/Instagram/YouTube
//   Shorts. Center-screen text is the industry standard for short-form fitness
//   content (Gymshark, Peloton, ATHLEAN-X all use this layout).
// ─────────────────────────────────────────────────────────────────────────────
function buildCyclingCaptionFilters(segments, audioDuration, font, wordTiming) {
  if (segments.length === 0) return [];
  const filters = [];

  let segmentTimings;

  if (wordTiming && wordTiming.length > 0) {
    console.log(`[captions] Using ElevenLabs word timing (${wordTiming.length} words)`);

    const normalizeWord = (w) => (w || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const allSegmentWords = segments.map(s =>
      (s.rawText || s.text).split(/\s+/).filter(w => w.length > 0).map(normalizeWord)
    );

    const timingWords = wordTiming.map(t => ({
      norm: normalizeWord(t.word || ''),
      start: t.start || 0,
      end: t.end || 0
    }));

    let timingCursor = 0;

    segmentTimings = segments.map((seg, si) => {
      const segWords = allSegmentWords[si];
      if (segWords.length === 0) {
        return { startTime: audioDuration * (si / segments.length), endTime: audioDuration * ((si + 1) / segments.length) };
      }

      const firstWord = segWords[0];
      let matchStart = timingCursor;
      for (let ti = timingCursor; ti < Math.min(timingCursor + 20, timingWords.length); ti++) {
        if (timingWords[ti].norm === firstWord || timingWords[ti].norm.includes(firstWord) || firstWord.includes(timingWords[ti].norm)) {
          matchStart = ti;
          break;
        }
      }

      const advanceBy = Math.max(1, segWords.length);
      const matchEnd = Math.min(matchStart + advanceBy - 1, timingWords.length - 1);
      timingCursor = matchStart + advanceBy;

      const startTime = timingWords[matchStart] ? timingWords[matchStart].start : 0;
      const endTime = timingWords[matchEnd] ? timingWords[matchEnd].end : startTime + 1;

      return { startTime, endTime };
    });

    // Extend last segment to full audio duration
    if (segmentTimings.length > 0) {
      segmentTimings[segmentTimings.length - 1].endTime = audioDuration;
    }

    // Fill gaps
    for (let i = 0; i < segmentTimings.length - 1; i++) {
      if (segmentTimings[i].endTime < segmentTimings[i + 1].startTime) {
        segmentTimings[i].endTime = segmentTimings[i + 1].startTime;
      }
    }

    console.log(`[captions] Segment timings:`);
    segmentTimings.forEach((t, i) => {
      console.log(`  [${i}] ${t.startTime.toFixed(2)}s → ${t.endTime.toFixed(2)}s: "${segments[i].text.substring(0, 40)}"`);
    });

  } else {
    // Fallback: proportional word-count estimation
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
    // The end card fires at audioDuration-3s, so the last caption must end there
    const endCardStartTime = Math.max(0, audioDuration - 3.0);
    if (segmentTimings.length > 0) {
      const lastTiming = segmentTimings[segmentTimings.length - 1];
      if (lastTiming.endTime > endCardStartTime) {
        lastTiming.endTime = endCardStartTime;
      }
    }

    // Build drawtext filters from computed timings
  for (let i = 0; i < segments.length; i++) {
    const { startTime, endTime } = segmentTimings[i];
    const isHook = (i === 0);  // FIX 3: First segment = hook card
    // CTA end card: last segment that contains CTA keywords gets YFIT green styling
    const ctaKeywords = /\b(try|free|link in bio|download|sign up|get started|join|click|tap)\b/i;
    const isCta = (i === segments.length - 1) && ctaKeywords.test(segments[i].rawText || segments[i].text);

    // Wrap text tighter for center-screen (24 chars per line looks better centered)
    const lines = wrapText(segments[i].text, 24);
    const line1 = (lines[0] || '').replace(/:/g, '\\:');
    const line2 = (lines[1] || '').replace(/:/g, '\\:');
    const line3 = (lines[2] || '').replace(/:/g, '\\:');

    const enableExpr = `enable='between(t,${startTime.toFixed(2)},${endTime.toFixed(2)})'`;

    // Center-screen vertical position
    // 1920 * 0.42 ≈ 806 — slightly above center, clear of platform UI top and bottom
    // Each line is ~60px tall at 56px font, ~52px at 46px font
    const lineCount = [line1, line2, line3].filter(Boolean).length;
    const lineHeight = isHook ? 64 : 56;
    const totalTextHeight = lineCount * lineHeight;
    // Center block: start at (h - totalTextHeight) / 2
    const blockTop = `(h-${totalTextHeight})/2`;

    // NOTE: drawbox does NOT support text_w — it's only available in drawtext.
    // We use fixed-width pill boxes wide enough for 24-char lines at the given font sizes.
    // At 56px bold DejaVu, 24 chars ≈ 700px wide. At 46px, 24 chars ≈ 580px wide.
    // Boxes are centered using x=(w-BOX_W)/2 with a fixed BOX_W.
    if (isHook) {
      // ── HOOK CARD: Large, YFIT green shadow, bold white text ──────────────
      // Fixed pill box width for 56px font: 24 chars × ~29px/char ≈ 700px + 40px padding
      const hookBoxW = 740;
      if (line1) {
        filters.push(
          `drawbox=x=(w-${hookBoxW})/2:y=${blockTop}-12:w=${hookBoxW}:h=${lineHeight}+8:color=black@0.65:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line1}':fontsize=56:fontcolor=white:` +
          `x=(w-text_w)/2:y=${blockTop}:` +
          `shadowcolor=${YFIT_GREEN}@0.9:shadowx=0:shadowy=3:` +
          `${enableExpr}`
        );
      }
      if (line2) {
        const y2 = `${blockTop}+${lineHeight}`;
        filters.push(
          `drawbox=x=(w-${hookBoxW})/2:y=${y2}-12:w=${hookBoxW}:h=${lineHeight}+8:color=black@0.65:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line2}':fontsize=54:fontcolor=white@0.97:` +
          `x=(w-text_w)/2:y=${y2}:` +
          `shadowcolor=${YFIT_GREEN}@0.7:shadowx=0:shadowy=2:` +
          `${enableExpr}`
        );
      }
      if (line3) {
        const y3 = `${blockTop}+${lineHeight * 2}`;
        filters.push(
          `drawbox=x=(w-${hookBoxW})/2:y=${y3}-12:w=${hookBoxW}:h=${lineHeight}+8:color=black@0.65:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line3}':fontsize=52:fontcolor=white@0.95:` +
          `x=(w-text_w)/2:y=${y3}:` +
          `shadowcolor=${YFIT_GREEN}@0.6:shadowx=0:shadowy=2:` +
          `${enableExpr}`
        );
      }
    } else if (isCta) {
      // ── CTA END CARD: YFIT green text, bright pill, closing call-to-action ──
      const ctaBoxW = 700;
      if (line1) {
        filters.push(
          `drawbox=x=(w-${ctaBoxW})/2:y=${blockTop}-12:w=${ctaBoxW}:h=${lineHeight}+8:color=black@0.80:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line1}':fontsize=50:fontcolor=${YFIT_GREEN}:` +
          `x=(w-text_w)/2:y=${blockTop}:` +
          `shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
          `${enableExpr}`
        );
      }
      if (line2) {
        const y2 = `${blockTop}+${lineHeight}`;
        filters.push(
          `drawbox=x=(w-${ctaBoxW})/2:y=${y2}-12:w=${ctaBoxW}:h=${lineHeight}+8:color=black@0.80:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line2}':fontsize=48:fontcolor=${YFIT_GREEN}@0.95:` +
          `x=(w-text_w)/2:y=${y2}:` +
          `shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
          `${enableExpr}`
        );
      }
      if (line3) {
        const y3 = `${blockTop}+${lineHeight * 2}`;
        filters.push(
          `drawbox=x=(w-${ctaBoxW})/2:y=${y3}-12:w=${ctaBoxW}:h=${lineHeight}+8:color=black@0.80:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line3}':fontsize=46:fontcolor=${YFIT_GREEN}@0.90:` +
          `x=(w-text_w)/2:y=${y3}:` +
          `shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
          `${enableExpr}`
        );
      }
    } else {
      // ── BODY SEGMENTS: Clean white text, dark shadow, pill background ─────
      // Fixed pill box width for 46px font: 24 chars × ~24px/char ≈ 580px + 32px padding
      const bodyBoxW = 620;
      if (line1) {
        filters.push(
          `drawbox=x=(w-${bodyBoxW})/2:y=${blockTop}-10:w=${bodyBoxW}:h=${lineHeight}+6:color=black@0.60:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line1}':fontsize=46:fontcolor=white:` +
          `x=(w-text_w)/2:y=${blockTop}:` +
          `shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
          `${enableExpr}`
        );
      }
      if (line2) {
        const y2 = `${blockTop}+${lineHeight}`;
        filters.push(
          `drawbox=x=(w-${bodyBoxW})/2:y=${y2}-10:w=${bodyBoxW}:h=${lineHeight}+6:color=black@0.60:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line2}':fontsize=44:fontcolor=white@0.95:` +
          `x=(w-text_w)/2:y=${y2}:` +
          `shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
          `${enableExpr}`
        );
      }
      if (line3) {
        const y3 = `${blockTop}+${lineHeight * 2}`;
        filters.push(
          `drawbox=x=(w-${bodyBoxW})/2:y=${y3}-10:w=${bodyBoxW}:h=${lineHeight}+6:color=black@0.60:t=fill:` +
          `${enableExpr}`
        );
        filters.push(
          `drawtext=fontfile=${font}:text='${line3}':fontsize=42:fontcolor=white@0.90:` +
          `x=(w-text_w)/2:y=${y3}:` +
          `shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
          `${enableExpr}`
        );
      }
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
    word_timing = []
  } = req.body;

  if (typeof word_timing === 'string') { try { word_timing = JSON.parse(word_timing); } catch(e) { word_timing = []; } }
  if (typeof video_items === 'string') { try { video_items = JSON.parse(video_items); } catch(e) { video_items = []; } }
  if (typeof text_items === 'string') { try { text_items = JSON.parse(text_items); } catch(e) { text_items = []; } }
  if (typeof dry_run === 'string') { dry_run = dry_run === 'true'; }

  if (!voiceover_url) return res.status(400).json({ error: 'voiceover_url is required' });

  const jobId = `${run_date || 'test'}_${Date.now()}`;
  const safeAngle = (content_angle || 'workout').replace(/[^a-z0-9\-]/gi, '_').substring(0, 60);
  const searchQuery = pexels_query || content_angle || 'fitness workout';

  // Get script from first video item if not at top level
  const firstItem = video_items[0] || {};
  const scriptText = script || firstItem.script || '';

  console.log(`[${jobId}] Starting assembly v3.0.0. dry_run=${dry_run}, query="${searchQuery}", angle="${content_angle}"`);

  // Dry run — return mock response without processing
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

    // Step 2: Download YFIT logo
    console.log(`[${jobId}] Downloading YFIT logo...`);
    try {
      await downloadFile(YFIT_LOGO_URL, logoPath);
      console.log(`[${jobId}] Logo downloaded OK`);
    } catch (e) {
      console.warn(`[${jobId}] Logo download failed: ${e.message} - will skip logo`);
    }

    // Step 2b: FIX 1 — Download content-angle-mapped BGM (brand sonic identity)
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

    // Step 3: Get Pexels clips (FIX 4 — people in motion queries)
    console.log(`[${jobId}] Fetching Pexels clips for: "${searchQuery}"...`);
    const pexelsClips = await getPexelsClips(searchQuery);
    console.log(`[${jobId}] Got ${pexelsClips.length} Pexels clips`);

    let baseVideoPath = null;

    if (pexelsClips.length > 0) {
      const numClips = Math.min(pexelsClips.length, 6);
      const clipDuration = Math.max(2.5, Math.min(4.0, audioDuration / numClips));
      const trimmedPaths = [];

      for (let i = 0; i < numClips; i++) {
        const clip = pexelsClips[i];
        const rawPath = path.join(TEMP_DIR, `${jobId}_raw_${i}.mp4`);
        const trimPath = path.join(TEMP_DIR, `${jobId}_clip_${i}.mp4`);
        tempFiles.push(rawPath, trimPath);

        try {
          await downloadFile(clip.url, rawPath);
          const rawSize = fs.statSync(rawPath).size;
          if (rawSize < 50000) { console.warn(`[${jobId}] Clip ${i} too small (${rawSize}b), skipping`); continue; }

          // Force portrait 1080x1920 crop + slight contrast boost
          // This is critical: Pexels clips are landscape by default.
          // scale=1080:1920:force_original_aspect_ratio=increase fills the frame,
          // then crop=1080:1920 centre-crops to exact portrait dimensions.
          const portraitFilter = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,eq=contrast=1.08:saturation=1.05`;
          const trimCmd = [
            'ffmpeg -y',
            `-i "${rawPath}"`,
            `-t ${clipDuration.toFixed(2)}`,
            `-vf "${portraitFilter}"`,
            `-c:v libx264 -preset fast -pix_fmt yuv420p -an -r 30`,
            `"${trimPath}"`
          ].join(' ');
          execSync(trimCmd, { timeout: 120000, shell: true });
          trimmedPaths.push(trimPath);
        } catch (e) {
          console.warn(`[${jobId}] Clip ${i} failed: ${e.message}`);
        }
      }

      if (trimmedPaths.length > 0) {
        const totalClipDuration = trimmedPaths.length * clipDuration;
        const repeatsNeeded = Math.ceil(audioDuration / totalClipDuration);
        const allClips = [];
        for (let r = 0; r < repeatsNeeded; r++) allClips.push(...trimmedPaths);

        const concatListPath = path.join(TEMP_DIR, `${jobId}_concat.txt`);
        tempFiles.push(concatListPath);
        fs.writeFileSync(concatListPath, allClips.map(p => `file '${p}'`).join('\n'));

        const concatPath = path.join(TEMP_DIR, `${jobId}_concat.mp4`);
        tempFiles.push(concatPath);
        execSync(
          `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -t ${audioDuration.toFixed(2)} -c:v libx264 -preset fast -pix_fmt yuv420p -r 30 "${concatPath}"`,
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
      execSync(
        `ffmpeg -y -f lavfi -i "color=c=0x0d1117:size=1080x1920:rate=30" -t ${audioDuration.toFixed(2)} -c:v libx264 -preset fast -pix_fmt yuv420p "${bgPath}"`,
        { timeout: 120000, shell: true }
      );
      baseVideoPath = bgPath;
    }

    // Step 4: Parse caption segments
    const segments = parseCaptionSegments(scriptText, caption_text || firstItem.caption || '', content_angle);
    console.log(`[${jobId}] Parsed ${segments.length} caption segments (segment 0 = hook card)`);

    // Step 5: Compose final video (FIX 2+3 — center-screen overlay, hook card)
    console.log(`[${jobId}] Composing final video with center-screen overlays...`);

    const logoExists = fs.existsSync(logoPath) && fs.statSync(logoPath).size > 1000;

    // FIX 2: Static filters — removed bottom black bar (drawbox).
    // Brand URL moved to top-right, small and unobtrusive.
    // Slight contrast boost to make people in motion pop.
    const cyclingFilters = buildCyclingCaptionFilters(segments, audioDuration, FONT_BOLD, word_timing);

    // End card: last 3 seconds of every video — large yfitai.com on screen
    // This fires regardless of what the script says, ensuring the URL is always visible
    const endCardStart = Math.max(0, audioDuration - 3.0);
    const endCardEnable = `enable='between(t,${endCardStart.toFixed(2)},${audioDuration.toFixed(2)})'`;

    const staticFilters = [
      `eq=contrast=1.05`,
      // Brand URL — YFIT green for brand recognition, top-right corner (always visible)
      `drawtext=fontfile=${FONT_BOLD}:text='yfitai.com':fontsize=30:fontcolor=${YFIT_GREEN}@0.90:` +
      `x=w-text_w-24:y=24:shadowcolor=black@0.9:shadowx=1:shadowy=1`,
      // End card: "Try YFIT AI Free" above, large yfitai.com below — centered block
      // Total block height: 52px label + 12px gap + 76px URL = 140px
      // Center block at h/2 - 70 so the whole block is vertically centered
      `drawbox=x=(w-500)/2:y=(h/2)-78:w=500:h=56:color=black@0.75:t=fill:${endCardEnable}`,
      `drawtext=fontfile=${FONT_BOLD}:text='Try YFIT AI Free':fontsize=40:fontcolor=white@0.95:x=(w-text_w)/2:y=(h/2)-70:shadowcolor=black@0.9:shadowx=1:shadowy=1:${endCardEnable}`,
      `drawbox=x=(w-640)/2:y=(h/2)-10:w=640:h=80:color=black@0.80:t=fill:${endCardEnable}`,
      `drawtext=fontfile=${FONT_BOLD}:text='yfitai.com':fontsize=64:fontcolor=${YFIT_GREEN}:x=(w-text_w)/2:y=(h/2)-2:shadowcolor=black@0.9:shadowx=2:shadowy=2:${endCardEnable}`,
    ];

    if (logoExists) {
      const allVfFilters = [...staticFilters, ...cyclingFilters].join(',');

      const filterComplex = [
        // Crop logo to just the Y+wings icon (left 65% of the 1144x388 logo = 743px wide)
      // This removes the 'FIT' text and gives a compact icon watermark in the top-left corner
      `[1:v]crop=743:388:0:0,scale=120:-1,format=rgba,colorchannelmixer=aa=0.55[logo]`,
        `[0:v]${allVfFilters}[base]`,
        // Logo: top-left corner, small and clean
        `[base][logo]overlay=x=20:y=20[out]`
      ].join(';');

      let finalCmd;
      if (bgmExists) {
        const audioFilterComplex = [
          filterComplex,
          `[2:a]aresample=44100,volume=${BGM_VOLUME},aloop=loop=-1:size=2e+09[bgm]`,
          `[3:a]aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11[voice]`,
          `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=3[aout]`
        ].join(';');
        finalCmd = [
          'ffmpeg -y',
          `-i "${baseVideoPath}"`,
          `-i "${logoPath}"`,
          `-i "${bgmPath}"`,
          `-i "${audioPath}"`,
          `-filter_complex "${audioFilterComplex}"`,
          `-map "[out]"`,
          `-map "[aout]"`,
          `-c:v libx264 -preset fast -crf 22`,
          `-c:a aac -b:a 192k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
          `-movflags +faststart`,
          `"${finalPath}"`
        ].join(' ');
      } else {
        finalCmd = [
          'ffmpeg -y',
          `-i "${baseVideoPath}"`,
          `-i "${logoPath}"`,
          `-i "${audioPath}"`,
          `-filter_complex "${filterComplex}"`,
          `-map "[out]"`,
          `-map 2:a`,
          `-c:v libx264 -preset fast -crf 22`,
          `-c:a aac -b:a 192k -af "loudnorm=I=-16:TP=-1.5:LRA=11"`,
          `-pix_fmt yuv420p`,
          `-shortest`,
          `-movflags +faststart`,
          `"${finalPath}"`
        ].join(' ');
      }

      execSync(finalCmd, { timeout: 600000, shell: true });

    } else {
      // No logo — text branding only
      console.log(`[${jobId}] Logo not available, using text branding`);
      const textBrandFilters = [
        ...staticFilters,
        // YFIT brand name top-left when no logo
        `drawtext=fontfile=${FONT_BOLD}:text='YFIT AI':fontsize=52:fontcolor=${YFIT_GREEN}:` +
        `x=24:y=24:shadowcolor=black:shadowx=2:shadowy=2`,
      ];
      const vfFilter = [...textBrandFilters, ...cyclingFilters].join(',');

      let finalCmd;
      if (bgmExists) {
        finalCmd = [
          'ffmpeg -y',
          `-i "${baseVideoPath}"`,
          `-i "${bgmPath}"`,
          `-i "${audioPath}"`,
          `-filter_complex "[1:a]aresample=44100,volume=${BGM_VOLUME},aloop=loop=-1:size=2e+09[bgm];[2:a]aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11[voice];[voice][bgm]amix=inputs=2:duration=first:dropout_transition=3[aout]"`,
          `-map 0:v`,
          `-map "[aout]"`,
          `-vf "${vfFilter}"`,
          `-c:v libx264 -preset fast -crf 22`,
          `-c:a aac -b:a 192k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
          `-movflags +faststart`,
          `"${finalPath}"`
        ].join(' ');
      } else {
        finalCmd = [
          'ffmpeg -y',
          `-i "${baseVideoPath}"`,
          `-i "${audioPath}"`,
          `-vf "${vfFilter}"`,
          `-c:v libx264 -preset fast -crf 22`,
          `-c:a aac -b:a 192k -af "loudnorm=I=-16:TP=-1.5:LRA=11"`,
          `-pix_fmt yuv420p`,
          `-shortest`,
          `-movflags +faststart`,
          `"${finalPath}"`
        ].join(' ');
      }
      execSync(finalCmd, { timeout: 600000, shell: true });
    }

    const videoSize = fs.statSync(finalPath).size;
    console.log(`[${jobId}] Final video: ${videoSize} bytes`);

    // Step 6: Upload to Supabase
    const storagePath = `videos/${run_date}_${safeAngle}.mp4`;
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
  console.log(`YFIT Video Service v3.0.0 running on port ${PORT}`);
  console.log(`Pexels API: ${PEXELS_API_KEY ? 'configured' : 'NOT configured - set PEXELS_API_KEY'}`);
  console.log(`Logo URL: ${YFIT_LOGO_URL}`);
  console.log(`BGM: Primary=${BGM_TRACKS.primary.split('/').pop()}, Energetic=${BGM_TRACKS.energetic.split('/').pop()}, Deep=${BGM_TRACKS.deep.split('/').pop()}`);
  try {
    console.log(`ffmpeg: ${execSync('ffmpeg -version 2>&1 | head -1').toString().trim()}`);
  } catch (e) {
    console.warn('WARNING: ffmpeg not found!');
  }
});
