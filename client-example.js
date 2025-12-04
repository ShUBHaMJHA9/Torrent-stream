#!/usr/bin/env node

/**
 * Torrent Stream Client v2.0
 * Example client demonstrating all new features:
 * - Seek control (time-based and segment-based)
 * - Subtitle detection and retrieval
 * - Multi-language support
 * - Media information
 */

const http = require('http');

const SERVER = 'http://localhost:3000';

class TorrentStreamClient {
  constructor(baseUrl = SERVER) {
    this.baseUrl = baseUrl;
  }

  /**
   * Make HTTP request
   */
  async request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: data ? JSON.parse(data) : null
            });
          } catch (e) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: data
            });
          }
        });
      });

      req.on('error', reject);
      
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Create a new stream
   */
  async createStream(magnet) {
    console.log('🎬 Creating stream...');
    const res = await this.request('POST', '/stream', { magnet });
    
    if (res.status === 200) {
      console.log('✅ Stream created:', res.body.stream_id);
      return res.body;
    } else {
      throw new Error(`Failed to create stream: ${res.body.error}`);
    }
  }

  /**
   * Get stream status with all details
   */
  async getStatus(streamId) {
    const res = await this.request('GET', `/status/${streamId}`);
    
    if (res.status === 200) {
      return res.body;
    } else {
      throw new Error(`Failed to get status: ${res.body.error}`);
    }
  }

  /**
   * Wait for stream to be ready
   */
  async waitUntilReady(streamId, maxWait = 300000) {
    console.log('⏳ Waiting for stream to be ready...');
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < maxWait) {
      const status = await this.getStatus(streamId);
      
      if (status.ready) {
        console.log('✅ Stream ready!');
        console.log(`   Duration: ${status.mediaInfo?.durationFormatted || 'Unknown'}`);
        console.log(`   Subtitles: ${status.availableSubtitles?.length || 0} available`);
        return status;
      }

      if (status.error) {
        throw new Error(`Stream error: ${status.error}`);
      }

      console.log(`   Progress: ${status.progress?.toFixed(1) || 0}% | Peers: ${status.numPeers || 0} | Speed: ${(status.downloadSpeed / 1024 / 1024).toFixed(1)}MB/s`);
      
      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error('Stream initialization timeout');
  }

  /**
   * Get all available subtitles
   */
  async getSubtitles(streamId) {
    const res = await this.request('GET', `/subtitles-list/${streamId}`);
    
    if (res.status === 200) {
      console.log(`\n📝 Available Subtitles:`);
      
      if (res.body.available.length > 0) {
        console.log('\n  Detected in Torrent:');
        res.body.available.forEach(sub => {
          console.log(`    • ${sub.name} (${sub.language}) - ${(sub.size / 1024).toFixed(0)}KB`);
        });
      }

      if (res.body.extracted.length > 0) {
        console.log('\n  Extracted & Ready:');
        res.body.extracted.forEach(sub => {
          console.log(`    • ${sub.name} (${sub.language})`);
          console.log(`      URL: ${sub.url}`);
        });
      }

      console.log(`\n  Supported Languages: ${res.body.languageSupported.join(', ')}`);
      
      return res.body;
    } else {
      throw new Error(`Failed to get subtitles: ${res.body.error}`);
    }
  }

  /**
   * Download a specific subtitle
   */
  async downloadSubtitle(streamId, filename) {
    const res = await this.request('GET', `/subtitles/${streamId}/${encodeURIComponent(filename)}`);
    
    if (res.status === 200) {
      console.log(`✅ Downloaded: ${filename}`);
      return res.body;
    } else {
      throw new Error(`Failed to download subtitle: ${res.body.error}`);
    }
  }

  /**
   * Seek to specific time or segment
   */
  async seek(streamId, timeOrSegment) {
    let body;
    
    if (typeof timeOrSegment === 'object') {
      body = timeOrSegment;
    } else if (typeof timeOrSegment === 'number') {
      body = { time: timeOrSegment };
    } else {
      throw new Error('timeOrSegment must be a number (time in seconds) or object {time: or segment:}');
    }

    const res = await this.request('POST', `/seek/${streamId}`, body);
    
    if (res.status === 200) {
      const msg = res.body.playbackPositionFormatted || res.body.message;
      console.log(`⏩ Seeked to: ${msg}`);
      return res.body;
    } else {
      throw new Error(`Failed to seek: ${res.body.error}`);
    }
  }

  /**
   * Get seek information
   */
  async getSeekInfo(streamId) {
    const res = await this.request('GET', `/seek-info/${streamId}`);
    
    if (res.status === 200) {
      const info = res.body;
      console.log(`\n🎯 Seek Information:`);
      console.log(`   Current: ${info.currentTimeFormatted} (segment ${info.currentSegment})`);
      console.log(`   Duration: ${info.totalDurationFormatted} (${info.totalSegments} segments)`);
      console.log(`   Segment size: ${info.segmentDuration}s`);
      
      return info;
    } else {
      throw new Error(`Failed to get seek info: ${res.body.error}`);
    }
  }

  /**
   * Get server health
   */
  async getHealth() {
    const res = await this.request('GET', '/health');
    
    if (res.status === 200) {
      const health = res.body;
      console.log('\n💚 Server Health:');
      console.log(`   Status: ${health.status}`);
      console.log(`   Uptime: ${(health.uptime / 60).toFixed(1)}m`);
      console.log(`   FFmpeg: ${health.ffmpeg}`);
      console.log(`   FFprobe: ${health.ffprobe}`);
      console.log(`   Active Streams: ${health.activeStreams}`);
      console.log(`   Features: ${Object.keys(health.features).join(', ')}`);
      
      return health;
    } else {
      throw new Error(`Failed to get health: ${res.body.error}`);
    }
  }
}

// ============================================
// Demo/Test Functions
// ============================================

async function demo() {
  const client = new TorrentStreamClient();

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Torrent Stream Server v2.0 - Client Demo            ║');
  console.log('║   Features: Seek Control • Subtitles • Languages      ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  try {
    // 1. Check server health
    await client.getHealth();

    // 2. Create new stream
    const magnet = 'magnet:?xt=urn:btih:D52AFD211A20EBC00722E4226A673D4B555D00A2&dn=Thamma&tr=udp://tracker.opentrackr.org:1337/announce';
    
    const stream = await client.createStream(magnet);
    console.log(`   HLS: ${stream.hls_url}`);
    console.log(`   Direct: ${stream.mp4_url}`);

    // 3. Wait for stream to be ready
    const status = await client.waitUntilReady(stream.stream_id);

    // 4. Get available subtitles
    await client.getSubtitles(stream.stream_id);

    // 5. Demonstrate seeking
    console.log(`\n🎯 Testing Seek Control:`);
    await client.seek(stream.stream_id, 120); // Seek to 2 minutes
    await client.getSeekInfo(stream.stream_id);

    // 6. Seek to segment
    await client.seek(stream.stream_id, { segment: 50 });
    await client.getSeekInfo(stream.stream_id);

    console.log('\n✅ All features working!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run demo if executed directly
if (require.main === module) {
  demo().catch(console.error);
}

module.exports = TorrentStreamClient;
