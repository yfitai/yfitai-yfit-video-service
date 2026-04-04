const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mxggxpoxgqubojvumjlt.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_SECRET = process.env.API_SECRET || 'yfit-video-secret-2026';

// Temp directory for processing
const TEMP_DIR = '/tmp/yfit-videos';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Health check
app.get('/health', (req, res) => {
  let ffmpegVersion = 'not found';
  try {
    ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -1').toString().trim();
  } catch (e) {}
  res.json({ status: 'ok', ffmpeg: ffmpegVersion, timestamp: new Date().toISOString() });
});

// Download a file from URL to local path
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Follow redirect
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// Upload file to Supabase Storage
async function uploadToSupabase(localPath, storagePath, mimeType) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const fileBuffer = fs.readFileSync(localPath);
  
  const { data, error } = await supabase.storage
    .from('yfit-videos')
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: true,
      cacheControl: '3600'
    });
  
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  
  // Return public URL
  const encodedPath = storagePath.split('/').map(s => encodeURIComponent(s)).join('/');
  return `${SUPABASE_URL}/storage/v1/object/public/yfit-videos/${encodedPath}`;
}

// Main video assembly endpoint
app.post('/assemble', async (req, res) => {
  // Auth check
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    voiceover_url,
    run_date,
    content_angle,
    caption_text,
    video_items = [],
    text_items = [],
    dry_run = false
  } = req.body;

  if (!voiceover_url) {
    return res.status(400).json({ error: 'voiceover_url is required' });
  }

  const jobId = `${run_date || 'test'}_${Date.now()}`;
  const safeAngle = (content_angle || 'workout').replace(/[^a-z0-9\-]/gi, '_').substring(0, 60);
  
  console.log(`[${jobId}] Starting video assembly. dry_run=${dry_run}`);
  console.log(`[${jobId}] voiceover_url: ${voiceover_url}`);

  // In dry-run mode, skip actual ffmpeg processing but validate inputs
  if (dry_run) {
    console.log(`[${jobId}] DRY RUN - skipping actual video assembly`);
    return res.json({
      success: true,
      dry_run: true,
      job_id: jobId,
      message: 'Dry run: video assembly skipped',
      video_url: `https://example.com/dry-run-video-${jobId}.mp4`,
      platforms: video_items.map(v => v.platform),
      text_platforms: text_items.map(t => t.platform),
      voiceover_url,
      content_angle,
      run_date
    });
  }

  const audioPath = path.join(TEMP_DIR, `${jobId}_audio.mp3`);
  const imagePath = path.join(TEMP_DIR, `${jobId}_bg.jpg`);
  const videoPath = path.join(TEMP_DIR, `${jobId}_video.mp4`);

  try {
    // Step 1: Download the voiceover audio
    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(voiceover_url, audioPath);
    const audioSize = fs.statSync(audioPath).size;
    console.log(`[${jobId}] Audio downloaded: ${audioSize} bytes`);

    // Step 2: Create branded YFIT background image using ffmpeg's lavfi
    // This creates a 1080x1920 (9:16 vertical) branded background
    console.log(`[${jobId}] Creating branded background...`);
    
    // Use ffmpeg to create a branded gradient background with text overlay
    const safeCaption = (caption_text || content_angle || 'YFIT Fitness Tips')
      .replace(/['"\\]/g, ' ')
      .substring(0, 80);
    
    // Create the background image with ffmpeg drawtext
    const safeText = safeCaption.replace(/:/g, '\\:').replace(/'/g, "'\\''");
    const bgCommand = [
      'ffmpeg', '-y',
      '-f', 'lavfi',
      '-i', `color=c=0x0a0a1a:size=1080x1920:rate=1`,
      '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='YFIT AI':fontsize=80:fontcolor=0x00ff88:x=(w-text_w)/2:y=200:shadowcolor=black:shadowx=2:shadowy=2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='${safeText}':fontsize=42:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=10:shadowcolor=black:shadowx=1:shadowy=1`,
      '-frames:v', '1',
      imagePath
    ];
    const bgCommandStr = bgCommand.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');

    execSync(bgCommandStr, { timeout: 60000, shell: true });
    console.log(`[${jobId}] Background image created`);

    // Step 3: Assemble video - loop image for duration of audio, overlay audio
    console.log(`[${jobId}] Assembling video with ffmpeg...`);
    
    const ffmpegCommand = [
      'ffmpeg -y',
      `-loop 1 -i "${imagePath}"`,
      `-i "${audioPath}"`,
      '-c:v libx264 -tune stillimage -preset fast',
      '-c:a aac -b:a 192k',
      '-pix_fmt yuv420p',
      '-shortest',
      '-movflags +faststart',
      `"${videoPath}"`
    ].join(' ');

    execSync(ffmpegCommand, { timeout: 300000, shell: true });
    
    const videoSize = fs.statSync(videoPath).size;
    console.log(`[${jobId}] Video assembled: ${videoSize} bytes`);

    // Step 4: Upload video to Supabase Storage
    console.log(`[${jobId}] Uploading video to Supabase...`);
    const storagePath = `videos/${run_date}_${safeAngle}.mp4`;
    const videoUrl = await uploadToSupabase(videoPath, storagePath, 'video/mp4');
    console.log(`[${jobId}] Video uploaded: ${videoUrl}`);

    // Cleanup temp files
    [audioPath, imagePath, videoPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (e) {}
    });

    res.json({
      success: true,
      dry_run: false,
      job_id: jobId,
      video_url: videoUrl,
      video_size_bytes: videoSize,
      platforms: video_items.map(v => v.platform),
      text_platforms: text_items.map(t => t.platform),
      voiceover_url,
      content_angle,
      run_date
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    
    // Cleanup on error
    [audioPath, imagePath, videoPath].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });

    res.status(500).json({
      success: false,
      error: err.message,
      job_id: jobId
    });
  }
});

app.listen(PORT, () => {
  console.log(`YFIT Video Service running on port ${PORT}`);
  // Verify ffmpeg is available
  try {
    const v = execSync('ffmpeg -version 2>&1 | head -1').toString().trim();
    console.log(`ffmpeg: ${v}`);
  } catch (e) {
    console.warn('WARNING: ffmpeg not found! Run: apt-get install -y ffmpeg');
  }
});
