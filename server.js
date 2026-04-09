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
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// Download file from URL
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
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

// Sanitize text for ffmpeg drawtext
function sanitizeForDrawtext(text) {
  return (text || '')
    .replace(/[^\w\s\-.,!?]/g, ' ')
    .replace(/'/g, '')
    .replace(/"/g, '')
    .replace(/:/g, ' -')
    .replace(/\\/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .trim();
}

// Word-wrap text into lines
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

// Main assembly endpoint
app.post('/assemble', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let {
    voiceover_url, run_date, content_angle, caption_text,
    video_items = [], text_items = [], dry_run = false, pexels_query
  } = req.body;

  if (typeof video_items === 'string') { try { video_items = JSON.parse(video_items); } catch(e) { video_items = []; } }
  if (typeof text_items === 'string') { try { text_items = JSON.parse(text_items); } catch(e) { text_items = []; } }
  if (typeof dry_run === 'string') { dry_run = dry_run === 'true'; }

  if (!voiceover_url) return res.status(400).json({ error: 'voiceover_url is required' });

  const jobId = `${run_date || 'test'}_${Date.now()}`;
  const safeAngle = (content_angle || 'workout').replace(/[^a-z0-9\-]/gi, '_').substring(0, 60);
  const searchQuery = pexels_query || content_angle || 'fitness workout';

  console.log(`[${jobId}] Starting assembly v2. dry_run=${dry_run}, query="${searchQuery}"`);

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
  const finalPath = path.join(TEMP_DIR, `${jobId}_final.mp4`);
  const tempFiles = [audioPath, finalPath];

  try {
    // Step 1: Download voiceover
    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(voiceover_url, audioPath);
    const audioDuration = getAudioDuration(audioPath);
    console.log(`[${jobId}] Audio duration: ${audioDuration}s`);

    // Step 2: Get Pexels clips
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

    // Step 3: Build caption overlay text
    const firstItem = video_items[0] || {};
    const rawCaption = sanitizeForDrawtext(
      caption_text ||
      (firstItem.caption || '').split('\n')[0] ||
      content_angle ||
      'YFIT AI Fitness Tips'
    ).substring(0, 120);

    const captionLines = wrapText(rawCaption, 26);
    const line1 = (captionLines[0] || '').replace(/:/g, '\\:');
    const line2 = (captionLines[1] || '').replace(/:/g, '\\:');
    const line3 = (captionLines[2] || '').replace(/:/g, '\\:');

    // Step 4: Compose final video
    console.log(`[${jobId}] Composing final video with overlays...`);

    const vfParts = [
      // Slight darkening for readability
      `eq=brightness=-0.06:contrast=1.05`,
      // Top gradient bar
      `drawbox=x=0:y=0:w=iw:h=230:color=black@0.78:t=fill`,
      // Bottom gradient bar
      `drawbox=x=0:y=ih-320:w=iw:h=320:color=black@0.82:t=fill`,
      // YFIT AI branding
      `drawtext=fontfile=${FONT_BOLD}:text='YFIT AI':fontsize=80:fontcolor=0x00ff88:x=(w-text_w)/2:y=72:shadowcolor=black:shadowx=3:shadowy=3`,
      `drawtext=fontfile=${FONT_REGULAR}:text='AI Fitness Coach':fontsize=36:fontcolor=white@0.85:x=(w-text_w)/2:y=168:shadowcolor=black:shadowx=1:shadowy=1`,
    ];

    if (line1) vfParts.push(`drawtext=fontfile=${FONT_BOLD}:text='${line1}':fontsize=54:fontcolor=white:x=(w-text_w)/2:y=h-278:shadowcolor=black:shadowx=2:shadowy=2`);
    if (line2) vfParts.push(`drawtext=fontfile=${FONT_REGULAR}:text='${line2}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=h-215:shadowcolor=black:shadowx=2:shadowy=2`);
    if (line3) vfParts.push(`drawtext=fontfile=${FONT_REGULAR}:text='${line3}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=h-158:shadowcolor=black:shadowx=2:shadowy=2`);

    // CTA
    vfParts.push(`drawtext=fontfile=${FONT_BOLD}:text='Try free at yfitai.com':fontsize=40:fontcolor=0x00ff88:x=(w-text_w)/2:y=h-82:shadowcolor=black:shadowx=2:shadowy=2`);

    const vfFilter = vfParts.join(',');
    const finalCmd = [
      'ffmpeg -y',
      `-i "${baseVideoPath}"`,
      `-i "${audioPath}"`,
      `-vf "${vfFilter}"`,
      `-c:v libx264 -preset fast -crf 22`,
      `-c:a aac -b:a 192k`,
      `-pix_fmt yuv420p`,
      `-shortest`,
      `-movflags +faststart`,
      `"${finalPath}"`
    ].join(' ');

    execSync(finalCmd, { timeout: 600000, shell: true });

    const videoSize = fs.statSync(finalPath).size;
    console.log(`[${jobId}] Final video: ${videoSize} bytes`);

    // Step 5: Upload to Supabase
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
  console.log(`YFIT Video Service v2.0 running on port ${PORT}`);
  console.log(`Pexels API: ${PEXELS_API_KEY ? 'configured' : 'NOT configured - set PEXELS_API_KEY'}`);
  try {
    console.log(`ffmpeg: ${execSync('ffmpeg -version 2>&1 | head -1').toString().trim()}`);
  } catch (e) {
    console.warn('WARNING: ffmpeg not found!');
  }
});
