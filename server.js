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

const TEMP_DIR = '/tmp/yfit-videos';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

// Health check
app.get('/health', (req, res) => {
  let ffmpegVersion = 'not found';
  try { ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -1').toString().trim(); } catch (e) {}
  res.json({
    status: 'ok',
    ffmpeg: ffmpegVersion,
    pexels: PEXELS_API_KEY ? 'configured' : 'missing',
    version: '2.4.0',
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

// Search Pexels for portrait fitness videos
function searchPexels(query) {
  return new Promise((resolve) => {
    if (!PEXELS_API_KEY) { resolve([]); return; }
    const q = encodeURIComponent(query);
    const options = {
      hostname: 'api.pexels.com',
      path: `/videos/search?query=${q}&per_page=15&orientation=portrait&size=medium`,
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
          for (const video of (result.videos || []).slice(0, 12)) {
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

// Search with fallback terms
async function getPexelsClips(query) {
  const fallbacks = [query, 'fitness workout', 'gym exercise', 'running athlete', 'healthy active lifestyle'];
  for (const q of fallbacks) {
    const clips = await searchPexels(q);
    if (clips.length > 0) return clips;
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
  return (text || '')
    .replace(/[^\w\s\-.,!?]/g, ' ')
    .replace(/'/g, '')
    .replace(/"/g, '')
    .replace(/:/g, ' -')
    .replace(/\\/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
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

// Parse script/article into caption segments for cycling
// Returns array of { text, startWord, endWord } objects — startWord/endWord are indices into word_timing array
function parseCaptionSegments(script, caption, contentAngle) {
  const src = (script || '').trim();

  // Strategy 1: Numbered list markers — handles both "1. tip" and "Number one: tip" formats
  if (src) {
    // First try word-form numbers: "Number one", "Number two", etc.
    const wordNumRegex = /(?=\b(?:number\s+(?:one|two|three|four|five|six)|tip\s+(?:one|two|three|four|five|six)|step\s+(?:one|two|three|four|five|six))\b)/i;
    const wordParts = src.split(wordNumRegex).map(p => p.trim()).filter(p => p.length > 0);
    const wordTips = wordParts
      .map(p => p.replace(/^(?:number|tip|step)\s+(?:one|two|three|four|five|six)[:\s]*/i, '').trim())
      .filter(t => t.length > 8);
    if (wordTips.length >= 2) {
      console.log(`[parseCaptions] Strategy 1a (word numbers): ${wordTips.length} segments`);
      return wordTips.slice(0, 6).map(t => ({
        text: sanitizeForDrawtext(t),
        words: t.split(/\s+/).length
      }));
    }
    // Then try numeric markers: "1. tip" or "2) tip"
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

  // Strategy 3: Sentence splitting — works for articles, prose, scraped content
  // Split on period/exclamation/question followed by space + capital letter
  const fullText = src || caption || contentAngle || '';
  if (fullText) {
    const rawSentences = fullText
      .replace(/([.!?])\s+/g, '$1\n')
      .split('\n')
      .map(s => s.replace(/^\d+[.)]+\s*/, '').replace(/[.!?]+$/, '').trim())
      .filter(s => s.length > 10);

    if (rawSentences.length >= 2) {
      // Group short sentences together (under 6 words) to avoid too-brief captions
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

// Build timed drawtext filters for cycling captions
// If wordTiming is provided (array of {word, start, end}), uses exact speech timestamps.
// Falls back to proportional word-count estimation if wordTiming is absent.
function buildCyclingCaptionFilters(segments, audioDuration, font, wordTiming) {
  if (segments.length === 0) return [];
  const filters = [];

  let segmentTimings;

  if (wordTiming && wordTiming.length > 0) {
    // ── Exact timing from ElevenLabs word-level timestamps ──────────────────
    console.log(`[captions] Using ElevenLabs word timing (${wordTiming.length} words)`);

    // Build a flat array of all words from all segments in order
    // Match each segment's words to the wordTiming array by position
    const allSegmentWords = segments.map(s => (s.rawText || s.text).split(/\s+/).filter(w => w.length > 0));
    const totalSegWords = allSegmentWords.reduce((sum, ws) => sum + ws.length, 0);

    // Map word timing indices to segments
    // wordTiming may have punctuation attached — we match by count, not by text
    let wordIdx = 0;
    segmentTimings = segments.map((seg, si) => {
      const segWordCount = allSegmentWords[si].length;
      const segStart = wordIdx < wordTiming.length ? (wordTiming[wordIdx].start || 0) : audioDuration * (wordIdx / totalSegWords);
      const endIdx = Math.min(wordIdx + segWordCount - 1, wordTiming.length - 1);
      const segEnd = endIdx >= 0 ? (wordTiming[endIdx].end || segStart + 1) : segStart + 1;
      wordIdx += segWordCount;
      return { startTime: segStart, endTime: segEnd };
    });

    // Extend last segment to full audio duration to avoid gap at end
    if (segmentTimings.length > 0) {
      segmentTimings[segmentTimings.length - 1].endTime = audioDuration;
    }

    console.log(`[captions] Segment timings:`);
    segmentTimings.forEach((t, i) => {
      console.log(`  [${i}] ${t.startTime.toFixed(2)}s → ${t.endTime.toFixed(2)}s: "${segments[i].text.substring(0, 40)}"`);
    });

  } else {
    // ── Fallback: proportional word-count estimation ─────────────────────────
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

  // Build drawtext filters from computed timings
  for (let i = 0; i < segments.length; i++) {
    const { startTime, endTime } = segmentTimings[i];

    const lines = wrapText(segments[i].text, 26);
    const line1 = (lines[0] || '').replace(/:/g, '\\:');
    const line2 = (lines[1] || '').replace(/:/g, '\\:');
    const line3 = (lines[2] || '').replace(/:/g, '\\:');

    if (line1) {
      filters.push(
        `drawtext=fontfile=${font}:text='${line1}':fontsize=46:fontcolor=white:` +
        `x=(w-text_w)/2:y=h-295:shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
        `enable='between(t,${startTime.toFixed(2)},${endTime.toFixed(2)})'`
      );
    }
    if (line2) {
      filters.push(
        `drawtext=fontfile=${font}:text='${line2}':fontsize=44:fontcolor=white@0.95:` +
        `x=(w-text_w)/2:y=h-240:shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
        `enable='between(t,${startTime.toFixed(2)},${endTime.toFixed(2)})'`
      );
    }
    if (line3) {
      filters.push(
        `drawtext=fontfile=${font}:text='${line3}':fontsize=42:fontcolor=white@0.90:` +
        `x=(w-text_w)/2:y=h-185:shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
        `enable='between(t,${startTime.toFixed(2)},${endTime.toFixed(2)})'`
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

  console.log(`[${jobId}] Starting assembly v2.3. dry_run=${dry_run}, query="${searchQuery}"`);

  // Dry run
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
  const logoPath = path.join(TEMP_DIR, `${jobId}_logo.png`);
  const finalPath = path.join(TEMP_DIR, `${jobId}_final.mp4`);
  const tempFiles = [audioPath, logoPath, finalPath];

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

    // Step 3: Get Pexels clips
    console.log(`[${jobId}] Fetching Pexels clips for: "${searchQuery}"...`);
    const pexelsClips = await getPexelsClips(searchQuery);
    console.log(`[${jobId}] Got ${pexelsClips.length} Pexels clips`);

    let baseVideoPath = null;

    if (pexelsClips.length > 0) {
      const numClips = Math.min(pexelsClips.length, 6);
      const clipDuration = Math.max(2.5, Math.min(4.0, audioDuration / numClips));
      const trimmedPaths = [];

      for (let i = 0; i < numClips; i++) {
        const rawPath = path.join(TEMP_DIR, `${jobId}_raw${i}.mp4`);
        const trimPath = path.join(TEMP_DIR, `${jobId}_trim${i}.mp4`);
        tempFiles.push(rawPath, trimPath);
        try {
          console.log(`[${jobId}] Downloading clip ${i+1}/${numClips}...`);
          await downloadFile(pexelsClips[i].url, rawPath);
          const trimCmd = [
            'ffmpeg -y',
            `-i "${rawPath}"`,
            `-t ${clipDuration.toFixed(2)}`,
            `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"`,
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
        // Repeat clips to cover full audio duration
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

    // Fallback: dark background
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

    // Step 4: Parse caption segments for cycling (works for tips lists AND article prose)
    const segments = parseCaptionSegments(scriptText, caption_text || firstItem.caption || '', content_angle);
    console.log(`[${jobId}] Parsed ${segments.length} caption segments for cycling`);

    // Step 5: Compose final video
    console.log(`[${jobId}] Composing final video with overlays...`);

    const logoExists = fs.existsSync(logoPath) && fs.statSync(logoPath).size > 1000;

    if (logoExists) {
      // Use logo as image overlay via filter_complex
      // Scale logo to 280px wide, place top-left with 30px padding, semi-transparent
      const cyclingFilters = buildCyclingCaptionFilters(segments, audioDuration, FONT_BOLD, word_timing);

      // Bottom bar for captions + CTA
      const staticFilters = [
        `eq=brightness=-0.06:contrast=1.05`,
        `drawbox=x=0:y=ih-340:w=iw:h=340:color=black@0.80:t=fill`,
        `drawtext=fontfile=${FONT_BOLD}:text='yfitai.com - Try free':fontsize=38:fontcolor=0x00ff88:x=(w-text_w)/2:y=h-72:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
      ];

      const allVfFilters = [...staticFilters, ...cyclingFilters].join(',');

      // filter_complex: scale logo, overlay on video, then apply drawtext filters
      const filterComplex = [
        `[1:v]scale=260:-1,format=rgba,colorchannelmixer=aa=0.88[logo]`,
        `[0:v]${allVfFilters}[base]`,
        `[base][logo]overlay=x=30:y=30[out]`
      ].join(';');

      const finalCmd = [
        'ffmpeg -y',
        `-i "${baseVideoPath}"`,
        `-i "${logoPath}"`,
        `-i "${audioPath}"`,
        `-filter_complex "${filterComplex}"`,
        `-map "[out]"`,
        `-map 2:a`,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k -af "loudnorm=I=-14:TP=-1.5:LRA=11"`,
        `-pix_fmt yuv420p`,
        `-shortest`,
        `-movflags +faststart`,
        `"${finalPath}"`
      ].join(' ');

      execSync(finalCmd, { timeout: 600000, shell: true });
    } else {
      // No logo - fallback to text-only branding
      console.log(`[${jobId}] Logo not available, using text branding`);
      const cyclingFilters = buildCyclingCaptionFilters(segments, audioDuration, FONT_BOLD, word_timing);
      const staticFilters = [
        `eq=brightness=-0.06:contrast=1.05`,
        `drawbox=x=0:y=ih-340:w=iw:h=340:color=black@0.80:t=fill`,
        `drawtext=fontfile=${FONT_BOLD}:text='YFIT AI':fontsize=72:fontcolor=0x00ff88:x=30:y=30:shadowcolor=black:shadowx=3:shadowy=3`,
        `drawtext=fontfile=${FONT_BOLD}:text='yfitai.com - Try free':fontsize=38:fontcolor=0x00ff88:x=(w-text_w)/2:y=h-72:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
      ];
      const vfFilter = [...staticFilters, ...cyclingFilters].join(',');
      const finalCmd = [
        'ffmpeg -y',
        `-i "${baseVideoPath}"`,
        `-i "${audioPath}"`,
        `-vf "${vfFilter}"`,
        `-c:v libx264 -preset fast -crf 22`,
        `-c:a aac -b:a 192k -af "loudnorm=I=-14:TP=-1.5:LRA=11"`,
        `-pix_fmt yuv420p`,
        `-shortest`,
        `-movflags +faststart`,
        `"${finalPath}"`
      ].join(' ');
      execSync(finalCmd, { timeout: 600000, shell: true });
    }

    const videoSize = fs.statSync(finalPath).size;
    console.log(`[${jobId}] Final video: ${videoSize} bytes`);

    // Step 6: Upload to Supabase
    const storagePath = `videos/${run_date}_${safeAngle}.mp4`;
    const videoUrl = await uploadToSupabase(finalPath, storagePath, 'video/mp4');
    console.log(`[${jobId}] Uploaded: ${videoUrl}`);

    // Cleanup
    tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });

    res.json({
      success: true, dry_run: false, job_id: jobId,
      video_url: videoUrl,
      video_size_bytes: videoSize,
      pexels_clips_used: pexelsClips.length,
      tips_count: segments.length,
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
  console.log(`YFIT Video Service v2.2 running on port ${PORT}`);
  console.log(`Pexels API: ${PEXELS_API_KEY ? 'configured' : 'NOT configured - set PEXELS_API_KEY'}`);
  console.log(`Logo URL: ${YFIT_LOGO_URL}`);
  try {
    console.log(`ffmpeg: ${execSync('ffmpeg -version 2>&1 | head -1').toString().trim()}`);
  } catch (e) {
    console.warn('WARNING: ffmpeg not found!');
  }
});
