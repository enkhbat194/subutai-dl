import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { spawn } from 'node:child_process';

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${basename(executable)} exited with ${code}\n${stderr}`));
    });
  });
}

const ffmpeg = process.env.SUBUTAI_FFMPEG_PATH || 'ffmpeg';
const ytDlp = process.env.SUBUTAI_YTDLP_PATH || 'yt-dlp';
const root = await mkdtemp(join(tmpdir(), 'subutai-media-'));
const sourceDir = join(root, 'source');
const outputDir = join(root, 'output');
await Promise.all([
  mkdir(sourceDir, { recursive: true }),
  mkdir(outputDir, { recursive: true }),
]);

let server;
try {
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100',
    '-t', '3', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
    join(sourceDir, 'sample.m3u8'),
  ]);

  server = createServer((request, response) => {
    try {
      const requested = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
      const file = join(sourceDir, requested.replace(/^\/+/, ''));
      const extension = extname(file);
      response.setHeader('content-type', extension === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      createReadStream(file).on('error', () => {
        if (!response.headersSent) response.statusCode = 404;
        response.end();
      }).pipe(response);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local media server did not start.');

  const downloadArgs = ['--no-warnings', '--no-playlist'];
  if (ffmpeg !== basename(ffmpeg) || existsSync(ffmpeg)) {
    downloadArgs.push('--ffmpeg-location', dirname(ffmpeg));
  }
  downloadArgs.push(
    '--merge-output-format', 'mp4',
    '--output', join(outputDir, 'subutai-media.%(ext)s'),
    `http://127.0.0.1:${address.port}/sample.m3u8`,
  );
  await run(ytDlp, downloadArgs);

  const outputs = (await readdir(outputDir)).filter((name) => !name.endsWith('.part'));
  if (outputs.length === 0) throw new Error('Media smoke test produced no output file.');
  const outputPath = join(outputDir, outputs[0]);
  const info = await stat(outputPath);
  if (info.size < 10_000) throw new Error(`Media output is unexpectedly small: ${info.size} bytes.`);
  const playlist = await readFile(join(sourceDir, 'sample.m3u8'), 'utf8');
  if (!playlist.includes('#EXTM3U')) throw new Error('Generated HLS playlist is invalid.');
  console.log(`Subutai media smoke test passed: ${outputs[0]} (${info.size} bytes).`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
