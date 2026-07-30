export type PlaylistImportItem = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  duration: number | null;
  embeddable: boolean;
};

export type PlaylistImportResult = {
  playlistTitle: string | null;
  items: PlaylistImportItem[];
};

const IMPORT_TIMEOUT_MS = 125000;

export async function fetchPlaylistImport(playlistId: string): Promise<PlaylistImportResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/youtube/playlist?playlistId=${encodeURIComponent(playlistId)}`, {
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error ?? "プレイリストの取得に失敗しました");
    }
    return data as PlaylistImportResult;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        "プレイリストの取得に時間がかかりすぎたため中止しました。曲数が非常に多いか、YouTube Musicの自動生成プレイリスト（ラジオ・ミックスなど）の可能性があります。",
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
