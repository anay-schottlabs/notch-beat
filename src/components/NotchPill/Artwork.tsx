import { useState } from "react";
import "./Artwork.css";

/** Album art, or a neutral music glyph when there's none (never a broken image). */
export function Artwork({ url, size }: { url: string | null; size: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.24) };
  if (url && failed !== url) {
    return <img className="artwork" src={url} alt="" style={style} onError={() => setFailed(url)} draggable={false} />;
  }
  return (
    <span className="artwork artwork--glyph" style={style} aria-hidden="true">
      <svg viewBox="0 0 16 16" width={size * 0.58} height={size * 0.58}>
        <path d="M6 12.2V3.6l7-1.6v8.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="4.4" cy="12.2" r="1.9" fill="currentColor" />
        <circle cx="11.4" cy="10.6" r="1.9" fill="currentColor" />
      </svg>
    </span>
  );
}
