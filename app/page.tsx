"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WheelEventHandler, MouseEventHandler } from "react";
import { createClient } from "@supabase/supabase-js";

type Line = {
  line_id: string;
  transcription: string;
  // Pixel-space box in the JSON (validated to align with the PDF render)
  bbox: [number, number, number, number];
  // Normalized box may exist but we won't rely on it
  bboxn?: [number, number, number, number];
};

type LineWithUid = Line & {
  uid: string;
};
type PageObj = {
  width: number;
  height: number;
  paragraphs: { lines: Line[] }[];
};
type DocJson = Record<string, PageObj>;

type SuggestionRow = {
  id: string;
  document_id: string;
  page_key: string;
  uid: string;
  suggested_text: string;
  user_id: string;
  created_at: string;
};

function pageKeyToNumber(pageKey: string) {
  const m = pageKey.match(/_page_(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}
function getAllLinesForPage(p: PageObj): LineWithUid[] {
  const out: LineWithUid[] = [];
  (p.paragraphs || []).forEach((par, pIdx) => {
    (par.lines || []).forEach((l, lIdx) => {
      out.push({ ...l, uid: `${pIdx}-${lIdx}` });
    });
  });
  return out;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Home() {
  const PDF_URL = process.env.NEXT_PUBLIC_PDF_URL!;
  const JSON_URL = process.env.NEXT_PUBLIC_JSON_URL!;

  // Supabase document id for this viewer
  const DOCUMENT_ID = process.env.NEXT_PUBLIC_DOCUMENT_ID || "";

  // Auth
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [user, setUser] = useState<{ id: string; email: string | null } | null>(null);

  // Suggestions (grouped by uid)
  const [suggestionsByUid, setSuggestionsByUid] = useState<Record<string, SuggestionRow[]>>({});
  const [openSuggestUid, setOpenSuggestUid] = useState<string | null>(null);
  const [suggestText, setSuggestText] = useState<string>("");
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitSvgRef = useRef<SVGSVGElement | null>(null);
  const highlightSvgRef = useRef<SVGSVGElement | null>(null);
  const boxByUidRef = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const renderTaskRef = useRef<any>(null);
  const pdfScrollRef = useRef<HTMLDivElement | null>(null);
  const rightScrollRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  const lineElByIdRef = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeSource, setActiveSource] = useState<"left" | "right" | null>(null);  

  const [doc, setDoc] = useState<DocJson | null>(null);
  const [pdf, setPdf] = useState<any>(null);
  const [pageKey, setPageKey] = useState<string>("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeBox, setActiveBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [hitBoxes, setHitBoxes] = useState<Array<{ uid: string; x: number; y: number; w: number; h: number; area: number }>>([]);
  const hoverRafRef = useRef<number | null>(null);
  const hoverPtRef = useRef<{ x: number; y: number } | null>(null);

  const [zoom, setZoom] = useState<number>(1);
  const [pdfViewportWidth, setPdfViewportWidth] = useState<number>(0);

  const pageKeys = useMemo(() => {
    if (!doc) return [];
    return Object.keys(doc).sort((a, b) => (pageKeyToNumber(a) ?? 0) - (pageKeyToNumber(b) ?? 0));
  }, [doc]);

  async function loadSuggestionsForPage(docId: string, pk: string) {
    if (!docId || !pk) return;
    setIsLoadingSuggestions(true);
    try {
      const { data, error } = await supabase
        .from("suggestions")
        .select("id,document_id,page_key,uid,suggested_text,user_id,created_at")
        .eq("document_id", docId)
        .eq("page_key", pk)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const grouped: Record<string, SuggestionRow[]> = {};
      (data ?? []).forEach((row: any) => {
        const uid = String(row.uid);
        if (!grouped[uid]) grouped[uid] = [];
        grouped[uid].push(row as SuggestionRow);
      });
      setSuggestionsByUid(grouped);
    } catch (e) {
      console.warn(e);
      setSuggestionsByUid({});
    } finally {
      setIsLoadingSuggestions(false);
    }
  }

  async function submitSuggestion(uid: string) {
    if (!user) return alert("Please sign in to suggest edits.");
    if (!DOCUMENT_ID) return alert("Missing NEXT_PUBLIC_DOCUMENT_ID in .env.local");
    if (!pageKey) return;

    const text = suggestText.trim();
    if (!text) return;

    const { error } = await supabase.from("suggestions").insert({
      document_id: DOCUMENT_ID,
      page_key: pageKey,
      uid,
      suggested_text: text,
      user_id: user.id,
    });

    if (error) return alert(error.message);

    setOpenSuggestUid(null);
    setSuggestText("");
    await loadSuggestionsForPage(DOCUMENT_ID, pageKey);
  }

  const clampZoom = (z: number) => Math.max(0.5, Math.min(5, z));
  const zoomIn = () => setZoom((z) => clampZoom(Number((z * 1.15).toFixed(4))));
  const zoomOut = () => setZoom((z) => clampZoom(Number((z / 1.15).toFixed(4))));
  const zoomReset = () => setZoom(1);

  const onPdfWheel: WheelEventHandler<HTMLDivElement> = (e) => {
    // Zoom with Cmd/Ctrl + wheel/trackpad
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = e.deltaY;
    if (delta > 0) zoomOut();
    else if (delta < 0) zoomIn();
  };

  const endDrag = () => {
    isDraggingRef.current = false;
    const el = pdfScrollRef.current;
    if (!el) return;
    el.style.cursor = zoom > 1 ? "grab" : "auto";
    el.style.userSelect = "auto";
  };

  const onPdfMouseDown: MouseEventHandler<HTMLDivElement> = (e) => {
    // Only enable drag-to-pan when zoomed in
    if (zoom <= 1) return;
    const el = pdfScrollRef.current;
    if (!el) return;

    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };

    el.style.cursor = "grabbing";
    el.style.userSelect = "none";
  };

  const onPdfMouseMove: MouseEventHandler<HTMLDivElement> = (e) => {
    if (!isDraggingRef.current) return;
    const el = pdfScrollRef.current;
    if (!el) return;

    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;

    el.scrollLeft = dragStartRef.current.scrollLeft - dx;
    el.scrollTop = dragStartRef.current.scrollTop - dy;
  };

  const onPdfMouseUp: MouseEventHandler<HTMLDivElement> = () => {
    endDrag();
  };

  const onPdfMouseLeave: MouseEventHandler<HTMLDivElement> = () => {
    endDrag();
  };

  useEffect(() => {
    (async () => {
      if (!PDF_URL || !JSON_URL) throw new Error("Missing NEXT_PUBLIC_PDF_URL or NEXT_PUBLIC_JSON_URL");

      const r = await fetch(JSON_URL);
      if (!r.ok) throw new Error(`JSON fetch failed: ${r.status}`);
      const j = (await r.json()) as DocJson;
      setDoc(j);

      const firstValid = Object.keys(j).find(k => pageKeyToNumber(k) != null) ?? Object.keys(j)[0];
      setPageKey(firstValid);

      // Dynamically import pdf.js on the client only.
      // Using the legacy build avoids `DOMMatrix is not defined` during server/module evaluation.
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf");
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();

      const loaded = await pdfjsLib.getDocument(PDF_URL).promise;
      setPdf(loaded);
    })().catch(e => {
      console.error(e);
      alert(e?.message || String(e));
    });
  }, [PDF_URL, JSON_URL]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      setUser(u ? { id: u.id, email: u.email } : null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const u = session?.user;
      setUser(u ? { id: u.id, email: u.email } : null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function signUp() {
    const { error } = await supabase.auth.signUp({ email, password: pw });
    if (error) return alert(error.message);
    alert("Signed up. You can sign in now.");
  }

  async function signIn() {
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    if (error) return alert(error.message);
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  // Load suggestions for the currently selected page
  useEffect(() => {
    if (!DOCUMENT_ID || !pageKey) return;
    loadSuggestionsForPage(DOCUMENT_ID, pageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DOCUMENT_ID, pageKey]);


  useEffect(() => {
    const el = pdfScrollRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setPdfViewportWidth(Math.floor(r.width));
    });

    ro.observe(el);
    // initialize
    const r = el.getBoundingClientRect();
    setPdfViewportWidth(Math.floor(r.width));

    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !pdf || !pageKey) return;
    let cancelled = false;

    (async () => {
      const n = pageKeyToNumber(pageKey);
      if (!n) throw new Error(`Bad page key: ${pageKey}`);
      if (n < 1 || n > pdf.numPages) throw new Error(`Page ${n} out of range (PDF has ${pdf.numPages})`);

      const page = await pdf.getPage(n);

      const scroller = pdfScrollRef.current;
      const prevScroll = scroller
        ? {
            left: scroller.scrollLeft,
            top: scroller.scrollTop,
            width: scroller.scrollWidth,
            height: scroller.scrollHeight,
          }
        : null;

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d", { alpha: false })!;

      // Cancel any previous in-flight render on this same canvas (prevents pdf.js error)
      try {
        renderTaskRef.current?.cancel?.();
      } catch {}
      renderTaskRef.current = null;

      const baseWidth = pdfViewportWidth || Math.floor(window.innerWidth * 0.48);
      const targetCssWidth = Math.max(200, Math.floor(baseWidth * zoom));
      const viewport1 = page.getViewport({ scale: 1 });
      const scale = targetCssWidth / viewport1.width;
      const viewport = page.getViewport({ scale });

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch (e: any) {
        // Ignore cancellations/races when zoom/page changes quickly
        if (cancelled || e?.name === "RenderingCancelledException") return;
        throw e;
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null;
      }

      if (cancelled) return;

      const hitSvg = hitSvgRef.current!;
      hitSvg.innerHTML = "";
      // NOTE: viewBox/preserveAspectRatio/size are controlled in JSX (width/height: 100%).
      // Avoid setting them here, because React re-renders can overwrite styles and desync overlays.

      // reset per-page box lookup
      boxByUidRef.current = {};
      setActiveBox(null);

      const lines = getAllLinesForPage(doc[pageKey]);
      const nextHitBoxes: Array<{ uid: string; x: number; y: number; w: number; h: number; area: number }> = [];

      for (const l of lines) {
        const pageW = doc[pageKey].width;
        const pageH = doc[pageKey].height;

        const [x1p, y1p, x2p, y2p] = l.bbox;

        // Guard against bad data
        if (![x1p, y1p, x2p, y2p, pageW, pageH].every((v) => Number.isFinite(v))) continue;
        if (pageW <= 0 || pageH <= 0) continue;

        let x1n = x1p / pageW;
        let x2n = x2p / pageW;
        let y1n = y1p / pageH;
        let y2n = y2p / pageH;
        
        // Clamp to [0,1]
        x1n = Math.min(1, Math.max(0, x1n));
        x2n = Math.min(1, Math.max(0, x2n));
        y1n = Math.min(1, Math.max(0, y1n));
        y2n = Math.min(1, Math.max(0, y2n));

        if (x2n < x1n) [x1n, x2n] = [x2n, x1n];
        if (y2n < y1n) [y1n, y2n] = [y2n, y1n];

        const w = Math.max(0, x2n - x1n);
        const h = Math.max(0, y2n - y1n);
        const area = w * h;

        // Skip invalid boxes
        if (w <= 0 || h <= 0) continue;

        // Lines should be thin; skip paragraph/page-sized boxes
        if (h > 0.20) continue;
        if (area > 0.25) continue;
        if (w > 0.98 && h > 0.50) continue;
        if (w > 0.95 && h > 0.95) continue;

        // Extra safety: skip any box that is suspiciously large in either dimension
        if (w > 0.999 || h > 0.999) continue;

        if (process.env.NODE_ENV !== "production" && (h > 0.08 || area > 0.08)) {
          // eslint-disable-next-line no-console
          console.warn("Large bbox (from bbox pixels)", { uid: l.uid, bbox: l.bbox, w, h, area });
        }

        boxByUidRef.current[l.uid] = { x: x1n, y: y1n, w, h };
        nextHitBoxes.push({ uid: l.uid, x: x1n, y: y1n, w, h, area });
      }

      // Sort for stable selection: prefer smallest area (most specific) first
      nextHitBoxes.sort((a, b) => a.area - b.area);
      setHitBoxes(nextHitBoxes);

      if (scroller && prevScroll) {
        requestAnimationFrame(() => {
          const newW = scroller.scrollWidth || 1;
          const newH = scroller.scrollHeight || 1;
          const x = prevScroll.width ? prevScroll.left / prevScroll.width : 0;
          const y = prevScroll.height ? prevScroll.top / prevScroll.height : 0;
          scroller.scrollLeft = Math.max(0, Math.floor(x * newW));
          scroller.scrollTop = Math.max(0, Math.floor(y * newH));
        });
      }

    })().catch(e => {
      console.error(e);
      alert(e?.message || String(e));
    });

    return () => {
      cancelled = true;
      try {
        renderTaskRef.current?.cancel?.();
      } catch {}
    };
  }, [doc, pdf, pageKey, zoom, pdfViewportWidth]);

  useEffect(() => {
    if (!activeId) return;
    if (activeSource !== "left") return;

    const lineEl = lineElByIdRef.current[String(activeId)];
    const container = rightScrollRef.current;
    if (!lineEl || !container) return;

    const containerRect = container.getBoundingClientRect();
    const lineRect = lineEl.getBoundingClientRect();

    // line's top relative to the scroll container viewport
    const offsetTop = lineRect.top - containerRect.top;

    const targetTop =
      container.scrollTop +
      offsetTop -
      container.clientHeight / 2 +
      lineEl.clientHeight / 2;

    container.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [activeId, activeSource]);

  // ------------------------------
  // Point-based hit-testing (PDF image -> transcript)
  // ------------------------------
  function pickBoxAt(u: number, v: number) {
    // u,v are normalized [0,1] coordinates within the rendered page
    // hitBoxes are sorted by area asc, so the first match is the most specific.
    for (const b of hitBoxes) {
      if (u >= b.x && u <= b.x + b.w && v >= b.y && v <= b.y + b.h) return b;
    }
    return null;
  }

  const onHitSvgMouseMove: MouseEventHandler<SVGSVGElement> = (e) => {
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;

    hoverPtRef.current = { x: u, y: v };
    if (hoverRafRef.current != null) return;

    hoverRafRef.current = window.requestAnimationFrame(() => {
      hoverRafRef.current = null;
      const pt = hoverPtRef.current;
      if (!pt) return;

      const uu = Math.min(1, Math.max(0, pt.x));
      const vv = Math.min(1, Math.max(0, pt.y));

      const picked = pickBoxAt(uu, vv);
      if (!picked) return;

      if (activeId === picked.uid && activeSource === "left") return;

      setActiveSource("left");
      setActiveId(picked.uid);
      setActiveBox(boxByUidRef.current[picked.uid] ?? null);
    });
  };

  const onHitSvgMouseLeave: MouseEventHandler<SVGSVGElement> = () => {
    hoverPtRef.current = null;
    if (hoverRafRef.current != null) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
    setActiveSource(null);
    setActiveId(null);
    setActiveBox(null);
  };


  if (!doc) return <div style={{ padding: 16 }}>Loading…</div>;
  if (!DOCUMENT_ID) {
    return (
      <div style={{ padding: 16 }}>
        Missing <code>NEXT_PUBLIC_DOCUMENT_ID</code> in <code>.env.local</code>. Set it to the <code>documents.id</code> you ingested.
      </div>
    );
  }

  const lines = pageKey ? getAllLinesForPage(doc[pageKey]) : [];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", height: "100vh" }}>
      <div
        style={{
          borderRight: "1px solid #e6e6e6",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        {/* Header (does NOT scroll over the PDF) */}
        <div
          style={{
            padding: 12,
            borderBottom: "1px solid #e6e6e6",
            background: "white",
            zIndex: 1,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            {!user ? (
              <>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email"
                  style={{ padding: "6px 8px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 8 }}
                />
                <input
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="password"
                  type="password"
                  style={{ padding: "6px 8px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 8 }}
                />
                <button type="button" onClick={signIn} style={{ padding: "6px 10px" }}>
                  Sign in
                </button>
                <button type="button" onClick={signUp} style={{ padding: "6px 10px" }}>
                  Sign up
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13 }}>
                  Signed in as <b>{user.email || user.id}</b>
                </div>
                <button type="button" onClick={signOut} style={{ padding: "6px 10px" }}>
                  Sign out
                </button>
              </>
            )}
            {isLoadingSuggestions ? <span style={{ fontSize: 12, opacity: 0.7 }}>Loading suggestions…</span> : null}
          </div>

          <select value={pageKey} onChange={(e) => setPageKey(e.target.value)}>
            {pageKeys.map((k) => (
              <option key={k} value={k}>
                Page {pageKeyToNumber(k) ?? k}
              </option>
            ))}
          </select>
          <span style={{ marginLeft: 12, display: "inline-flex", gap: 8, alignItems: "center" }}>
            <button type="button" onClick={zoomOut} style={{ padding: "4px 8px" }}>−</button>
            <button type="button" onClick={zoomReset} style={{ padding: "4px 8px" }}>{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={zoomIn} style={{ padding: "4px 8px" }}>+</button>
          </span>
        </div>

        {/* Scrollable PDF area */}
        <div
          ref={pdfScrollRef}
          onWheel={onPdfWheel}
          onMouseDown={onPdfMouseDown}
          onMouseMove={onPdfMouseMove}
          onMouseUp={onPdfMouseUp}
          onMouseLeave={onPdfMouseLeave}
          style={{
            padding: 12,
            overflow: "auto",
            flex: 1,
            cursor: zoom > 1 ? "grab" : "auto",
          }}
        >
          <div style={{ position: "relative", display: "inline-block" }}>
            <canvas ref={canvasRef} />

            {/* Invisible hit layer (interactive) */}
            <svg
              ref={hitSvgRef}
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              onMouseMove={onHitSvgMouseMove}
              onMouseLeave={onHitSvgMouseLeave}
              style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "auto" }}
            />

            {/* Visible highlight layer (non-interactive) */}
            <svg
              ref={highlightSvgRef}
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none" }}
            >
              {activeBox ? (
                <rect
                  x={activeBox.x}
                  y={activeBox.y}
                  width={activeBox.w}
                  height={activeBox.h}
                  fill="none"
                  stroke="rgba(255, 200, 0, 0.95)"
                  strokeWidth={3}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </svg>
          </div>
        </div>
      </div>

      <div ref={rightScrollRef} style={{ padding: 12, overflow: "auto" }}>
        {lines.map((l) => (
          <div
            key={l.uid}
            ref={(el) => {
              lineElByIdRef.current[String(l.uid)] = el;
            }}
            onMouseEnter={() => {
              setActiveSource("right");
              setActiveId(l.uid);
              setActiveBox(boxByUidRef.current[l.uid] ?? null);
            }}
            onMouseLeave={() => {
              setActiveSource(null);
              setActiveId(null);
              setActiveBox(null);
            }}
            onClick={() => {
              setActiveSource("right");
              setActiveId(l.uid);
              setActiveBox(boxByUidRef.current[l.uid] ?? null);
            }}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              lineHeight: 1.35,
              marginBottom: 6,
              cursor: "pointer",
              border: "1px solid rgba(0,0,0,0.06)",
              background: activeId === l.uid ? "rgba(255,242,168,0.75)" : "transparent",
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <div style={{ flex: 1, whiteSpace: "pre-wrap" }}>{l.transcription}</div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (openSuggestUid === l.uid) {
                    setOpenSuggestUid(null);
                    setSuggestText("");
                  } else {
                    setOpenSuggestUid(l.uid);
                    setSuggestText(l.transcription);
                  }
                }}
                style={{ padding: "4px 8px", fontSize: 12 }}
              >
                Suggest edit
              </button>
            </div>

            {openSuggestUid === l.uid ? (
              <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                <textarea
                  value={suggestText}
                  onChange={(e) => setSuggestText(e.target.value)}
                  rows={3}
                  style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(0,0,0,0.15)" }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" onClick={() => submitSuggestion(l.uid)} style={{ padding: "6px 10px" }}>
                    Submit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenSuggestUid(null);
                      setSuggestText("");
                    }}
                    style={{ padding: "6px 10px" }}
                  >
                    Cancel
                  </button>
                </div>
                {!user ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>Sign in to submit.</div> : null}
              </div>
            ) : null}

            {suggestionsByUid[l.uid]?.length ? (
              <div style={{ marginTop: 10, fontSize: 12 }} onClick={(e) => e.stopPropagation()}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Suggestions</div>
                {suggestionsByUid[l.uid].slice(0, 5).map((s) => (
                  <div
                    key={s.id}
                    style={{
                      padding: "6px 8px",
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 10,
                      marginBottom: 6,
                      background: "rgba(255,255,255,0.75)",
                    }}
                  >
                    <div style={{ whiteSpace: "pre-wrap" }}>{s.suggested_text}</div>
                    <div style={{ marginTop: 4, opacity: 0.75 }}>
                      by {s.user_id.slice(0, 8)} • {new Date(s.created_at).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}