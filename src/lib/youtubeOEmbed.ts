export type VideoInfo = {
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
};

export async function fetchVideoInfo(videoId: string): Promise<VideoInfo | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  const res = await fetch(oembedUrl);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
  };

  if (!data.title) return null;

  return {
    title: data.title,
    channelTitle: data.author_name ?? "",
    thumbnailUrl: data.thumbnail_url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}
