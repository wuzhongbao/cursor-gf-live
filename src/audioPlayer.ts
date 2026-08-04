import { execFile, spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface PlayAudioOptions {
  /** Fires when audible playback actually begins (not when PowerShell starts). */
  onStarted?: (durationMs: number) => void;
}

let winWorker: ChildProcessWithoutNullStreams | undefined;
let winWorkerReady: Promise<void> | undefined;
let winPlayChain: Promise<void> = Promise.resolve();
let winSeq = 0;

/**
 * Play an audio file from the extension host (avoids webview autoplay blocks).
 */
export async function playAudioFileHost(
  filePath: string,
  opts: PlayAudioOptions = {}
): Promise<void> {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`audio missing: ${filePath}`);
  }

  const platform = os.platform();
  if (platform === 'win32') {
    await playWindowsFast(filePath, opts);
    return;
  }
  if (platform === 'darwin') {
    const durationMs = probeMp3DurationMs(filePath) ?? 0;
    opts.onStarted?.(durationMs || 3000);
    await execFileAsync('afplay', [filePath], { timeout: 120000 });
    return;
  }

  const players = [
    ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath]],
    ['mpg123', ['-q', filePath]],
    ['paplay', [filePath]],
  ] as const;
  for (const [bin, args] of players) {
    try {
      const durationMs = probeMp3DurationMs(filePath) ?? 0;
      opts.onStarted?.(durationMs || 3000);
      await execFileAsync(bin, [...args], { timeout: 120000 });
      return;
    } catch {
      // try next
    }
  }
  throw new Error('no audio player available');
}

/** Prefetch the Windows MediaPlayer worker so the first speak is not cold. */
export function warmAudioPlayerHost(): void {
  if (os.platform() !== 'win32') {
    return;
  }
  void ensureWinWorker().catch((err) => {
    console.warn(
      '[GF Live] audio worker warm failed:',
      err instanceof Error ? err.message : String(err)
    );
  });
}

/** Stop current host playback (best-effort). */
export function stopAudioPlayerHost(): void {
  if (os.platform() === 'win32' && winWorker?.stdin.writable) {
    try {
      winWorker.stdin.write('STOP\n');
    } catch {
      // ignore
    }
  }
}

/** Tear down persistent worker on extension deactivate. */
export function disposeAudioPlayerHost(): void {
  if (!winWorker) {
    return;
  }
  try {
    winWorker.stdin.write('QUIT\n');
  } catch {
    // ignore
  }
  try {
    winWorker.kill();
  } catch {
    // ignore
  }
  winWorker = undefined;
  winWorkerReady = undefined;
}

/** Edge TTS uses 96kbps CBR MP3 — size gives a solid duration estimate. */
export function probeMp3DurationMs(filePath: string): number | undefined {
  try {
    const size = fs.statSync(filePath).size;
    if (size < 256) {
      return undefined;
    }
    const ms = Math.round(((size - 128) * 8) / 96);
    return Math.max(600, Math.min(180000, ms));
  } catch {
    return undefined;
  }
}

async function playWindowsFast(
  filePath: string,
  opts: PlayAudioOptions
): Promise<void> {
  const abs = path.resolve(filePath);
  const probed = probeMp3DurationMs(abs) ?? 8000;

  // Prefer warm MediaPlayer worker (avoids 10s+ WMPlayer COM cold starts).
  try {
    await ensureWinWorker();
    await enqueueWinPlay(abs, probed, opts);
    return;
  } catch (err1) {
    console.warn(
      '[GF Live] warm player failed, one-shot fallback:',
      err1 instanceof Error ? err1.message : String(err1)
    );
    disposeAudioPlayerHost();
  }

  // One-shot MediaPlayer (still much faster than WMPlayer).
  await playWindowsMediaPlayerOnce(abs, opts, probed);
}

function enqueueWinPlay(
  absPath: string,
  fallbackMs: number,
  opts: PlayAudioOptions
): Promise<void> {
  const run = winPlayChain.then(() => playOnWinWorker(absPath, fallbackMs, opts));
  winPlayChain = run.catch(() => undefined);
  return run;
}

async function playOnWinWorker(
  absPath: string,
  fallbackMs: number,
  opts: PlayAudioOptions
): Promise<void> {
  const worker = winWorker;
  if (!worker || !worker.stdin.writable) {
    throw new Error('audio worker not running');
  }

  const id = ++winSeq;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let started = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('audio worker play timed out'));
    }, 180000);

    const onData = (buf: Buffer) => {
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line) {
          continue;
        }
        if (line.startsWith(`STARTED ${id} `)) {
          started = true;
          const ms = Number(line.slice(`STARTED ${id} `.length)) || fallbackMs;
          opts.onStarted?.(ms);
        } else if (line === `ENDED ${id}` || line.startsWith(`ERROR ${id} `)) {
          cleanup();
          if (line.startsWith(`ERROR ${id} `)) {
            reject(new Error(line.slice(`ERROR ${id} `.length)));
          } else {
            if (!started) {
              opts.onStarted?.(fallbackMs);
            }
            resolve();
          }
        }
      }
    };

    const onExit = () => {
      cleanup();
      reject(new Error('audio worker exited during play'));
    };

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      worker.stdout.off('data', onData);
      worker.off('exit', onExit);
    };

    worker.stdout.on('data', onData);
    worker.on('exit', onExit);

    // STOP leftover audio, then PLAY with Node-probed duration (skip NaturalDuration wait).
    try {
      worker.stdin.write(`STOP\nPLAY ${id} ${fallbackMs} ${absPath}\n`);
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function ensureWinWorker(): Promise<void> {
  if (winWorker && !winWorker.killed) {
    return winWorkerReady;
  }
  winWorkerReady = startWinWorker();
  return winWorkerReady;
}

async function startWinWorker(): Promise<void> {
  const scriptPath = path.join(
    os.tmpdir(),
    `gf-live-audio-worker-${process.pid}.ps1`
  );
  fs.writeFileSync(scriptPath, `\uFEFF${WIN_WORKER_SCRIPT}`, {
    encoding: 'utf16le',
  });

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  winWorker = child as ChildProcessWithoutNullStreams;

  child.stderr.on('data', (buf: Buffer) => {
    const msg = buf.toString('utf8').trim();
    if (msg) {
      console.warn('[GF Live] audio worker:', msg.slice(0, 300));
    }
  });

  child.on('exit', () => {
    winWorker = undefined;
    winWorkerReady = undefined;
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // ignore
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('audio worker ready timeout'));
    }, 12000);

    const onData = (buf: Buffer) => {
      if (buf.toString('utf8').includes('READY')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`audio worker exited before ready (${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
    try {
      child.stdin.write('PING\n');
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

const WIN_WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Volume = 1.0
$player.Balance = 0
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {}
Write-Output 'READY'
[Console]::Out.Flush()

function Stop-Player {
  try { $player.Stop() } catch {}
  try { $player.Close() } catch {}
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'QUIT') { break }
  if ($line -eq 'PING') {
    Write-Output 'READY'
    [Console]::Out.Flush()
    continue
  }
  if ($line -eq 'STOP') {
    Stop-Player
    Write-Output 'STOPPED'
    [Console]::Out.Flush()
    continue
  }
  if ($line.StartsWith('PLAY ')) {
    # PLAY <id> <durationMs> <path...>
    $rest = $line.Substring(5).Trim()
    $p1 = $rest.IndexOf(' ')
    if ($p1 -lt 1) {
      Write-Output 'ERROR 0 bad play command'
      [Console]::Out.Flush()
      continue
    }
    $id = $rest.Substring(0, $p1)
    $rest2 = $rest.Substring($p1 + 1).Trim()
    $p2 = $rest2.IndexOf(' ')
    if ($p2 -lt 1) {
      Write-Output ("ERROR $id bad play command")
      [Console]::Out.Flush()
      continue
    }
    $ms = 0
    [int]::TryParse($rest2.Substring(0, $p2), [ref]$ms) | Out-Null
    if ($ms -le 0) { $ms = 3000 }
    $path = $rest2.Substring($p2 + 1).Trim()
    try {
      if (-not (Test-Path -LiteralPath $path)) { throw "missing $path" }
      Stop-Player
      $uri = [Uri]((New-Object System.IO.FileInfo $path).FullName)
      $player.Open($uri)
      # Do not wait for NaturalDuration — Node already probed MP3 length.
      Start-Sleep -Milliseconds 12
      $player.Play()
      Write-Output ("STARTED $id $ms")
      [Console]::Out.Flush()
      Start-Sleep -Milliseconds ($ms + 120)
      Stop-Player
      Write-Output ("ENDED $id")
      [Console]::Out.Flush()
    } catch {
      Stop-Player
      $msg = ($_ | Out-String).Trim()
      if ($msg.Length -gt 180) { $msg = $msg.Substring(0, 180) }
      Write-Output ("ERROR $id $msg")
      [Console]::Out.Flush()
    }
    continue
  }
}

Stop-Player
`;

async function playWindowsMediaPlayerOnce(
  absPath: string,
  opts: PlayAudioOptions,
  probedMs?: number
): Promise<void> {
  const signal = path.join(os.tmpdir(), `gf-live-started-${Date.now()}.txt`);
  const fallback = probedMs && probedMs > 0 ? probedMs : 8000;
  const uri =
    'file:///' +
    absPath
      .replace(/\\/g, '/')
      .replace(/ /g, '%20')
      .replace(/#/g, '%23');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$signal = '${signal.replace(/'/g, "''")}'
$player = New-Object System.Windows.Media.MediaPlayer
$player.Volume = 1.0
$player.Open([Uri]'${uri.replace(/'/g, "''")}')
$sw = [Diagnostics.Stopwatch]::StartNew()
do { Start-Sleep -Milliseconds 15 } while (-not $player.NaturalDuration.HasTimeSpan -and $sw.Elapsed.TotalSeconds -lt 6)
if (-not $player.NaturalDuration.HasTimeSpan) { throw 'MediaPlayer open failed' }
$player.Play()
$ms = [math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds)
if ($ms -le 0) { $ms = ${fallback} }
Set-Content -LiteralPath $signal -Value ([string]$ms) -Encoding ascii
Start-Sleep -Milliseconds ($ms + 200)
$player.Stop()
$player.Close()
`;
  const tmp = path.join(os.tmpdir(), `gf-live-play-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, `\uFEFF${script}`, { encoding: 'utf16le' });
  try {
    fs.unlinkSync(signal);
  } catch {
    // ignore
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        tmp,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let started = false;
    let stderr = '';
    const poll = setInterval(() => {
      if (started) {
        return;
      }
      try {
        if (fs.existsSync(signal)) {
          const raw = fs.readFileSync(signal, 'utf8').trim();
          started = true;
          opts.onStarted?.(Number(raw) || fallback);
        }
      } catch {
        // ignore
      }
    }, 30);
    const timeout = setTimeout(() => {
      clearInterval(poll);
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error('oneshot playback timed out'));
    }, 180000);
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      clearInterval(poll);
      clearTimeout(timeout);
      if (!started) {
        opts.onStarted?.(fallback);
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(signal);
      } catch {
        // ignore
      }
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `oneshot exit ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`
          )
        );
      }
    });
  });
}
