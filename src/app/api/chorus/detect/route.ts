// Runs server/chorus/detect_chorus.py (downloads the video's audio via
// yt-dlp, then estimates chorus candidates with librosa). This only works on
// the LAN host machine, which is the only place OTO_ATE_HOST_MODE=1 is ever
// set (see server/host-server.ts) — on Vercel this route 404s immediately
// without touching the request body, so a missing python3/ffmpeg there is
// never even observable.
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { VIDEO_ID_PATTERN } from "@/lib/youtube";

export const runtime = "nodejs";

const PYTHON_SCRIPT = path.join(process.cwd(), "server", "chorus", "detect_chorus.py");
const CANDIDATE_COUNT = 3; // per product requirement: always exactly 3 candidates
const TIMEOUT_MS = 150_000;
const MIN_DURATION_SECONDS = 3;
const MAX_DURATION_SECONDS = 60;
const DEFAULT_DURATION_SECONDS = 15;

type PythonCandidate = {
  rank: number;
  start_seconds: number;
  end_seconds: number;
  score: number;
};

type ChorusApiCandidate = {
  id: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
};

function runPython(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, { timeout: TIMEOUT_MS });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("python3が見つかりません。Python3をインストールしてください。"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (/ModuleNotFoundError|No module named/.test(stderr)) {
        reject(
          new Error(
            "必要なPythonパッケージがインストールされていません。server/chorus/requirements.txtをpip installしてください。",
          ),
        );
        return;
      }
      reject(new Error(stderr.trim() || `解析スクリプトが終了コード${code}で失敗しました`));
    });
  });
}

export async function POST(request: NextRequest) {
  if (process.env.OTO_ATE_HOST_MODE !== "1") {
    return NextResponse.json(
      { error: "この機能はネイティブアプリ(LANホストモード)でのみ利用できます" },
      { status: 404 },
    );
  }

  const body = await request.json().catch(() => null);
  const videoId = typeof body?.videoId === "string" ? body.videoId : null;
  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
    return NextResponse.json({ error: "動画IDが不正です" }, { status: 400 });
  }

  const requestedDuration = typeof body?.duration === "number" ? body.duration : DEFAULT_DURATION_SECONDS;
  const duration = Math.min(
    Math.max(requestedDuration, MIN_DURATION_SECONDS),
    MAX_DURATION_SECONDS,
  );

  const outputDir = await mkdtemp(path.join(tmpdir(), "oto-ate-chorus-"));
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await runPython([
      PYTHON_SCRIPT,
      url,
      "--duration",
      String(duration),
      "--top",
      String(CANDIDATE_COUNT),
      "--output-dir",
      outputDir,
      "--no-preview",
    ]);

    const raw = await readFile(path.join(outputDir, "chorus_result.json"), "utf-8");
    const result = JSON.parse(raw) as { candidates?: PythonCandidate[] };

    const candidates: ChorusApiCandidate[] = (result.candidates ?? []).map((candidate) => ({
      id: String(candidate.rank),
      label: `候補${candidate.rank}`,
      startSeconds: candidate.start_seconds,
      endSeconds: candidate.end_seconds,
      confidence: candidate.score,
    }));

    return NextResponse.json({ candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : "サビの自動検出に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
