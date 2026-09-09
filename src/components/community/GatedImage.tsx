import { useEffect, useRef, useState } from "react";

/**
 * An image behind the NDA gate.
 *
 * A browser `<img>` cannot send an Authorization header, and api/community/content-service.js
 * requires a Firebase bearer for anything under the `gated/` prefix. So every gated deck image
 * returned 401 — to anonymous visitors, and equally to signed-in NDA readers, whose deck pages
 * showed nothing but broken images. This fetches the bytes with the reader's token and hands the
 * element an object URL instead.
 *
 * The fetch is deferred until the image is near the viewport, so a 105-card deck does not pull a
 * hundred authenticated requests on mount, and every object URL is revoked on unmount.
 */
export default function GatedImage({
  src,
  alt,
  accessToken,
  className,
}: {
  src: string;
  alt: string;
  accessToken?: string;
  className?: string;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const [objectUrl, setObjectUrl] = useState("");
  const [failed, setFailed] = useState(false);
  // Without IntersectionObserver there is nothing to defer on, so start eager rather than never.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const node = holderRef.current;
    if (!node || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || !accessToken) return;
    let revoked = false;
    let url = "";

    fetch(src, { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => {
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => setFailed(true));

    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [near, src, accessToken]);

  if (failed) return null;

  return (
    <div ref={holderRef} className={className}>
      {objectUrl ? (
        <img src={objectUrl} alt={alt} className="block h-auto w-full rounded-[14px]" />
      ) : (
        <div className="aspect-[16/9] w-full animate-pulse rounded-[14px] bg-[#1D1D1F]/[0.05]" />
      )}
    </div>
  );
}
