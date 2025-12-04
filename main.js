import express from "express";
import WebTorrent from "webtorrent";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { spawn, spawnSync } from "child_process";

const app = express();
app.use(cors());
app.use(express.json());

const client = new WebTorrent();
const streams = {}; // store active sessions: { [id]: { folder, torrent, file, ready, error } }

// Global error handlers
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled rejection at:', promise, 'reason:', reason));

client.on('error', (err) => console.error('webtorrent client error:', err));

// Check ffmpeg availability early
let ffmpegAvailable = true;
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

// Helper: Process a torrent (shared for new or existing)
function processTorrent(torrent, streamId, outputFolder) {
    try {
        console.log(`[${streamId}] torrent metadata ready: ${torrent.infoHash} - ${torrent.name} (${torrent.files.length} files)`);
        
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

        const filePath = path.join(outputFolder, file.name);

        // Start file save stream (for later direct access via /stream/:id)
        const saveStream = file.createReadStream();
        const writeStream = fs.createWriteStream(filePath);
        
        saveStream.on('error', (err) => {
            console.error(`[${streamId}] save stream error:`, err.message);
        });
        
        writeStream.on('error', (err) => {
            console.error(`[${streamId}] write stream error:`, err.message);
        });
        
        saveStream.pipe(writeStream);

        // Create separate read stream for ffmpeg
        const ffInStream = file.createReadStream();

        // Start ffmpeg HLS conversion
        const proc = ffmpeg(ffInStream)
            .output(path.join(outputFolder, 'playlist.m3u8'))
            .addOptions([
                '-profile:v baseline',
                '-level 3.0',
                '-start_number 0',
                '-hls_time 4',
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
                        }
                        clearInterval(poll);
                    }
                }
            } catch (e) {
                // Ignore transient file system errors
            }
        }, 1000);

        // Store stream metadata
        streams[streamId].torrent = torrent;
        streams[streamId].file = file;
        streams[streamId].filePath = filePath;
        streams[streamId].poll = poll;
        streams[streamId].saveStream = saveStream;
        streams[streamId].writeStream = writeStream;

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

            // Convert to HLS
            const proc = ffmpeg(videoPath)
                .output(path.join(outputFolder, 'playlist.m3u8'))
                .addOptions([
                    '-profile:v baseline',
                    '-level 3.0',
                    '-start_number 0',
                    '-hls_time 4',
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
                            }
                            clearInterval(poll);
                        }
                    }
                } catch (e) {
                    // Ignore transient errors
                }
            }, 1000);

            if (streams[streamId]) streams[streamId].poll = poll;
        });

        res.json({
            stream_id: streamId,
            hls_url: `/hls/${streamId}/playlist.m3u8`,
            status_url: `/status/${streamId}`
        });

    } catch (e) {
        console.error('POST /stream-yt exception:', e.message);
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
        activeStreams: Object.keys(streams).length
    });
});

// ---------------------------
// Start server
// ---------------------------
const serverPort = process.env.PORT || 3000;
const server = app.listen(serverPort, () => {
    console.log(`\n🎬 Torrent Stream Server running on http://localhost:${serverPort}`);
    console.log(`   Health: http://localhost:${serverPort}/health`);
    console.log(`   API Docs: POST /stream or POST /stream-yt, then GET /status/:id\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
