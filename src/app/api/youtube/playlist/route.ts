import { NextRequest, NextResponse } from "next/server";
import type { PlaylistImportItem, PlaylistImportResult } from "@/lib/youtubePlaylistImport";

// Let the function run long enough to page through large playlists (ignored
// on plans that don't support it, which just fall back to their own cap).
// Raised alongside SAFETY_MAX_ITEMS: up to 3000 items means up to 60
// sequential playlistItems.list pages, which can take longer than 60s.
export const maxDuration = 120;

const API_KEY = process.env.YOUTUBE_API_KEY;

// Not a user-facing "your playlist got cut" limit — normal curated playlists
// never get near this. It exists purely so a YouTube Music "radio"/mix
// playlist (auto-generated, effectively bottomless) can't paginate forever
// and hang the request indefinitely.
const SAFETY_MAX_ITEMS = 3000;

function parseIsoDuration(iso: string): number | null {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

export async function GET(request: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json({ error: "YouTube APIキーが設定されていません" }, { status: 500 });
  }

  const playlistId = request.nextUrl.searchParams.get("playlistId");
  if (!playlistId) {
    return NextResponse.json({ error: "playlistIdが必要です" }, { status: 400 });
  }

  try {
    const videoIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        part: "contentDetails",
        playlistId,
        maxResults: "50",
        key: API_KEY,
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message =
          res.status === 404
            ? "プレイリストが見つかりませんでした"
            : (body?.error?.message ?? "プレイリストの取得に失敗しました");
        return NextResponse.json({ error: message }, { status: res.status });
      }

      const data = await res.json();
      for (const entry of data.items ?? []) {
        const videoId = entry.contentDetails?.videoId;
        if (videoId) videoIds.push(videoId);
      }
      pageToken = data.nextPageToken;
      if (videoIds.length >= SAFETY_MAX_ITEMS) break;
    } while (pageToken);

    const batches: string[][] = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      batches.push(videoIds.slice(i, i + 50));
    }

    const items: PlaylistImportItem[] = (
      await Promise.all(
        batches.map(async (batch) => {
          const params = new URLSearchParams({
            part: "snippet,contentDetails,status",
            id: batch.join(","),
            key: API_KEY,
          });
          const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
          if (!res.ok) return [];

          const data = await res.json();
          return (data.items ?? []).map(
            (video: {
              id: string;
              snippet?: {
                title?: string;
                channelTitle?: string;
                thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
              };
              contentDetails?: { duration?: string };
              status?: { embeddable?: boolean };
            }): PlaylistImportItem => ({
              videoId: video.id,
              title: video.snippet?.title ?? "",
              channelTitle: video.snippet?.channelTitle ?? "",
              thumbnailUrl:
                video.snippet?.thumbnails?.medium?.url ??
                video.snippet?.thumbnails?.default?.url ??
                "",
              duration: video.contentDetails?.duration
                ? parseIsoDuration(video.contentDetails.duration)
                : null,
              embeddable: video.status?.embeddable ?? false,
            }),
          );
        }),
      )
    ).flat();

    // videos.list omits deleted/private videos, so re-derive order from the
    // original playlistItems sequence instead of trusting response order.
    const order = new Map(videoIds.map((id, index) => [id, index]));
    items.sort((a, b) => (order.get(a.videoId) ?? 0) - (order.get(b.videoId) ?? 0));

    let playlistTitle: string | null = null;
    const playlistRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${API_KEY}`,
    );
    if (playlistRes.ok) {
      const playlistData = await playlistRes.json();
      playlistTitle = playlistData.items?.[0]?.snippet?.title ?? null;
    }

    const response: PlaylistImportResult = { playlistTitle, items };
    return NextResponse.json(response);
  } catch {
    return NextResponse.json({ error: "プレイリストの取得に失敗しました" }, { status: 500 });
  }
}
