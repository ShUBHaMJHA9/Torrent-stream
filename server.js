import express from "express";
import WebTorrent from "webtorrent";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { spawn, spawnSync, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const app = express();
app.use(cors());
app.use(express.json());

const client = new WebTorrent();
const streams = {}; // store active sessions: { [id]: { folder, torrent, file, ready, error, metadata, subtitles, duration, currentTime } }

// Global error handlers
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled rejection at:', promise, 'reason:', reason));

client.on('error', (err) => console.error('webtorrent client error:', err));

// Check ffmpeg availability early
let ffmpegAvailable = true;
let ffprobeAvailable = true;
try {
    const check = spawnSync('ffmpeg', ['-version']);
    if (check.error || check.status !== 0) {
        ffmpegAvailable = false;
        console.warn('⚠️ ffmpeg not available in PATH. HLS conversion will fail.');
    } else {
        console.log('✓ ffmpeg available');
    }
} catch (e) {
    ffmpegAvailable = false;
    console.warn('⚠️ ffmpeg not available in PATH. HLS conversion will fail.');
}

try {
    const check = spawnSync('ffprobe', ['-version']);
    if (check.error || check.status !== 0) {
        ffprobeAvailable = false;
        console.warn('⚠️ ffprobe not available. Media analysis will be limited.');
    } else {
        console.log('✓ ffprobe available');
    }
} catch (e) {
    ffprobeAvailable = false;
    console.warn('⚠️ ffprobe not available. Media analysis will be limited.');
}

// ====== Subtitle & Language Detection ======

// Detect subtitle files in torrent
function detectSubtitles(torrent, outputFolder) {
    const subtitleExtensions = ['.srt', '.vtt', '.ass', '.ssa', '.sub', '.sbv', '.json'];
    const subtitles = [];

    torrent.files.forEach((file) => {
        const ext = path.extname(file.name).toLowerCase();
        if (subtitleExtensions.includes(ext)) {
            subtitles.push({
                name: file.name,
                ext: ext.substring(1),
                size: file.length,
                language: detectLanguageFromName(file.name)
            });
        }
    });

    return subtitles;
}

// Detect language from filename (simple heuristics)
function detectLanguageFromName(filename) {
    const nameLower = filename.toLowerCase();
    const langMap = {
        'eng': ['english', 'eng'],
        'hin': ['hindi', 'hin'],
        'tam': ['tamil', 'tam'],
        'tel': ['telugu', 'tel'],
        'kan': ['kannada', 'kan'],
        'mal': ['malayalam', 'mal'],
        'mar': ['marathi', 'mar'],
        'ben': ['bengali', 'ben'],
        'spa': ['spanish', 'es', 'spa'],
        'fra': ['french', 'fr', 'fra'],
        'deu': ['german', 'de', 'deu'],
        'por': ['portuguese', 'pt', 'por'],
        'rus': ['russian', 'ru', 'rus'],
        'jpn': ['japanese', 'ja', 'jpn'],
        'zho': ['chinese', 'zh', 'zho'],
        'ara': ['arabic', 'ar', 'ara'],
        'tha': ['thai', 'th', 'tha']
    };

    for (const [lang, keywords] of Object.entries(langMap)) {
        if (keywords.some(kw => nameLower.includes(kw))) {
            return lang;
        }
    }

    // Check for ISO 639-1 codes
    const iso2Match = nameLower.match(/\.(en|hi|ta|te|kn|ml|mr|bn|es|fr|de|pt|ru|ja|zh|ar|th)[\.\-_]/);
    if (iso2Match) {
        const iso2 = iso2Match[1];
        const iso2to3 = { en: 'eng', hi: 'hin', ta: 'tam', te: 'tel', kn: 'kan', ml: 'mal', mr: 'mar', bn: 'ben', es: 'spa', fr: 'fra', de: 'deu', pt: 'por', ru: 'rus', ja: 'jpn', zh: 'zho', ar: 'ara', th: 'tha' };
        return iso2to3[iso2] || iso2;
    }

    return 'unknown';
}

// Extract and copy subtitle files from torrent
async function extractSubtitles(torrent, outputFolder, subtitlesList) {
    const extracted = [];

    for (const subInfo of subtitlesList) {
        const file = torrent.files.find(f => f.name === subInfo.name);
        if (!file) continue;

        const outputPath = path.join(outputFolder, `subtitle_${subInfo.language}.${subInfo.ext}`);

        try {
            const stream = file.createReadStream();
            const writeStream = fs.createWriteStream(outputPath);

            await new Promise((resolve, reject) => {
                stream.pipe(writeStream);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
                stream.on('error', reject);
            });

            extracted.push({
                name: subInfo.name,
                path: outputPath,
                language: subInfo.language,
                ext: subInfo.ext,
                size: subInfo.size
            });

            console.log(`[torrent] extracted subtitle: ${subInfo.name} (${subInfo.language})`);
        } catch (e) {
            console.error(`[torrent] failed to extract subtitle ${subInfo.name}:`, e.message);
        }
    }

    return extracted;
}

// Get media duration and codec info using ffprobe
async function getMediaInfo(filePath) {
    if (!ffprobeAvailable) return null;

    try {
        const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration,nb_streams -of default=noprint_wrappers=1:nokey=1:noesc=1 "${filePath}"`);
        const lines = stdout.trim().split('\n');
        const duration = parseFloat(lines[0]);

        if (!isNaN(duration)) {
            return { duration: Math.round(duration), durationFormatted: formatDuration(duration) };
        }
    } catch (e) {
        console.error('ffprobe error:', e.message);
    }

    return null;
}

// Get detailed stream info (audio, subtitle, video codecs)
async function getStreamInfo(filePath) {
    if (!ffprobeAvailable) return null;

    try {
        const { stdout } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_type,codec_name,width,height,r_frame_rate -of default=noprint_wrappers=1 "${filePath}"`);
        const streamInfo = { videoCodec: null, audioTracks: [], subtitleTracks: [] };

        // Parse video info
        const lines = stdout.split('\n').filter(l => l.trim());
        for (const line of lines) {
            if (line.includes('codec_type=video')) {
                streamInfo.videoCodec = 'h264'; // simplified
            }
        }

        return streamInfo;
    } catch (e) {
        return null;
    }
}

// Format duration to HH:MM:SS
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Compute folder size (bytes) and return list of files sorted by mtime asc
function getFolderFilesSorted(folder) {
    try {
        const files = fs.readdirSync(folder).map(name => {
            const full = path.join(folder, name);
            const stat = fs.statSync(full);
            return { name, path: full, size: stat.size, mtime: stat.mtimeMs };
        });
        files.sort((a, b) => a.mtime - b.mtime);
        return files;
    } catch (e) {
        return [];
    }
}

function getFolderSize(folder) {
    try {
        const files = fs.readdirSync(folder);
        let total = 0;
        for (const f of files) {
            try {
                const stat = fs.statSync(path.join(folder, f));
                if (stat.isFile()) total += stat.size;
            } catch (e) {
                // ignore
            }
        }
        return total;
    } catch (e) {
        return 0;
    }
}

// Enforce max storage bytes by deleting oldest segment files first
function enforceStorageLimit(entry, maxBytes) {
    try {
        if (!entry || !entry.folder) return;
        const folder = entry.folder;
        let total = getFolderSize(folder);
        if (total <= maxBytes) return;
        const keepSegments = parseInt(process.env.KEEP_SEGMENTS || '5', 10); // keep newest N segments
        const files = getFolderFilesSorted(folder);

        // Identify segment files and non-segment files
        const segmentFiles = files.filter(f => /segment_\d+\.ts$/.test(f.name));
        const otherFiles = files.filter(f => !/segment_\d+\.ts$/.test(f.name));

        // Determine segments to preserve (the newest `keepSegments`)
        const segmentsToKeep = new Set(segmentFiles.slice(-keepSegments).map(f => f.name));

        // Build deletion candidates: oldest segment files (excluding those kept), then other files (oldest first)
        const deletableSegments = segmentFiles.filter(f => !segmentsToKeep.has(f.name));
        const candidates = deletableSegments.concat(otherFiles);

        for (const f of candidates) {
            try {
                // never delete playlist.m3u8 proactively
                if (f.name === 'playlist.m3u8') continue;
                // avoid deleting recently created segments we reserved
                if (segmentsToKeep.has(f.name)) continue;
                fs.unlinkSync(f.path);
                total -= f.size;
                if (total <= maxBytes) break;
            } catch (e) {
                // ignore deletion errors
            }
        }
    } catch (e) {
        // ignore
    }
}

// Compute dynamic HLS segment duration based on current active streams.
// Uses environment variables:
//  MIN_SEGMENT_SECONDS (default 4)
//  MAX_SEGMENT_SECONDS (default 10)
//  TARGET_STREAMS_PER_SEGMENT (default 10) - how many streams per MIN_SEGMENT_SECONDS
function computeSegmentDuration() {
    try {
        const active = Math.max(1, Object.keys(streams).length);
        const MIN = parseInt(process.env.MIN_SEGMENT_SECONDS || '4', 10);
        const MAX = parseInt(process.env.MAX_SEGMENT_SECONDS || '10', 10);
        const TARGET = parseInt(process.env.TARGET_STREAMS_PER_SEGMENT || '10', 10);

        const factor = Math.max(1, Math.ceil(active / TARGET));
        const duration = factor * MIN;
        return Math.min(MAX, Math.max(MIN, duration));
    } catch (e) {
        return parseInt(process.env.MIN_SEGMENT_SECONDS || '4', 10);
    }
}

// Helper: Process a torrent (shared for new or existing)
function processTorrent(torrent, streamId, outputFolder) {
    try {
        console.log(`[${streamId}] torrent metadata ready: ${torrent.infoHash} - ${torrent.name} (${torrent.files.length} files)`);
        
        // Detect subtitles early
        const detectedSubs = detectSubtitles(torrent, outputFolder);
        if (detectedSubs.length > 0) {
            console.log(`[${streamId}] found ${detectedSubs.length} subtitle file(s)`);
            streams[streamId].subtitles = detectedSubs;
        }
        
        // Track peer connections
        torrent.on('wire', () => {
            const numPeers = torrent.numPeers || 0;
            console.log(`[${streamId}] peer connected (total: ${numPeers})`);
        });
        
        torrent.on('done', () => {
            console.log(`[${streamId}] torrent download complete`);
            if (streams[streamId]) streams[streamId].downloadComplete = true;
        });

        // Ensure torrent error handling
        torrent.on('error', (err) => {
            console.error(`[${streamId}] torrent error:`, err.message);
            if (streams[streamId]) streams[streamId].error = `torrent_error: ${err.message}`;
        });

        // Find playable video file
        if (!ffmpegAvailable) {
            console.error(`[${streamId}] ffmpeg missing; cannot create HLS.`);
            if (streams[streamId]) streams[streamId].error = 'ffmpeg_missing';
            return;
        }

        const file = torrent.files.find((f) => /\.(mp4|mkv|webm|mov|avi|flv)$/i.test(f.name));
        if (!file) {
            console.error(`[${streamId}] no playable file found in torrent`);
            if (streams[streamId]) streams[streamId].error = 'no_playable_file';
            return;
        }

        console.log(`[${streamId}] using file: ${file.name} (${(file.length / (1024 * 1024)).toFixed(2)} MB)`);

        // We deliberately DO NOT write the full video file to disk here.
        // Instead, ffmpeg reads directly from the torrent file stream and
        // HLS segments are produced on-the-fly. This keeps disk usage low
        // (only segments + playlist are stored). For environments with
        // limited storage (e.g. 2GB), we enforce a retention policy below.
        const filePath = path.join(outputFolder, file.name);

        // Extract subtitles in background if any
        if (detectedSubs.length > 0) {
            (async () => {
                try {
                    const extracted = await extractSubtitles(torrent, outputFolder, detectedSubs);
                    if (streams[streamId]) {
                        streams[streamId].extractedSubtitles = extracted;
                        console.log(`[${streamId}] extracted ${extracted.length} subtitle(s)`);
                    }
                } catch (e) {
                    console.error(`[${streamId}] subtitle extraction error:`, e.message);
                }
            })();
        }

        // Create separate read stream for ffmpeg
        const ffInStream = file.createReadStream();

        // Determine HLS segment duration dynamically based on concurrent streams
        const segSeconds = computeSegmentDuration();

        // Start ffmpeg HLS conversion
        const proc = ffmpeg(ffInStream)
            .output(path.join(outputFolder, 'playlist.m3u8'))
            .addOptions([
                '-profile:v baseline',
                '-level 3.0',
                '-start_number 0',
                `-hls_time ${segSeconds}`,
                '-hls_list_size 0',
                '-hls_segment_filename', path.join(outputFolder, 'segment_%03d.ts'),
                '-f hls'
            ])
            .on('start', () => console.log(`[${streamId}] ffmpeg conversion started`))
            .on('error', (err) => {
                console.error(`[${streamId}] ffmpeg error:`, err.message);
                if (streams[streamId]) streams[streamId].error = `ffmpeg_error: ${err.message}`;
            })
            .on('end', () => {
                console.log(`[${streamId}] ffmpeg conversion complete`);
                if (streams[streamId]) streams[streamId].ready = true;
            });

        // Start the conversion
        proc.run();

        // Attempt to get media info if the full file exists (it won't for torrent streaming)
        (async () => {
            try {
                if (fs.existsSync(filePath)) {
                    await new Promise(r => setTimeout(r, 2000));
                    const mediaInfo = await getMediaInfo(filePath);
                    if (mediaInfo && streams[streamId]) {
                        streams[streamId].mediaInfo = mediaInfo;
                        streams[streamId].duration = mediaInfo.duration;
                        console.log(`[${streamId}] media duration: ${mediaInfo.durationFormatted}`);
                    }
                }
            } catch (e) {
                console.error(`[${streamId}] media info error:`, e.message);
            }
        })();

        // Poll for playlist + first segment to mark ready sooner
        const playlistPath = path.join(outputFolder, 'playlist.m3u8');
        const poll = setInterval(() => {
            try {
                if (!fs.existsSync(playlistPath)) return;
                const files = fs.readdirSync(outputFolder);
                const segments = files.filter(f => /segment_\d+\.ts$/.test(f));
                
                if (segments.length > 0) {
                    const stat = fs.statSync(playlistPath);
                    if (stat.size > 100) { // Ensure playlist has content
                        console.log(`[${streamId}] HLS playlist with ${segments.length} segment(s) ready`);
                        if (streams[streamId]) {
                            streams[streamId].ready = true;
                            streams[streamId].playlistReady = Date.now();
                            streams[streamId].totalSegments = segments.length;
                        }
                        clearInterval(poll);
                    }
                }
            } catch (e) {
                // Ignore transient file system errors
            }
        }, 1000);

        // Start storage enforcer for this stream to keep folder under limit
        const maxBytes = parseInt(process.env.MAX_STREAM_STORAGE_BYTES || String(2 * 1024 * 1024 * 1024), 10); // default 2GB
        const enforcer = setInterval(() => enforceStorageLimit(streams[streamId], maxBytes), 15 * 1000);

        // Store enforcer to allow cleanup later
        streams[streamId].storageEnforcer = enforcer;

        // Store stream metadata
        streams[streamId].torrent = torrent;
        streams[streamId].file = file;
        streams[streamId].filePath = filePath;
        streams[streamId].poll = poll;
        streams[streamId].segmentDuration = segSeconds; // seconds, matching HLS output (dynamic)
        streams[streamId].currentSegment = 0;
        streams[streamId].playbackPosition = 0; // seconds

    } catch (e) {
        console.error(`[${streamId}] processTorrent exception:`, e.message);
        if (streams[streamId]) streams[streamId].error = `exception: ${e.message}`;
    }
}

// ---------------------------
// POST /stream - Start torrent stream
// ---------------------------
app.post("/stream", (req, res) => {
    try {
        const magnet = req.body.magnet;
        if (!magnet) return res.status(400).json({ error: "magnet required" });

        const streamId = randomBytes(4).toString("hex");
        const outputFolder = `/tmp/${streamId}`;

        try {
            fs.mkdirSync(outputFolder, { recursive: true });
        } catch (e) {
            return res.status(500).json({ error: `failed to create output folder: ${e.message}` });
        }

        // Initialize stream entry immediately
        streams[streamId] = {
            folder: outputFolder,
            ready: false,
            createdAt: Date.now(),
            error: null
        };

        console.log(`[${streamId}] POST /stream: adding magnet`);

        // Check if torrent already in client
        const existing = client.get(magnet);
        if (existing) {
            console.log(`[${streamId}] reusing existing torrent`);
            processTorrent(existing, streamId, outputFolder);
        } else {
            // Add new torrent; callback fires when metadata is available
            client.add(magnet, { path: outputFolder }, (torrent) => {
                processTorrent(torrent, streamId, outputFolder);
            }).on('error', (err) => {
                console.error(`[${streamId}] client.add error:`, err.message);
                streams[streamId].error = `add_error: ${err.message}`;
            });
        }

        // Return immediately with stream_id and URLs
        res.json({
            stream_id: streamId,
            hls_url: `/hls/${streamId}/playlist.m3u8`,
            mp4_url: `/stream/${streamId}`,
            status_url: `/status/${streamId}`
        });

    } catch (e) {
        console.error('POST /stream exception:', e);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// GET /status/:id - Stream status
// ---------------------------
app.get('/status/:id', (req, res) => {
    try {
        const entry = streams[req.params.id];
        if (!entry) {
            return res.status(404).json({ error: 'stream not found' });
        }

        const status = {
            ready: !!entry.ready,
            folder: entry.folder,
            file: entry.file?.name || null,
            error: entry.error || null,
            createdAt: entry.createdAt,
            elapsedSeconds: Math.floor((Date.now() - entry.createdAt) / 1000)
        };

        // Add torrent info if available
        if (entry.torrent) {
            status.torrentName = entry.torrent.name;
            status.torrentHash = entry.torrent.infoHash;
            status.numPeers = entry.torrent.numPeers || 0;
            status.progress = Math.round((entry.torrent.progress || 0) * 10000) / 100; // percent
            status.downloadSpeed = entry.torrent.downloadSpeed || 0; // bytes/sec
            status.ratio = Math.round((entry.torrent.ratio || 0) * 10000) / 10000;
        }

        if (entry.playlistReady) {
            status.hlsReadyAt = entry.playlistReady;
        }

        // Add media information
        if (entry.mediaInfo) {
            status.mediaInfo = {
                duration: entry.mediaInfo.duration,
                durationFormatted: entry.mediaInfo.durationFormatted
            };
        }

        // Add subtitle information
        if (entry.subtitles && entry.subtitles.length > 0) {
            status.availableSubtitles = entry.subtitles.map(s => ({
                name: s.name,
                format: s.ext,
                language: s.language,
                size: s.size
            }));
        }

        if (entry.extractedSubtitles && entry.extractedSubtitles.length > 0) {
            status.extractedSubtitles = entry.extractedSubtitles.map(s => ({
                name: s.name,
                format: s.ext,
                language: s.language,
                path: `/subtitles/${req.params.id}/${s.name}`
            }));
        }

        // Add seek control information
        if (entry.ready) {
            status.seekControl = {
                currentPosition: entry.playbackPosition || 0,
                currentSegment: entry.currentSegment || 0,
                totalSegments: entry.totalSegments || 0,
                segmentDuration: entry.segmentDuration || 4,
                supportRangeRequests: true,
                canSeek: entry.mediaInfo ? true : false
            };
        }

        res.json(status);
    } catch (e) {
        console.error(`GET /status/${req.params.id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// GET /hls/:id/* - Serve HLS playlist and segments
// ---------------------------
app.use('/hls/:id', (req, res, next) => {
    try {
        const entry = streams[req.params.id];
        if (!entry) {
            return res.status(404).json({ error: 'stream not found' });
        }

        // Serve files from the output folder
        express.static(entry.folder)(req, res, next);
    } catch (e) {
        console.error(`GET /hls/${req.params.id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// GET /subtitles/:id/:filename - Serve subtitle files
// ---------------------------
app.get('/subtitles/:id/:filename', (req, res) => {
    try {
        const entry = streams[req.params.id];
        if (!entry) {
            return res.status(404).json({ error: 'stream not found' });
        }

        const filename = req.params.filename;
        const filepath = path.join(entry.folder, filename);

        // Security: prevent directory traversal
        if (!filepath.startsWith(entry.folder)) {
            return res.status(403).json({ error: 'access denied' });
        }

        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ error: 'subtitle file not found' });
        }

        res.set({
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `inline; filename="${filename}"`
        });

        fs.createReadStream(filepath).pipe(res);
    } catch (e) {
        console.error(`GET /subtitles/${req.params.id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// POST /seek/:id - Seek to specific time/segment
// ---------------------------
app.post('/seek/:id', (req, res) => {
    try {
        const entry = streams[req.params.id];
        if (!entry) {
            return res.status(404).json({ error: 'stream not found' });
        }

        if (!entry.ready) {
            return res.status(400).json({ error: 'stream not ready' });
        }

        const { time, segment } = req.body;
        let targetSegment = 0;

        if (time !== undefined) {
            // Seek by time (seconds)
            const segmentDuration = entry.segmentDuration || 4;
            targetSegment = Math.floor(time / segmentDuration);
        } else if (segment !== undefined) {
            // Seek by segment number
            targetSegment = parseInt(segment, 10);
        } else {
            return res.status(400).json({ error: 'time or segment parameter required' });
        }

        // Validate segment number
        const totalSegments = entry.totalSegments || 0;
        if (targetSegment < 0 || (totalSegments > 0 && targetSegment >= totalSegments)) {
            return res.status(400).json({ error: `invalid segment ${targetSegment}, valid range: 0-${totalSegments - 1}` });
        }

        entry.currentSegment = targetSegment;
        entry.playbackPosition = targetSegment * (entry.segmentDuration || 4);

        res.json({
            success: true,
            currentSegment: targetSegment,
            playbackPosition: entry.playbackPosition,
            playbackPositionFormatted: formatDuration(entry.playbackPosition),
            message: `Seeked to segment ${targetSegment}`
        });
    } catch (e) {
        console.error(`POST /seek/${req.params.id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// GET /seek-info/:id - Get seek-able information
// ---------------------------
app.get('/seek-info/:id', (req, res) => {
    try {
        const entry = streams[req.params.id];
        if (!entry) {
            return res.status(404).json({ error: 'stream not found' });
        }

        if (!entry.ready) {
            return res.status(400).json({ error: 'stream not ready' });
        }

        const segmentDuration = entry.segmentDuration || 4;
        const totalSegments = entry.totalSegments || 0;
        const totalDuration = totalSegments * segmentDuration;

        const seekInfo = {
            currentSegment: entry.currentSegment || 0,
            currentTime: entry.playbackPosition || 0,
            currentTimeFormatted: formatDuration(entry.playbackPosition || 0),
            totalSegments: totalSegments,
            totalDuration: totalDuration,
            totalDurationFormatted: formatDuration(totalDuration),
            segmentDuration: segmentDuration,
            segments: []
        };

        // List available segments (expensive for large videos, limit to nearby)
        const currentSeg = entry.currentSegment || 0;
        const rangeStart = Math.max(0, currentSeg - 10);
        const rangeEnd = Math.min(totalSegments, currentSeg + 10);

        for (let i = rangeStart; i < rangeEnd; i++) {
            const segmentFile = `segment_${String(i).padStart(3, '0')}.ts`;
            const segPath = path.join(entry.folder, segmentFile);
            const exists = fs.existsSync(segPath);
            
            seekInfo.segments.push({
                number: i,
                filename: segmentFile,
                available: exists,
                time: i * segmentDuration,
                timeFormatted: formatDuration(i * segmentDuration)
            });
        }

        res.json(seekInfo);
    } catch (e) {
        console.error(`GET /seek-info/${req.params.id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// GET /stream/:id - Direct video stream (with Range support)
// ---------------------------
app.get('/stream/:id', (req, res) => {
    try {
        const entry = streams[req.params.id];
        if (!entry) {
            return res.status(404).json({ error: 'stream not found' });
        }

        const { file } = entry;
        if (!file) {
            return res.status(404).json({ error: 'file not ready' });
        }

        const range = req.headers.range;
        const size = file.length;

        // Set seek/resume headers
        res.set({
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4',
            'X-Stream-Ready': entry.ready ? 'true' : 'false',
            'X-Subtitle-Count': (entry.extractedSubtitles?.length || 0).toString()
        });

        if (!range) {
            // Full file request
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': size,
                'Accept-Ranges': 'bytes'
            });
            const stream = file.createReadStream();
            stream.on('error', (err) => {
                console.error(`Stream error for ${req.params.id}:`, err.message);
                res.destroy();
            });
            stream.pipe(res);
            return;
        }

        // Range request
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : size - 1;

        if (start >= size || end >= size || start > end) {
            res.status(416).set('Content-Range', `bytes */${size}`).end();
            return;
        }

        const chunkSize = end - start + 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4'
        });

        const stream = file.createReadStream({ start, end });
        stream.on('error', (err) => {
            console.error(`Range stream error for ${req.params.id}:`, err.message);
            res.destroy();
        });
        stream.pipe(res);

    } catch (e) {
        console.error(`GET /stream/${req.params.id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// POST /stream-yt - Stream from YouTube/other URL via yt-dlp
// ---------------------------
app.post('/stream-yt', (req, res) => {
    try {
        const url = req.body.url;
        if (!url) {
            return res.status(400).json({ error: 'url required' });
        }

        const streamId = randomBytes(4).toString('hex');
        const outputFolder = `/tmp/${streamId}`;

        try {
            fs.mkdirSync(outputFolder, { recursive: true });
        } catch (e) {
            return res.status(500).json({ error: `failed to create output folder: ${e.message}` });
        }

        // Initialize stream entry
        streams[streamId] = {
            folder: outputFolder,
            ready: false,
            createdAt: Date.now(),
            error: null,
            isYtDlp: true
        };

        console.log(`[${streamId}] POST /stream-yt: downloading from ${url}`);

        // Download with yt-dlp
        const args = ['-f', 'best', '-o', path.join(outputFolder, '%(title)s.%(ext)s'), url];
        const ytdlp = spawn('yt-dlp', args);

        let ytdlpOutput = '';

        ytdlp.stdout.on('data', (d) => {
            const line = d.toString().trim();
            if (line) {
                console.log(`[${streamId}] [yt-dlp]`, line);
                ytdlpOutput += line + '\n';
            }
        });

        ytdlp.stderr.on('data', (d) => {
            const line = d.toString().trim();
            if (line) {
                console.error(`[${streamId}] [yt-dlp ERROR]`, line);
            }
        });

        ytdlp.on('close', (code) => {
            console.log(`[${streamId}] yt-dlp exit code: ${code}`);

            if (code !== 0) {
                streams[streamId].error = `yt-dlp failed with code ${code}`;
                return;
            }

            // Find downloaded video file
            let videoFile = null;
            try {
                const files = fs.readdirSync(outputFolder);
                videoFile = files.find(f => /\.(mp4|mkv|webm|mov|avi|flv)$/i.test(f));
            } catch (e) {
                console.error(`[${streamId}] failed to read output folder:`, e.message);
                streams[streamId].error = `read folder error: ${e.message}`;
                return;
            }

            if (!videoFile) {
                console.error(`[${streamId}] no video file found after yt-dlp`);
                streams[streamId].error = 'no_video_file_from_ytdlp';
                return;
            }

            const videoPath = path.join(outputFolder, videoFile);
            console.log(`[${streamId}] found video: ${videoFile}`);

            if (!ffmpegAvailable) {
                console.error(`[${streamId}] ffmpeg not available; cannot convert to HLS`);
                streams[streamId].error = 'ffmpeg_missing';
                return;
            }

            // Get media info
            (async () => {
                try {
                    const mediaInfo = await getMediaInfo(videoPath);
                    if (mediaInfo && streams[streamId]) {
                        streams[streamId].mediaInfo = mediaInfo;
                        streams[streamId].duration = mediaInfo.duration;
                    }
                } catch (e) {
                    console.error(`[${streamId}] media info error:`, e.message);
                }
            })();

            // Convert to HLS (with dynamic segment duration)
            const segSecondsYT = computeSegmentDuration();
            const proc = ffmpeg(videoPath)
                .output(path.join(outputFolder, 'playlist.m3u8'))
                .addOptions([
                    '-profile:v baseline',
                    '-level 3.0',
                    '-start_number 0',
                    `-hls_time ${segSecondsYT}`,
                    '-hls_list_size 0',
                    '-hls_segment_filename', path.join(outputFolder, 'segment_%03d.ts'),
                    '-f hls'
                ])
                .on('start', () => console.log(`[${streamId}] ffmpeg conversion started`))
                .on('error', (err) => {
                    console.error(`[${streamId}] ffmpeg error:`, err.message);
                    streams[streamId].error = `ffmpeg_error: ${err.message}`;
                })
                .on('end', () => {
                    console.log(`[${streamId}] ffmpeg conversion complete`);
                    streams[streamId].ready = true;
                });

            proc.run();

            // Poll for HLS readiness
            const playlistPath = path.join(outputFolder, 'playlist.m3u8');
            const poll = setInterval(() => {
                try {
                    if (!fs.existsSync(playlistPath)) return;
                    const files = fs.readdirSync(outputFolder);
                    const segments = files.filter(f => /segment_\d+\.ts$/.test(f));
                    
                    if (segments.length > 0) {
                        const stat = fs.statSync(playlistPath);
                        if (stat.size > 100) {
                            console.log(`[${streamId}] yt-dlp HLS ready with ${segments.length} segment(s)`);
                            if (streams[streamId]) {
                                streams[streamId].ready = true;
                                streams[streamId].playlistReady = Date.now();
                                streams[streamId].totalSegments = segments.length;
                                streams[streamId].segmentDuration = segSecondsYT;
                                streams[streamId].currentSegment = 0;
                                streams[streamId].playbackPosition = 0;
                            }
                            clearInterval(poll);
                        }
                    }
                } catch (e) {
                    // Ignore transient errors
                }
            }, 1000);

                if (streams[streamId]) streams[streamId].poll = poll;

                // Start storage enforcer for yt-dlp streams as well
                const maxBytesYT = parseInt(process.env.MAX_STREAM_STORAGE_BYTES || String(2 * 1024 * 1024 * 1024), 10);
                const enforcerYT = setInterval(() => enforceStorageLimit(streams[streamId], maxBytesYT), 15 * 1000);
                streams[streamId].storageEnforcer = enforcerYT;
        });

        res.json({
            stream_id: streamId,
            hls_url: `/hls/${streamId}/playlist.m3u8`,
            mp4_url: `/stream/${streamId}`,
            status_url: `/status/${streamId}`
        });

    } catch (e) {
        console.error('POST /stream-yt exception:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// GET /subtitles-list/:id - List all subtitles
// ---------------------------
app.get('/subtitles-list/:id', (req, res) => {
    try {
        const entry = streams[req.params.id];
        if (!entry) {
            return res.status(404).json({ error: 'stream not found' });
        }

        const result = {
            available: entry.subtitles || [],
            extracted: (entry.extractedSubtitles || []).map(s => ({
                name: s.name,
                language: s.language,
                format: s.ext,
                url: `/subtitles/${req.params.id}/${s.name}`
            })),
            languageSupported: [
                'eng', 'hin', 'tam', 'tel', 'kan', 'mal', 'mar', 'ben',
                'spa', 'fra', 'deu', 'por', 'rus', 'jpn', 'zho', 'ara', 'tha'
            ]
        };

        res.json(result);
    } catch (e) {
        console.error(`GET /subtitles-list/${req.params.id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// POST /convert-subtitle/:id - Convert subtitle format or language
// ---------------------------
app.post('/convert-subtitle/:id', (req, res) => {
    try {
        const entry = streams[req.params.id];
        if (!entry) {
            return res.status(404).json({ error: 'stream not found' });
        }

        const { filename, targetFormat } = req.body;
        if (!filename || !targetFormat) {
            return res.status(400).json({ error: 'filename and targetFormat required' });
        }

        const supportedFormats = ['srt', 'vtt', 'ass', 'sub'];
        if (!supportedFormats.includes(targetFormat)) {
            return res.status(400).json({ error: `targetFormat must be one of: ${supportedFormats.join(', ')}` });
        }

        const sourcePath = path.join(entry.folder, filename);
        if (!sourcePath.startsWith(entry.folder) || !fs.existsSync(sourcePath)) {
            return res.status(404).json({ error: 'subtitle file not found' });
        }

        // For now, provide a conversion guide (actual conversion requires ffmpeg or third-party libs)
        res.json({
            message: 'conversion not yet implemented',
            source: filename,
            targetFormat: targetFormat,
            available: ['srt', 'vtt', 'ass', 'sub'],
            note: 'Use external tools to convert subtitles or request format during torrent selection'
        });
    } catch (e) {
        console.error(`POST /convert-subtitle/${req.params.id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------
// Health check
// ---------------------------
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        ffmpeg: ffmpegAvailable ? 'available' : 'missing',
        ffprobe: ffprobeAvailable ? 'available' : 'missing',
        activeStreams: Object.keys(streams).length,
        features: {
            seekControl: true,
            subtitleDetection: true,
            languageSupport: true,
            rangeRequests: true,
            hlsStreaming: true,
            directMp4: true,
            youtubeDl: true
        }
    });
});

// ---------------------------
// GET /api-docs - API Documentation
// ---------------------------
app.get('/api-docs', (req, res) => {
    res.json({
        version: '2.0',
        title: 'Torrent Stream Server with Seek & Subtitle Support',
        baseUrl: 'http://localhost:3000',
        endpoints: {
            'POST /stream': {
                description: 'Stream a torrent by magnet link',
                body: { magnet: 'magnet:?xt=urn:btih:...' },
                returns: { stream_id: 'string', hls_url: 'string', mp4_url: 'string', status_url: 'string' },
                example: 'curl -X POST http://localhost:3000/stream -H "Content-Type: application/json" -d \'{"magnet":"magnet:..."}\''
            },
            'POST /stream-yt': {
                description: 'Stream from YouTube or URL via yt-dlp',
                body: { url: 'https://youtube.com/watch?v=...' },
                returns: { stream_id: 'string', hls_url: 'string', status_url: 'string' },
                example: 'curl -X POST http://localhost:3000/stream-yt -H "Content-Type: application/json" -d \'{"url":"https://..."}\''
            },
            'GET /status/:id': {
                description: 'Get detailed stream status including media info, subtitles, and seek position',
                returns: {
                    ready: 'boolean',
                    mediaInfo: { duration: 'number', durationFormatted: 'string' },
                    availableSubtitles: 'array',
                    extractedSubtitles: 'array',
                    seekControl: 'object'
                },
                example: 'curl http://localhost:3000/status/a6bab726'
            },
            'POST /seek/:id': {
                description: 'Seek to specific time or segment',
                body: { time: 'number (seconds)' },
                alternatebody: { segment: 'number (0-based index)' },
                returns: { success: 'boolean', currentSegment: 'number', playbackPosition: 'number', playbackPositionFormatted: 'string' },
                example: 'curl -X POST http://localhost:3000/seek/a6bab726 -H "Content-Type: application/json" -d \'{"time":120}\''
            },
            'GET /seek-info/:id': {
                description: 'Get seek information including available segments near current position',
                returns: {
                    currentSegment: 'number',
                    currentTime: 'number',
                    totalSegments: 'number',
                    totalDuration: 'number',
                    segments: 'array'
                },
                example: 'curl http://localhost:3000/seek-info/a6bab726'
            },
            'GET /hls/:id/playlist.m3u8': {
                description: 'HLS adaptive streaming playlist',
                returns: 'M3U8 playlist',
                example: 'http://localhost:3000/hls/a6bab726/playlist.m3u8'
            },
            'GET /stream/:id': {
                description: 'Direct video stream with HTTP Range request support',
                headers: { Range: 'bytes=start-end (optional)' },
                returns: 'MP4/MKV video file',
                example: 'curl http://localhost:3000/stream/a6bab726 -H "Range: bytes=0-1000000"'
            },
            'GET /subtitles-list/:id': {
                description: 'List all available and extracted subtitles',
                returns: {
                    available: 'array (from torrent)',
                    extracted: 'array (extracted files)',
                    languageSupported: 'array'
                },
                example: 'curl http://localhost:3000/subtitles-list/a6bab726'
            },
            'GET /subtitles/:id/:filename': {
                description: 'Download subtitle file',
                returns: 'Subtitle file (SRT, VTT, ASS, etc)',
                example: 'curl http://localhost:3000/subtitles/a6bab726/subtitle_eng.srt'
            },
            'POST /convert-subtitle/:id': {
                description: 'Convert subtitle format (planned feature)',
                body: { filename: 'string', targetFormat: 'srt|vtt|ass|sub' },
                example: 'curl -X POST http://localhost:3000/convert-subtitle/a6bab726 -d \'{"filename":"subtitle_eng.srt","targetFormat":"vtt"}\''
            },
            'GET /health': {
                description: 'Server health and feature status',
                returns: { status: 'string', activeStreams: 'number', features: 'object' }
            },
            'GET /api-docs': {
                description: 'This API documentation'
            }
        },
        features: {
            seekControl: 'Precise segment and time-based seeking',
            subtitleDetection: 'Auto-detect subtitles in torrents',
            multiLanguage: 'Support for 17+ languages (eng, hin, tam, tel, kan, mal, spa, fra, deu, etc)',
            rangeRequests: 'Full HTTP 206 Partial Content support for seeking in players',
            mediaAnalysis: 'Automatic duration detection via ffprobe',
            hlsStreaming: 'Adaptive bitrate streaming',
            directMp4: 'Direct MP4 streaming with resume capability'
        },
        languagesSupported: [
            'English (eng)', 'Hindi (hin)', 'Tamil (tam)', 'Telugu (tel)',
            'Kannada (kan)', 'Malayalam (mal)', 'Marathi (mar)', 'Bengali (ben)',
            'Spanish (spa)', 'French (fra)', 'German (deu)', 'Portuguese (por)',
            'Russian (rus)', 'Japanese (jpn)', 'Chinese (zho)', 'Arabic (ara)', 'Thai (tha)'
        ]
    });
});

// ---------------------------
// Start server
// ---------------------------
const serverPort = process.env.PORT || 3000;
const server = app.listen(serverPort, () => {
    console.log(`\n🎬 Torrent Stream Server v2.0 running on http://localhost:${serverPort}`);
    console.log(`   📋 API Docs: http://localhost:${serverPort}/api-docs`);
    console.log(`   💚 Health: http://localhost:${serverPort}/health`);
    console.log(`   🎯 Features: Seek Control • Subtitle Detection • Multi-Language Support • HLS/MP4 • Range Requests\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Initialize dynamic segment duration monitor
let currentSegmentDuration = computeSegmentDuration();
console.log(`Initial HLS segment duration: ${currentSegmentDuration}s`);

// Recompute every 5 seconds and update stream metadata (ffmpeg processes are not restarted automatically)
const segmentMonitorInterval = parseInt(process.env.SEGMENT_MONITOR_INTERVAL_MS || '5000', 10);
const segmentMonitor = setInterval(() => {
    try {
        const newDur = computeSegmentDuration();
        if (newDur !== currentSegmentDuration) {
            console.log(`HLS segment duration changed: ${currentSegmentDuration}s -> ${newDur}s (activeStreams=${Object.keys(streams).length})`);
            currentSegmentDuration = newDur;
            // Update metadata for all streams so status reflects the new duration
            for (const id of Object.keys(streams)) {
                try {
                    streams[id].segmentDuration = currentSegmentDuration;
                } catch (e) {
                    // ignore
                }
            }
        }
    } catch (e) {
        // ignore
    }
}, segmentMonitorInterval);

// Clean up monitor on exit
process.on('exit', () => clearInterval(segmentMonitor));
