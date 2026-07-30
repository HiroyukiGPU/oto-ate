import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import ChorusQueueStarter from "./ChorusQueueStarter";
import ChunkErrorReloader from "./ChunkErrorReloader";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "おとアテ！",
  description: "YouTubeのサビだけで遊ぶ早押し音楽クイズ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ChorusQueueStarter />
        <ChunkErrorReloader />
        {children}
      </body>
    </html>
  );
}
