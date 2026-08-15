// AdSense slot. If VITE_ADS_CLIENT_ID is set we render a real <ins> + push;
// otherwise a styled placeholder. Either way the slot has a fixed height so
// ad loading never blocks or shifts layout.

import { useEffect } from "react";

export function AdSlot({ size }: { size: "sidebar" | "content" }) {
  const clientId = (import.meta.env.VITE_ADS_CLIENT_ID as string | undefined) ?? "";

  useEffect(() => {
    if (!clientId) return;
    const w = window as unknown as { adsbygoogle?: unknown[] };
    (w.adsbygoogle = w.adsbygoogle ?? []).push({});
    if (!document.querySelector('script[src*="adsbygoogle"]')) {
      const s = document.createElement("script");
      s.async = true;
      s.crossOrigin = "anonymous";
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${clientId}`;
      document.head.appendChild(s);
    }
  }, [clientId]);

  return (
    <div className={`ad-slot ad-${size}`}>
      {clientId ? (
        <ins
          className="adsbygoogle"
          data-ad-client={clientId}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      ) : (
        <div className="ad-placeholder">
          <span>ad</span>
        </div>
      )}
    </div>
  );
}
