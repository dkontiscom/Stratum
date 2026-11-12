// SPDX-License-Identifier: MIT
// Small media helpers shared by server (content-type on responses) and importer (file filter).

export const AUDIO_EXTENSIONS = ["flac", "mp3", "m4a", "aac", "ogg", "opus", "wav"] as const;
export type AudioExt = (typeof AUDIO_EXTENSIONS)[number];

const MIME: Record<string, string> = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
};

export function extOf(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot >= 0 ? key.slice(dot + 1).toLowerCase() : "";
}

export function isAudioKey(key: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extOf(key));
}

export function ext2mime(ext: string): string {
  return MIME[ext?.toLowerCase()] ?? "application/octet-stream";
}
