from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse

import librosa
import numpy as np
import yt_dlp


@dataclass(frozen=True)
class ChorusCandidate:
    rank: int
    start_seconds: float
    end_seconds: float
    center_seconds: float
    score: float
    start_time: str
    end_time: str


def format_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(int(minutes), 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:05.2f}"
    return f"{minutes:02d}:{seconds:05.2f}"


def validate_youtube_url(url: str) -> None:
    parsed = urlparse(url)
    host = parsed.netloc.lower().split(":")[0]
    valid_hosts = {
        "youtube.com",
        "www.youtube.com",
        "music.youtube.com",
        "m.youtube.com",
        "youtu.be",
    }
    if parsed.scheme not in {"http", "https"} or host not in valid_hosts:
        raise ValueError("YouTubeまたはYouTube MusicのURLを入力してください。")


def robust_normalize(values: np.ndarray, mask: np.ndarray) -> np.ndarray:
    target = values[mask]
    low = float(np.percentile(target, 5))
    high = float(np.percentile(target, 95))
    if high - low < 1e-10:
        return np.zeros_like(values, dtype=np.float32)
    return np.clip((values - low) / (high - low), 0.0, 1.0).astype(np.float32)


def moving_average(values: np.ndarray, window_size: int) -> np.ndarray:
    window_size = max(1, min(window_size, len(values)))
    kernel = np.ones(window_size, dtype=np.float32) / window_size
    return np.convolve(values, kernel, mode="valid")


def suppress_nearby_candidates(
    window_scores: np.ndarray,
    window_frames: int,
    top_n: int,
) -> list[int]:
    order = np.argsort(window_scores)[::-1]
    selected: list[int] = []
    minimum_distance = max(1, int(window_frames * 0.75))
    for index in order:
        index = int(index)
        if all(abs(index - chosen) >= minimum_distance for chosen in selected):
            selected.append(index)
        if len(selected) >= top_n:
            break
    return selected


def detect_chorus(
    audio_path: Path,
    chorus_duration: float,
    top_n: int,
    sample_rate: int = 22050,
) -> tuple[list[ChorusCandidate], float]:
    y, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    if duration < 8:
        raise ValueError("音源が短すぎます。8秒以上の音源を使用してください。")

    chorus_duration = min(chorus_duration, duration * 0.7)
    frame_length = 32768
    hop_length = 8192

    rms = librosa.feature.rms(
        y=y,
        frame_length=frame_length,
        hop_length=hop_length,
        center=True,
    )[0]

    centroid = librosa.feature.spectral_centroid(
        y=y,
        sr=sr,
        n_fft=frame_length,
        hop_length=hop_length,
        center=True,
    )[0]

    frame_count = min(len(rms), len(centroid))
    rms = rms[:frame_count]
    centroid = centroid[:frame_count]
    times = librosa.times_like(rms, sr=sr, hop_length=hop_length)

    ignore_seconds = min(max(duration * 0.06, 5.0), 20.0)
    analysis_mask = (times >= ignore_seconds) & (times <= duration - ignore_seconds)
    if not np.any(analysis_mask):
        analysis_mask = np.ones(frame_count, dtype=bool)

    rms_normalized = robust_normalize(rms, analysis_mask)
    centroid_normalized = robust_normalize(centroid, analysis_mask)

    local_smooth_frames = max(1, round(3.0 * sr / hop_length))
    rms_smooth = np.convolve(
        rms_normalized,
        np.ones(local_smooth_frames) / local_smooth_frames,
        mode="same",
    )
    centroid_smooth = np.convolve(
        centroid_normalized,
        np.ones(local_smooth_frames) / local_smooth_frames,
        mode="same",
    )

    chorus_likelihood = 0.72 * rms_smooth + 0.28 * centroid_smooth
    chorus_likelihood[~analysis_mask] = 0.0

    window_frames = max(1, round(chorus_duration * sr / hop_length))
    window_scores = moving_average(chorus_likelihood, window_frames)

    start_times = np.arange(len(window_scores), dtype=np.float64) * hop_length / sr
    valid_windows = (
        (start_times >= ignore_seconds)
        & (start_times + chorus_duration <= duration - ignore_seconds)
    )

    if np.any(valid_windows):
        window_scores = np.where(valid_windows, window_scores, -np.inf)

    finite_scores = window_scores[np.isfinite(window_scores)]
    if finite_scores.size == 0:
        raise RuntimeError("有効なサビ候補区間を計算できませんでした。")

    selected_indices = suppress_nearby_candidates(
        window_scores,
        window_frames,
        top_n,
    )

    best_score = float(np.max(finite_scores))
    worst_score = float(np.min(finite_scores))
    score_range = max(best_score - worst_score, 1e-10)

    candidates: list[ChorusCandidate] = []
    for rank, index in enumerate(selected_indices, start=1):
        start = float(start_times[index])
        end = min(duration, start + chorus_duration)
        relative_score = float((window_scores[index] - worst_score) / score_range)
        candidates.append(
            ChorusCandidate(
                rank=rank,
                start_seconds=round(start, 3),
                end_seconds=round(end, 3),
                center_seconds=round((start + end) / 2, 3),
                score=round(relative_score, 4),
                start_time=format_time(start),
                end_time=format_time(end),
            )
        )

    return candidates, duration


def download_audio(url: str, directory: Path) -> tuple[Path, dict]:
    output_template = str(directory / "source.%(ext)s")
    options = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "wav",
            }
        ],
    }

    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=True)

    audio_path = directory / "source.wav"
    if not audio_path.exists():
        wav_files = list(directory.glob("*.wav"))
        if not wav_files:
            raise FileNotFoundError("変換後のWAVファイルが見つかりませんでした。")
        audio_path = wav_files[0]

    return audio_path, info


def export_preview(
    audio_path: Path,
    output_path: Path,
    start_seconds: float,
    duration: float,
) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start_seconds:.3f}",
        "-i",
        str(audio_path),
        "-t",
        f"{duration:.3f}",
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(output_path),
    ]
    subprocess.run(command, check=True)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="YouTube音源からRMSとスペクトル重心を使ってサビ候補を推定します。"
    )
    parser.add_argument("url", nargs="?", help="YouTubeまたはYouTube MusicのURL")
    parser.add_argument(
        "--duration",
        type=float,
        default=30.0,
        help="推定するサビ区間の長さ。既定値は30秒",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=3,
        help="表示する候補数。既定値は3",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("chorus_output"),
        help="結果の保存先",
    )
    parser.add_argument(
        "--no-preview",
        action="store_true",
        help="1位候補のプレビューMP3を作成しない",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    url = args.url or input("YouTube URL: ").strip()

    if args.duration <= 0:
        print("エラー: --durationは0より大きくしてください。", file=sys.stderr)
        return 1

    if not 1 <= args.top <= 10:
        print("エラー: --topは1〜10にしてください。", file=sys.stderr)
        return 1

    try:
        validate_youtube_url(url)
    except ValueError as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 1

    if shutil.which("ffmpeg") is None:
        print("エラー: FFmpegが見つかりません。先にFFmpegをインストールしてください。", file=sys.stderr)
        return 1

    args.output_dir.mkdir(parents=True, exist_ok=True)

    try:
        with tempfile.TemporaryDirectory(prefix="chorus_detector_") as temp_name:
            temp_dir = Path(temp_name)
            print("音源を取得しています...")
            audio_path, info = download_audio(url, temp_dir)

            print("サビ候補を解析しています...")
            candidates, track_duration = detect_chorus(
                audio_path=audio_path,
                chorus_duration=args.duration,
                top_n=args.top,
            )

            result = {
                "title": info.get("title"),
                "video_id": info.get("id"),
                "webpage_url": info.get("webpage_url", url),
                "track_duration_seconds": round(track_duration, 3),
                "method": "RMS 72% + spectral centroid 28%, sustained-window scoring",
                "requested_chorus_duration_seconds": args.duration,
                "candidates": [asdict(candidate) for candidate in candidates],
            }

            json_path = args.output_dir / "chorus_result.json"
            json_path.write_text(
                json.dumps(result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            preview_path = args.output_dir / "chorus_preview.mp3"
            if not args.no_preview and candidates:
                first = candidates[0]
                export_preview(
                    audio_path=audio_path,
                    output_path=preview_path,
                    start_seconds=first.start_seconds,
                    duration=first.end_seconds - first.start_seconds,
                )

        print()
        print(f"曲名: {result['title']}")
        print(f"曲の長さ: {format_time(track_duration)}")
        print()
        for candidate in candidates:
            print(
                f"候補{candidate.rank}: "
                f"{candidate.start_time} ～ {candidate.end_time} "
                f"(スコア {candidate.score:.4f})"
            )

        print()
        print(f"解析結果: {json_path}")
        if not args.no_preview:
            print(f"1位候補プレビュー: {preview_path}")
        return 0

    except yt_dlp.utils.DownloadError as error:
        print(f"YouTube音源の取得に失敗しました: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError:
        print("FFmpegによるプレビュー作成に失敗しました。", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"解析に失敗しました: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
