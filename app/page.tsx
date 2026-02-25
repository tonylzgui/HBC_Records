"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { WheelEventHandler, MouseEventHandler } from "react";
import { createClient } from "@supabase/supabase-js";

type Line = {
  line_id: string;
  transcription: string;
  // Pixel-space box in the JSON (validated to align with the PDF render)
  bbox: [number, number, number, number];
  // Normalized box may exist but we won't rely on it
  bboxn?: [number, number, number, number];
  // Some JSONs include per-line confidence/class
  confidence?: number;
  class?: string;
};

type LineWithUid = Line & {
  uid: string;
};
type PageObj = {
  width: number;
  height: number;
  paragraphs: Array<{
    class?: string;
    confidence?: number;
    // Some JSONs include a bbox for paragraph blocks; optional.
    bbox?: [number, number, number, number];
    bboxn?: [number, number, number, number];
    lines: Line[];
    llm_text?: string | null;
  }>;
  // Some JSONs also include extracted lists/tables. Make them optional so old JSONs still work.
  lists?: Array<{
    class?: string;
    confidence?: number;
    bbox: [number, number, number, number];
    bboxn?: [number, number, number, number];
    list_id?: string;
    lines: Line[];
  }>;
  tables?: Array<any>;
};
type DocJson = Record<string, PageObj>;

type SuggestionRow = {
  id: string;
  document_id: string;
  page_key: string;
  uid: string;
  suggested_text: string;
  comment?: string | null;
  user_id: string;
  created_at: string;
  vote_count?: number;
  author_username?: string | null; // snapshot stored on suggestion
};

type LowConfLabelRow = {
  id: string;
  document_id: string;
  page_key: string;
  target_pid: string;
  predicted_class?: string | null;
  predicted_confidence?: number | null;
  corrected_class: "Paragraph" | "List" | "Table" | "Other";
  other_text?: string | null;
  corrected_bbox?: [number, number, number, number] | null;
  corrected_bboxn?: [number, number, number, number] | null;
  user_id?: string | null;
  author_username?: string | null;
  updated_at?: string | null;
};

type MapDoc = {
  id: string;
  title: string;
  lat: number;
  lng: number;
};

type MapDocOption = { id: string; title: string };

type DocLocation = {
  id: string;
  document_id: string;
  seq: number;
  label: string | null;
  lat: number;
  lng: number;
  note: string | null;
};

type AggregatedLocation = {
  key: string;
  lat: number;
  lng: number;
  doc_count: number; // number of DISTINCT documents at this location
  doc_ids: string[];
  doc_titles: string[];
};

function pageKeyToNumber(pageKey: string) {
  // Supports both JSON keys like "..._page_12" and PDF-only keys like "pdf_only_page_12"
  const m = pageKey.match(/(?:^|_)page_(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}
function getAllLinesForPage(p: PageObj): LineWithUid[] {
  const out: LineWithUid[] = [];

  // Paragraph lines (KEEP existing uid scheme so old suggestions continue to match)
  (p.paragraphs || []).forEach((par, pIdx) => {
    (par.lines || []).forEach((l, lIdx) => {
      out.push({ ...l, uid: `${pIdx}-${lIdx}` });
    });
  });

  // List lines (new uid namespace)
  (p.lists || []).forEach((lst: any, listIdx: number) => {
    (lst?.lines || []).forEach((l: any, lIdx: number) => {
      out.push({ ...l, uid: `list-${listIdx}-${lIdx}` });
    });
  });

  // Table lines (best-effort: only if table has `lines` shaped like Line[])
  (p.tables || []).forEach((tbl: any, tIdx: number) => {
    const tLines = Array.isArray(tbl?.lines) ? tbl.lines : [];
    tLines.forEach((l: any, lIdx: number) => {
      out.push({ ...l, uid: `table-${tIdx}-${lIdx}` });
    });
  });

  // ---- ORDER FIX ----
  // The JSON often stores lists/tables separately, but visually they belong mid-page.
  // If the scan is a 2-page spread (left page + right page on the same PDF page),
  // order by page-half first (left half, then right half), and within each half by y then x.
  // Otherwise, just sort by y then x.

  const pageW = Number((p as any).width);
  const pageH = Number((p as any).height);

  const safeKey = (l: any) => {
    const bb = l?.bbox;
    if (!Array.isArray(bb) || bb.length !== 4) return null;
    const x1 = Number(bb[0]);
    const y1 = Number(bb[1]);
    const x2 = Number(bb[2]);
    const y2 = Number(bb[3]);
    if (![x1, y1, x2, y2, pageW, pageH].every((v) => Number.isFinite(v)))
      return null;
    if (pageW <= 0 || pageH <= 0) return null;

    // normalize
    const y = y1 / pageH;
    const x = x1 / pageW;
    const xCenter = ((x1 + x2) * 0.5) / pageW;

    return { y, x, xCenter };
  };

  // Detect a 2-page spread: meaningful content on both far-left and far-right.
  // (Heuristic avoids forcing a split on single-page scans.)
  const centers: number[] = [];
  for (const l of out) {
    const k = safeKey(l);
    if (k) centers.push(k.xCenter);
  }

  let isTwoPageSpread = false;
  if (centers.length >= 10) {
    const leftCount = centers.filter((c) => c < 0.45).length;
    const rightCount = centers.filter((c) => c > 0.55).length;
    const fracLeft = leftCount / centers.length;
    const fracRight = rightCount / centers.length;
    // require both sides to have substantial content
    if (fracLeft > 0.2 && fracRight > 0.2) isTwoPageSpread = true;
  }

  out.sort((a, b) => {
    const ka = safeKey(a);
    const kb = safeKey(b);

    // If either key missing, push it to the end deterministically.
    if (!ka && !kb) return String(a.uid).localeCompare(String(b.uid));
    if (!ka) return 1;
    if (!kb) return -1;

    if (isTwoPageSpread) {
      const halfA = ka.xCenter < 0.5 ? 0 : 1;
      const halfB = kb.xCenter < 0.5 ? 0 : 1;
      if (halfA !== halfB) return halfA - halfB; // left half first
    }

    if (ka.y !== kb.y) return ka.y - kb.y;
    if (ka.x !== kb.x) return ka.x - kb.x;

    // stable tie-breaker to avoid jitter across renders
    return String(a.uid).localeCompare(String(b.uid));
  });

  return out;
}

export default function Home() {
  const PDF_URL = process.env.NEXT_PUBLIC_PDF_URL ?? "";
  const JSON_URL = process.env.NEXT_PUBLIC_JSON_URL ?? "";

  // Supabase document id for this viewer
  const DOCUMENT_ID = process.env.NEXT_PUBLIC_DOCUMENT_ID ?? "";

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  const [fatalError, setFatalError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [welcomeStats, setWelcomeStats] = useState<{
    pages: number | null;
    lines: number | null;
    volunteers: number | null;
  }>({ pages: null, lines: null, volunteers: null });

  const [transcriptionMode, setTranscriptionMode] = useState<
    "lines" | "paragraph"
  >("lines");
  const [activeParagraphId, setActiveParagraphId] = useState<string | null>(
    null,
  );
  const [paragraphItems, setParagraphItems] = useState<
    Array<{
      pid: string;
      text: string;
      box: { x: number; y: number; w: number; h: number };
    }>
  >([]);

  function normBoxFromPixels(
    bbox: [number, number, number, number],
    pageW: number,
    pageH: number,
  ): { x: number; y: number; w: number; h: number; area: number } | null {
    const [x1p, y1p, x2p, y2p] = bbox;
    if (![x1p, y1p, x2p, y2p, pageW, pageH].every((v) => Number.isFinite(v)))
      return null;
    if (pageW <= 0 || pageH <= 0) return null;

    let x1n = x1p / pageW;
    let x2n = x2p / pageW;
    let y1n = y1p / pageH;
    let y2n = y2p / pageH;

    x1n = Math.min(1, Math.max(0, x1n));
    x2n = Math.min(1, Math.max(0, x2n));
    y1n = Math.min(1, Math.max(0, y1n));
    y2n = Math.min(1, Math.max(0, y2n));

    if (x2n < x1n) [x1n, x2n] = [x2n, x1n];
    if (y2n < y1n) [y1n, y2n] = [y2n, y1n];

    const w = Math.max(0, x2n - x1n);
    const h = Math.max(0, y2n - y1n);
    if (w <= 0 || h <= 0) return null;

    return { x: x1n, y: y1n, w, h, area: w * h };
  }

  const missingEnv = useMemo(() => {
    const missing: string[] = [];
    if (!SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!SUPABASE_ANON_KEY) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    if (!PDF_URL) missing.push("NEXT_PUBLIC_PDF_URL");
    if (!JSON_URL) missing.push("NEXT_PUBLIC_JSON_URL");
    if (!DOCUMENT_ID) missing.push("NEXT_PUBLIC_DOCUMENT_ID");
    return missing;
  }, [SUPABASE_URL, SUPABASE_ANON_KEY, PDF_URL, JSON_URL, DOCUMENT_ID]);

  const supabase = useMemo(() => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }, [SUPABASE_URL, SUPABASE_ANON_KEY]);

  const [showSignup, setShowSignup] = useState(false);
  const [showSignin, setShowSignin] = useState(false);
  const [signinId, setSigninId] = useState(""); // username OR email
  const [signinPw, setSigninPw] = useState("");

  const [signupEmail, setSignupEmail] = useState("");
  const [signupUsername, setSignupUsername] = useState("");
  const [signupPw, setSignupPw] = useState("");
  const [user, setUser] = useState<{ id: string; email: string | null } | null>(
    null,
  );
  const [documentTitle, setDocumentTitle] = useState<string>("");

  // Suggestions (grouped by uid)
  const [suggestionsByUid, setSuggestionsByUid] = useState<
    Record<string, SuggestionRow[]>
  >({});
  const [openSuggestUid, setOpenSuggestUid] = useState<string | null>(null);
  const [suggestText, setSuggestText] = useState<string>("");
  const [suggestComment, setSuggestComment] = useState<string>("");
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [collapseSuggestions, setCollapseSuggestions] = useState(false);
  const [collapsedUid, setCollapsedUid] = useState<Record<string, boolean>>({});
  const [sortModeByUid, setSortModeByUid] = useState<
    Record<string, "top" | "newest">
  >({});
  const [hoverVoteId, setHoverVoteId] = useState<string | null>(null);
  const [usernameByUserId, setUsernameByUserId] = useState<
    Record<string, string>
  >({});

  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboardRows, setLeaderboardRows] = useState<
    Array<{ user_id: string; username: string; upvotes: number }>
  >([]);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);

  const [viewMode, setViewMode] = useState<"viewer" | "map">("viewer");
  const [mapDocs, setMapDocs] = useState<MapDoc[]>([]);
  const [isLoadingMap, setIsLoadingMap] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<any>(null);
  const leafletLayerRef = useRef<any>(null);
  const leafletPolylineRef = useRef<any>(null);
  const [mapDocOptions, setMapDocOptions] = useState<MapDocOption[]>([]);
  const [selectedMapDocId, setSelectedMapDocId] = useState<string>("");
  const [mapLocations, setMapLocations] = useState<DocLocation[]>([]);
  const [mapAggLocations, setMapAggLocations] = useState<AggregatedLocation[]>(
    [],
  );
  const [viewerLocations, setViewerLocations] = useState<DocLocation[]>([]);

  const [showAddLocation, setShowAddLocation] = useState(false);
  const [locLabel, setLocLabel] = useState<string>("");
  const [locLat, setLocLat] = useState<string>("");
  const [locLng, setLocLng] = useState<string>("");
  const [locNote, setLocNote] = useState<string>("");
  const [isSavingLocation, setIsSavingLocation] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitSvgRef = useRef<SVGSVGElement | null>(null);
  const highlightSvgRef = useRef<SVGSVGElement | null>(null);
  const boxByUidRef = useRef<
    Record<string, { x: number; y: number; w: number; h: number }>
  >({});
  const renderTaskRef = useRef<any>(null);
  const pdfScrollRef = useRef<HTMLDivElement | null>(null);
  const rightScrollRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  const lineElByIdRef = useRef<Record<string, HTMLDivElement | null>>({});
  const paragraphElByIdRef = useRef<Record<string, HTMLDivElement | null>>({});
  const [activeSource, setActiveSource] = useState<
    "left" | "right" | "menu" | null
  >(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [showLowConfidenceMenu, setShowLowConfidenceMenu] = useState(false);
  const [lowConfLabelsByKey, setLowConfLabelsByKey] = useState<
    Record<
      string,
      {
        corrected_class: "Paragraph" | "List" | "Table" | "Other";
        other_text: string;
        author_username?: string;
        user_id?: string;
        updated_at?: string;
      }
    >
  >({});

  const [lowConfDraftByKey, setLowConfDraftByKey] = useState<
    Record<
      string,
      {
        corrected_class: "Paragraph" | "List" | "Table" | "Other";
        other_text: string;
      }
    >
  >({});

  const [isSavingLowConf, setIsSavingLowConf] = useState<
    Record<string, boolean>
  >({});

  // ---- Low-confidence box drawing (user-corrected bbox) ----
  const [isDrawingLowConfBox, setIsDrawingLowConfBox] = useState(false);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const [drawPreviewBox, setDrawPreviewBox] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  // While in drawing mode (but not actively dragging), show hovered block bbox on the PDF
  // WITHOUT changing the active selection/highlight on the right panel.
  const [drawHoverBox, setDrawHoverBox] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  // Lock the current low-confidence block after the user starts drawing,
  // until they explicitly Save or Cancel.
  const [lowConfLockKey, setLowConfLockKey] = useState<string | null>(null);

  const isLowConfLocked = !!lowConfLockKey || isDrawingLowConfBox;

  // Remember what the box was BEFORE the user started drawing, so Cancel can revert.
  const prevLowConfBoxRef = useRef<{
    key: string | null;
    box: { x: number; y: number; w: number; h: number } | null;
  }>({ key: null, box: null });

  // keyed by `${pageKey}|${targetPid}`
  const [lowConfDrawnBoxByKey, setLowConfDrawnBoxByKey] = useState<
    Record<string, { x: number; y: number; w: number; h: number }>
  >({});

  function beginLowConfLock(key: string) {
    if (lowConfLockKey === key) return;

    prevLowConfBoxRef.current = {
      key,
      box: lowConfDrawnBoxByKey[key] ?? null,
    };

    setLowConfLockKey(key);

    // Scroll the locked block into view so the controls are visible
    const pid = key.split("|")[1];
    setTimeout(() => {
      const el = paragraphElByIdRef.current[pid];
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 0);
  }

  function clearLowConfLock() {
    setLowConfLockKey(null);
    prevLowConfBoxRef.current = { key: null, box: null };
    setIsDrawingLowConfBox(false);
    drawStartRef.current = null;
    setDrawPreviewBox(null);
    setDrawHoverBox(null);
  }

  function cancelLowConfLock(key: string) {
    const prev = prevLowConfBoxRef.current;
    const prevBox = prev.key === key ? prev.box : null;

    setLowConfDrawnBoxByKey((cur) => {
      const next = { ...cur };
      if (prevBox) next[key] = prevBox;
      else delete next[key];
      return next;
    });

    clearLowConfLock();
  }

  const lowConfMenuRef = useRef<HTMLDivElement | null>(null);
  const lowConfBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!showLowConfidenceMenu) return;

    const onWindowClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const menuEl = lowConfMenuRef.current;
      const btnEl = lowConfBtnRef.current;

      // Click inside menu -> keep open
      if (menuEl && target && menuEl.contains(target)) return;

      // Click on the toggle button -> keep open (this is the click that opens it)
      if (btnEl && target && btnEl.contains(target)) return;

      setShowLowConfidenceMenu(false);
    };

    // Use `click` so other header button onClick handlers still fire normally.
    window.addEventListener("click", onWindowClick);
    return () => window.removeEventListener("click", onWindowClick);
  }, [showLowConfidenceMenu]);

  const [pendingLowConfJump, setPendingLowConfJump] = useState<null | {
    pageKey: string;
    targetPid: string; // paragraph-mode pid: p-#, list-#, table-#
    box: { x: number; y: number; w: number; h: number };
  }>(null);

  const [doc, setDoc] = useState<DocJson | null>(null);
  const [pdf, setPdf] = useState<any>(null);
  const [pageKey, setPageKey] = useState<string>("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeBox, setActiveBox] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [hitBoxes, setHitBoxes] = useState<
    Array<{
      uid: string;
      x: number;
      y: number;
      w: number;
      h: number;
      area: number;
    }>
  >([]);
  const hoverRafRef = useRef<number | null>(null);
  const hoverPtRef = useRef<{ x: number; y: number } | null>(null);

  const [zoom, setZoom] = useState<number>(1);
  const [pdfViewportWidth, setPdfViewportWidth] = useState<number>(0);

  // Prevent accidental modal close on click-drag: only close when user *clicks* the backdrop (no drag).
  // Use pointer-capture so we reliably detect movement even if the pointer leaves the backdrop.
  const backdropClickRef = useRef<{
    down: boolean;
    moved: boolean;
    x: number;
    y: number;
    pointerId: number | null;
  }>({
    down: false,
    moved: false,
    x: 0,
    y: 0,
    pointerId: null,
  });

  function backdropHandlers(close: () => void) {
    return {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        // Only track gestures that START on the backdrop itself
        if (e.target !== e.currentTarget) return;

        backdropClickRef.current.down = true;
        backdropClickRef.current.moved = false;
        backdropClickRef.current.x = e.clientX;
        backdropClickRef.current.y = e.clientY;
        backdropClickRef.current.pointerId = e.pointerId;

        // Capture the pointer so we still get move/up even if the pointer drifts off the backdrop
        try {
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        } catch {}
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        if (!backdropClickRef.current.down) return;
        const dx = Math.abs(e.clientX - backdropClickRef.current.x);
        const dy = Math.abs(e.clientY - backdropClickRef.current.y);
        if (dx > 6 || dy > 6) backdropClickRef.current.moved = true;
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        const wasDown = backdropClickRef.current.down;
        const moved = backdropClickRef.current.moved;
        const pid = backdropClickRef.current.pointerId;

        backdropClickRef.current.down = false;
        backdropClickRef.current.moved = false;
        backdropClickRef.current.pointerId = null;

        // Release capture (best-effort)
        try {
          if (pid != null)
            (e.currentTarget as HTMLDivElement).releasePointerCapture(pid);
        } catch {}

        // Only close if:
        // 1) the gesture started on the backdrop
        // 2) the pointer did NOT move (no drag)
        // 3) the pointer-up is on the backdrop itself
        if (wasDown && !moved && e.target === e.currentTarget) close();
      },
      onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => {
        const pid = backdropClickRef.current.pointerId;
        backdropClickRef.current.down = false;
        backdropClickRef.current.moved = false;
        backdropClickRef.current.pointerId = null;
        try {
          if (pid != null)
            (e.currentTarget as HTMLDivElement).releasePointerCapture(pid);
        } catch {}
      },
    };
  }

  const pageKeys = useMemo(() => {
    if (!doc) return [];

    // Map existing doc keys by their page number
    const docKeyByNum: Record<number, string> = {};
    for (const k of Object.keys(doc)) {
      const n = pageKeyToNumber(k);
      if (n != null) docKeyByNum[n] = k;
    }

    // If pdf is loaded, allow navigating every PDF page (even if no transcription exists)
    if (pdf?.numPages) {
      const out: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        out.push(docKeyByNum[n] ?? `pdf_only_page_${n}`);
      }
      return out;
    }

    // Otherwise, only show pages that exist in the JSON
    return Object.keys(doc).sort(
      (a, b) => (pageKeyToNumber(a) ?? 0) - (pageKeyToNumber(b) ?? 0),
    );
  }, [doc, pdf]);

  function confToPct(c: any): number | null {
    if (!Number.isFinite(Number(c))) return null;
    const n = Number(c);
    // Support both 0..1 and 0..100 style confidences
    return n <= 1 ? n * 100 : n;
  }

  function blockBoxFromLines(lines: any[], pageW: number, pageH: number) {
    let minX = 1,
      minY = 1,
      maxX = 0,
      maxY = 0;
    let found = false;

    for (const ln of lines || []) {
      const bb = ln?.bbox;
      if (!Array.isArray(bb) || bb.length !== 4) continue;
      const nb = normBoxFromPixels(
        bb as [number, number, number, number],
        pageW,
        pageH,
      );
      if (!nb) continue;
      found = true;
      minX = Math.min(minX, nb.x);
      minY = Math.min(minY, nb.y);
      maxX = Math.max(maxX, nb.x + nb.w);
      maxY = Math.max(maxY, nb.y + nb.h);
    }

    if (!found) return null;

    minX = Math.min(1, Math.max(0, minX));
    minY = Math.min(1, Math.max(0, minY));
    maxX = Math.min(1, Math.max(0, maxX));
    maxY = Math.min(1, Math.max(0, maxY));

    const box = {
      x: minX,
      y: minY,
      w: Math.max(0, maxX - minX),
      h: Math.max(0, maxY - minY),
    };
    if (box.w <= 0 || box.h <= 0) return null;
    return box;
  }

  function boxToBboxn(box: {
    x: number;
    y: number;
    w: number;
    h: number;
  }): [number, number, number, number] {
    const x1 = Math.min(1, Math.max(0, box.x));
    const y1 = Math.min(1, Math.max(0, box.y));
    const x2 = Math.min(1, Math.max(0, box.x + box.w));
    const y2 = Math.min(1, Math.max(0, box.y + box.h));
    return [x1, y1, x2, y2];
  }

  function bboxFromBox(
    box: { x: number; y: number; w: number; h: number },
    pageW: number,
    pageH: number,
  ): [number, number, number, number] {
    const x1 = Math.round(Math.min(1, Math.max(0, box.x)) * pageW);
    const y1 = Math.round(Math.min(1, Math.max(0, box.y)) * pageH);
    const x2 = Math.round(Math.min(1, Math.max(0, box.x + box.w)) * pageW);
    const y2 = Math.round(Math.min(1, Math.max(0, box.y + box.h)) * pageH);
    return [x1, y1, x2, y2];
  }

  const lowConfItems = useMemo(() => {
    if (!doc)
      return [] as Array<{
        pageKey: string;
        pageNum: number | null;
        label: string;
        confPct: number;
        targetPid: string;
        box: { x: number; y: number; w: number; h: number } | null;
      }>;

    const TH = 0.5; // 50%

    const out: Array<{
      pageKey: string;
      pageNum: number | null;
      label: string;
      confPct: number;
      targetPid: string;
      box: { x: number; y: number; w: number; h: number } | null;
    }> = [];

    for (const pk of Object.keys(doc)) {
      const pageObj: any = (doc as any)[pk];
      if (!pageObj) continue;

      const pageNum = pageKeyToNumber(pk);
      const pageW = Number(pageObj.width);
      const pageH = Number(pageObj.height);

      // -----------------
      // PARAGRAPH blocks (class === "prgph")
      // NOTE: we IGNORE line-level classes entirely.
      // -----------------
      const pars: any[] = Array.isArray(pageObj.paragraphs)
        ? pageObj.paragraphs
        : [];
      for (let pIdx = 0; pIdx < pars.length; pIdx++) {
        const par: any = pars[pIdx];
        const cls = String(par?.class ?? "");
        if (cls !== "prgph") continue;

        const c = Number(par?.confidence);
        if (!Number.isFinite(c) || c >= TH) continue;

        const pid = `p-${pIdx}`;

        // Prefer paragraph bbox if present; otherwise derive from lines (bbox union)
        let nb: {
          x: number;
          y: number;
          w: number;
          h: number;
          area: number;
        } | null = null;

        if (Array.isArray(par?.bbox) && par.bbox.length === 4) {
          nb = normBoxFromPixels(
            par.bbox as [number, number, number, number],
            pageW,
            pageH,
          );
        } else {
          const linesInPar: any[] = Array.isArray(par?.lines) ? par.lines : [];
          let minX = 1,
            minY = 1,
            maxX = 0,
            maxY = 0;
          let found = false;

          for (const ln of linesInPar) {
            const bb = Array.isArray(ln?.bbox)
              ? (ln.bbox as [number, number, number, number])
              : null;
            if (!bb) continue;
            const t = normBoxFromPixels(bb, pageW, pageH);
            if (!t) continue;
            found = true;
            minX = Math.min(minX, t.x);
            minY = Math.min(minY, t.y);
            maxX = Math.max(maxX, t.x + t.w);
            maxY = Math.max(maxY, t.y + t.h);
          }

          if (found) {
            const w = Math.max(0, maxX - minX);
            const h = Math.max(0, maxY - minY);
            if (w > 0 && h > 0) nb = { x: minX, y: minY, w, h, area: w * h };
          }
        }

        if (!nb) continue;

        out.push({
          pageKey: pk,
          pageNum,
          label: "Paragraph",
          confPct: c * 100,
          targetPid: pid,
          box: { x: nb.x, y: nb.y, w: nb.w, h: nb.h },
        });
      }

      // -----------------
      // LIST blocks (class === "list")
      // -----------------
      const lists: any[] = Array.isArray(pageObj.lists) ? pageObj.lists : [];
      for (let listIdx = 0; listIdx < lists.length; listIdx++) {
        const lst: any = lists[listIdx];
        const cls = String(lst?.class ?? "");
        if (cls !== "list") continue;

        const c = Number(lst?.confidence);
        if (!Number.isFinite(c) || c >= TH) continue;

        const pid = `list-${listIdx}`;

        let nb: {
          x: number;
          y: number;
          w: number;
          h: number;
          area: number;
        } | null = null;

        if (Array.isArray(lst?.bbox) && lst.bbox.length === 4) {
          nb = normBoxFromPixels(
            lst.bbox as [number, number, number, number],
            pageW,
            pageH,
          );
        } else {
          const linesInList: any[] = Array.isArray(lst?.lines) ? lst.lines : [];
          let minX = 1,
            minY = 1,
            maxX = 0,
            maxY = 0;
          let found = false;

          for (const ln of linesInList) {
            const bb = Array.isArray(ln?.bbox)
              ? (ln.bbox as [number, number, number, number])
              : null;
            if (!bb) continue;
            const t = normBoxFromPixels(bb, pageW, pageH);
            if (!t) continue;
            found = true;
            minX = Math.min(minX, t.x);
            minY = Math.min(minY, t.y);
            maxX = Math.max(maxX, t.x + t.w);
            maxY = Math.max(maxY, t.y + t.h);
          }

          if (found) {
            const w = Math.max(0, maxX - minX);
            const h = Math.max(0, maxY - minY);
            if (w > 0 && h > 0) nb = { x: minX, y: minY, w, h, area: w * h };
          }
        }

        if (!nb) continue;

        out.push({
          pageKey: pk,
          pageNum,
          label: "List",
          confPct: c * 100,
          targetPid: pid,
          box: { x: nb.x, y: nb.y, w: nb.w, h: nb.h },
        });
      }

      // -----------------
      // TABLE blocks (class === "table")
      // -----------------
      const tables: any[] = Array.isArray(pageObj.tables) ? pageObj.tables : [];
      for (let tIdx = 0; tIdx < tables.length; tIdx++) {
        const tbl: any = tables[tIdx];
        const cls = String(tbl?.class ?? "");
        if (cls !== "table") continue;

        const c = Number(tbl?.confidence);
        if (!Number.isFinite(c) || c >= TH) continue;

        const pid = `table-${tIdx}`;

        let nb: {
          x: number;
          y: number;
          w: number;
          h: number;
          area: number;
        } | null = null;

        if (Array.isArray(tbl?.bbox) && tbl.bbox.length === 4) {
          nb = normBoxFromPixels(
            tbl.bbox as [number, number, number, number],
            pageW,
            pageH,
          );
        } else {
          const linesInTable: any[] = Array.isArray(tbl?.lines)
            ? tbl.lines
            : [];
          let minX = 1,
            minY = 1,
            maxX = 0,
            maxY = 0;
          let found = false;

          for (const ln of linesInTable) {
            const bb = Array.isArray(ln?.bbox)
              ? (ln.bbox as [number, number, number, number])
              : null;
            if (!bb) continue;
            const t = normBoxFromPixels(bb, pageW, pageH);
            if (!t) continue;
            found = true;
            minX = Math.min(minX, t.x);
            minY = Math.min(minY, t.y);
            maxX = Math.max(maxX, t.x + t.w);
            maxY = Math.max(maxY, t.y + t.h);
          }

          if (found) {
            const w = Math.max(0, maxX - minX);
            const h = Math.max(0, maxY - minY);
            if (w > 0 && h > 0) nb = { x: minX, y: minY, w, h, area: w * h };
          }
        }

        if (!nb) continue;

        out.push({
          pageKey: pk,
          pageNum,
          label: "Table",
          confPct: c * 100,
          targetPid: pid,
          box: { x: nb.x, y: nb.y, w: nb.w, h: nb.h },
        });
      }
    }

    // Sort: page asc, then Paragraph/List/Table, then lowest confidence first
    out.sort((a, b) => {
      const ap = a.pageNum ?? 1e9;
      const bp = b.pageNum ?? 1e9;
      if (ap !== bp) return ap - bp;

      const order = (lbl: string) =>
        lbl === "Paragraph" ? 0 : lbl === "List" ? 1 : 2;
      const ao = order(a.label);
      const bo = order(b.label);
      if (ao !== bo) return ao - bo;

      return a.confPct - b.confPct;
    });

    return out;
  }, [doc]);

  const lowConfByPid = useMemo(() => {
    const by: Record<
      string,
      {
        label: string;
        confPct: number;
        predicted_class: string;
        predicted_confidence: number;
      }
    > = {};

    for (const it of lowConfItems) {
      if (!pageKey || it.pageKey !== pageKey) continue;
      by[it.targetPid] = {
        label: it.label,
        confPct: it.confPct,
        predicted_class: it.label,
        predicted_confidence: Math.max(0, Math.min(1, it.confPct / 100)),
      };
    }

    return by;
  }, [lowConfItems, pageKey]);

  useEffect(() => {
    // These stats are shown on the welcome page as soon as we have the JSON/PDF.
    const pages =
      pdf?.numPages ??
      (doc
        ? Object.keys(doc).filter((k) => pageKeyToNumber(k) != null).length
        : null);

    let lines: number | null = null;
    if (doc) {
      let c = 0;
      for (const k of Object.keys(doc)) {
        const p = doc[k];
        if (!p) continue;
        c += getAllLinesForPage(p).length;
      }
      lines = c;
    }

    setWelcomeStats((prev) => ({
      ...prev,
      pages: typeof pages === "number" ? pages : prev.pages,
      lines: typeof lines === "number" ? lines : prev.lines,
    }));
  }, [doc, pdf]);

  useEffect(() => {
    if (!pageKeys.length) return;
    if (!pageKey || !pageKeys.includes(pageKey)) {
      setPageKey(pageKeys[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKeys]);

  async function loadMapDocOptions(): Promise<MapDocOption[]> {
    if (!supabase) return [];
    setIsLoadingMap(true);
    setMapError(null);

    try {
      const { data, error } = await supabase
        .from("documents")
        .select("id,title")
        .limit(5000);

      if (error) throw error;

      const docs: MapDocOption[] = (data ?? [])
        .map((r: any) => ({
          id: String(r?.id ?? ""),
          title: String(r?.title ?? "").trim() || "(Untitled)",
        }))
        .filter((d) => d.id);

      setMapDocOptions(docs);

      if (docs.length) {
        setSelectedMapDocId((cur) => {
          // Preserve the special ALL selection if already chosen.
          if (cur === "__ALL__") return cur;

          // Keep current selection if it still exists; otherwise default to ALL.
          if (cur && docs.some((d) => d.id === cur)) return cur;

          return "__ALL__";
        });
      } else {
        // Still allow selecting ALL even if there are no documents returned.
        setSelectedMapDocId("__ALL__");
      }
      return docs;
    } catch (e: any) {
      console.warn("map docs load failed", e);
      setMapError(e?.message || String(e));
      setMapDocOptions([]);
      setSelectedMapDocId("");
      return [];
    } finally {
      setIsLoadingMap(false);
    }
  }

  async function loadLocationsForDoc(docId: string): Promise<DocLocation[]> {
    if (!supabase) return [];
    if (!docId) {
      setMapLocations([]);
      return [];
    }

    setIsLoadingMap(true);
    setMapError(null);

    try {
      const { data, error } = await supabase
        .from("document_locations")
        .select("id,document_id,seq,label,lat,lng,note")
        .eq("document_id", docId)
        .order("seq", { ascending: true })
        .limit(2000);

      if (error) throw error;

      const locs: DocLocation[] = (data ?? [])
        .map((r: any) => ({
          id: String(r?.id ?? ""),
          document_id: String(r?.document_id ?? ""),
          seq: Number(r?.seq ?? 0),
          label: r?.label == null ? null : String(r.label),
          lat: Number(r?.lat),
          lng: Number(r?.lng),
          note: r?.note == null ? null : String(r.note),
        }))
        .filter(
          (d) =>
            d.id &&
            d.document_id &&
            Number.isFinite(d.lat) &&
            Number.isFinite(d.lng),
        );

      setMapLocations(locs);
      return locs;
    } catch (e: any) {
      console.warn("map locations load failed", e);
      setMapError(e?.message || String(e));
      setMapLocations([]);
      return [];
    } finally {
      setIsLoadingMap(false);
    }
  }

  async function loadLocationsForViewer(docId: string): Promise<DocLocation[]> {
    if (!supabase) return [];
    if (!docId) {
      setViewerLocations([]);
      return [];
    }

    try {
      const { data, error } = await supabase
        .from("document_locations")
        .select("id,document_id,seq,label,lat,lng,note")
        .eq("document_id", docId)
        .order("seq", { ascending: true })
        .limit(2000);

      if (error) throw error;

      const locs: DocLocation[] = (data ?? [])
        .map((r: any) => ({
          id: String(r?.id ?? ""),
          document_id: String(r?.document_id ?? ""),
          seq: Number(r?.seq ?? 0),
          label: r?.label == null ? null : String(r.label),
          lat: Number(r?.lat),
          lng: Number(r?.lng),
          note: r?.note == null ? null : String(r.note),
        }))
        .filter(
          (d) =>
            d.id &&
            d.document_id &&
            Number.isFinite(d.lat) &&
            Number.isFinite(d.lng),
        );

      setViewerLocations(locs);
      return locs;
    } catch (e) {
      console.warn("viewer locations load failed", e);
      setViewerLocations([]);
      return [];
    }
  }

  async function loadAggregatedLocationsAllDocs(): Promise<
    AggregatedLocation[]
  > {
    if (!supabase) return [];

    setIsLoadingMap(true);
    setMapError(null);

    try {
      const { data, error } = await supabase
        .from("document_locations")
        .select("document_id,lat,lng")
        .limit(20000);

      if (error) throw error;

      const rows = (data ?? []) as any[];

      // group by rounded lat/lng to avoid float-key mismatch
      const keyOf = (lat: number, lng: number) =>
        `${lat.toFixed(5)},${lng.toFixed(5)}`;

      const groups: Record<
        string,
        { lat: number; lng: number; docIds: Set<string> }
      > = {};

      for (const r of rows) {
        const docId = String(r?.document_id ?? "");
        const lat = Number(r?.lat);
        const lng = Number(r?.lng);
        if (!docId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const k = keyOf(lat, lng);
        if (!groups[k]) groups[k] = { lat, lng, docIds: new Set<string>() };
        groups[k].docIds.add(docId);
      }

      const allDocIds = Array.from(
        new Set(Object.values(groups).flatMap((g) => Array.from(g.docIds))),
      );

      const titleById: Record<string, string> = {};
      if (allDocIds.length) {
        const { data: docs, error: dErr } = await supabase
          .from("documents")
          .select("id,title")
          .in("id", allDocIds);

        if (!dErr && docs) {
          for (const d of docs as any[]) {
            const id = String(d?.id ?? "");
            const title = String(d?.title ?? "").trim();
            if (id) titleById[id] = title || "(Untitled)";
          }
        }
      }

      const out: AggregatedLocation[] = Object.entries(groups).map(([k, g]) => {
        const ids = Array.from(g.docIds);
        const titles = ids
          .map((id) => titleById[id] || id)
          .sort((a, b) => a.localeCompare(b));
        return {
          key: k,
          lat: g.lat,
          lng: g.lng,
          doc_count: ids.length,
          doc_ids: ids,
          doc_titles: titles,
        };
      });

      out.sort((a, b) => b.doc_count - a.doc_count);

      setMapAggLocations(out);
      return out;
    } catch (e: any) {
      console.warn("map aggregated locations load failed", e);
      setMapError(e?.message || String(e));
      setMapAggLocations([]);
      return [];
    } finally {
      setIsLoadingMap(false);
    }
  }

  function openLocationModalForCurrentPage() {
    if (!doc || !pageKey || !doc[pageKey]) {
      alert("This page has no transcription, so locations can’t be added.");
      return;
    }
    // Require auth for editing/adding locations
    if (!user) {
      setShowSignin(true);
      return;
    }

    const seq = pageKeyToNumber(pageKey);
    if (seq == null) {
      alert("Could not determine page number for this page.");
      return;
    }
    const existing = viewerLocations.find((l) => l.seq === seq) ?? null;

    setLocLabel(existing?.label ?? "");
    setLocLat(
      existing && Number.isFinite(existing.lat) ? String(existing.lat) : "",
    );
    setLocLng(
      existing && Number.isFinite(existing.lng) ? String(existing.lng) : "",
    );
    setLocNote(existing?.note ?? "");

    setShowAddLocation(true);
  }

  async function saveLocationForCurrentPage() {
    if (!doc || !pageKey || !doc[pageKey]) {
      return alert(
        "This page has no transcription, so locations can’t be saved.",
      );
    }
    if (!supabase)
      return alert("Missing Supabase env vars on this deployment.");
    if (!DOCUMENT_ID)
      return alert("Missing NEXT_PUBLIC_DOCUMENT_ID in .env.local");
    if (!user) return alert("Please sign in to add locations.");

    const seq = pageKeyToNumber(pageKey);
    if (seq == null)
      return alert("Could not determine page number for this page.");

    const lat = Number(locLat);
    const lng = Number(locLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return alert("Please enter valid latitude and longitude.");
    }

    const label = locLabel.trim() || null;
    const note = locNote.trim() || null;

    setIsSavingLocation(true);
    try {
      let row: any = null;

      // Preferred: upsert by (document_id, seq) IF a unique constraint exists.
      const up = await supabase
        .from("document_locations")
        .upsert(
          { document_id: DOCUMENT_ID, seq, label, lat, lng, note },
          { onConflict: "document_id,seq" },
        )
        .select("id,document_id,seq,label,lat,lng,note")
        .maybeSingle();

      if (!up.error) {
        row = up.data;
      } else {
        // If no unique constraint / onConflict not allowed, fall back to insert.
        const msg = String(up.error.message || up.error);
        const looksLikeNoConstraint =
          /on\s*conflict/i.test(msg) ||
          /there is no unique|no unique constraint|no unique or exclusion constraint|constraint/i.test(
            msg,
          );

        if (!looksLikeNoConstraint) throw up.error;

        const ins = await supabase
          .from("document_locations")
          .insert({ document_id: DOCUMENT_ID, seq, label, lat, lng, note })
          .select("id,document_id,seq,label,lat,lng,note")
          .maybeSingle();

        if (!ins.error) {
          row = ins.data;
        } else {
          // If duplicate exists but we couldn't upsert, do an update.
          const msg2 = String(ins.error.message || ins.error);
          const looksDuplicate = /duplicate|already exists|unique/i.test(msg2);
          if (!looksDuplicate) throw ins.error;

          const upd = await supabase
            .from("document_locations")
            .update({ label, lat, lng, note })
            .eq("document_id", DOCUMENT_ID)
            .eq("seq", seq)
            .select("id,document_id,seq,label,lat,lng,note")
            .maybeSingle();

          if (upd.error) throw upd.error;
          row = upd.data;
        }
      }

      // Close modal + clear inputs
      setShowAddLocation(false);
      setLocLabel("");
      setLocLat("");
      setLocLng("");
      setLocNote("");

      // Update local state list
      if (row) {
        setMapLocations((prev) => {
          const next = prev.filter(
            (x) => !(x.document_id === row.document_id && x.seq === row.seq),
          );
          next.push({
            id: String((row as any).id ?? ""),
            document_id: String((row as any).document_id ?? ""),
            seq: Number((row as any).seq ?? seq),
            label:
              (row as any).label == null ? null : String((row as any).label),
            lat: Number((row as any).lat),
            lng: Number((row as any).lng),
            note: (row as any).note == null ? null : String((row as any).note),
          });
          next.sort((a, b) => a.seq - b.seq);
          return next;
        });
        setViewerLocations((prev) => {
          const next = prev.filter(
            (x) => !(x.document_id === row.document_id && x.seq === row.seq),
          );
          next.push({
            id: String((row as any).id ?? ""),
            document_id: String((row as any).document_id ?? ""),
            seq: Number((row as any).seq ?? seq),
            label:
              (row as any).label == null ? null : String((row as any).label),
            lat: Number((row as any).lat),
            lng: Number((row as any).lng),
            note: (row as any).note == null ? null : String((row as any).note),
          });
          next.sort((a, b) => a.seq - b.seq);
          return next;
        });
      }

      if (viewMode === "map") {
        const docId = selectedMapDocId || DOCUMENT_ID;

        if (docId === "__ALL__") {
          const aggs = await loadAggregatedLocationsAllDocs();
          renderMapAggregates(aggs);
        } else {
          const locs = await loadLocationsForDoc(docId);
          renderMapTrail(locs);
        }
      }

      alert(`Saved location for page ${seq}.`);
    } catch (e: any) {
      console.warn("save location failed", e);
      alert(e?.message || String(e));
    } finally {
      setIsSavingLocation(false);
    }
  }

  function renderMapAggregates(locs: AggregatedLocation[]) {
    const L = (window as any).L;
    const map = leafletMapRef.current;
    if (!L || !map) return;

    // clear markers
    if (leafletLayerRef.current) {
      try {
        leafletLayerRef.current.clearLayers();
      } catch {}
    } else {
      leafletLayerRef.current = L.layerGroup().addTo(map);
    }

    // no polyline for aggregates
    if (leafletPolylineRef.current) {
      try {
        leafletPolylineRef.current.remove();
      } catch {}
      leafletPolylineRef.current = null;
    }

    const pts: any[] = [];

    for (const d of locs) {
      const lat = Number(d.lat);
      const lng = Number(d.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      pts.push([lat, lng]);

      const count = Math.max(1, Number(d.doc_count || 0));

      const tooltipHtml = `<div style="font-weight:900;">${count} file${count === 1 ? "" : "s"}</div>`;

      const listHtml = (d.doc_titles || [])
        .slice(0, 15)
        .map((t) => String(t).replace(/</g, "&lt;"))
        .join("<br/>");

      const more =
        (d.doc_titles || []).length > 15
          ? `<br/><div style="opacity:0.75;">+${(d.doc_titles || []).length - 15} more</div>`
          : "";

      const popupHtml = `<b>${count} file${count === 1 ? "" : "s"} at this location</b>${
        listHtml ? `<div style="margin-top:6px;">${listHtml}${more}</div>` : ""
      }`;

      const icon = L.divIcon({
        className: "",
        html: `<div style="width:30px;height:30px;border-radius:999px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.25);border:2px solid rgba(255,255,255,0.9);">${count}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });

      const m = L.marker([lat, lng], { icon });
      m.bindTooltip(tooltipHtml, {
        direction: "top",
        offset: [0, -14],
        opacity: 0.95,
        sticky: true,
      });
      m.bindPopup(popupHtml);
      m.addTo(leafletLayerRef.current);
    }

    if (pts.length) {
      const b = L.latLngBounds(pts);
      map.fitBounds(b, { padding: [30, 30] });
    } else {
      map.setView([20, 0], 2);
    }

    try {
      map.invalidateSize?.();
    } catch {}
  }

  function renderMapTrail(locs: DocLocation[]) {
    const L = (window as any).L;
    const map = leafletMapRef.current;
    if (!L || !map) return;

    // clear markers
    if (leafletLayerRef.current) {
      try {
        leafletLayerRef.current.clearLayers();
      } catch {}
    } else {
      leafletLayerRef.current = L.layerGroup().addTo(map);
    }

    // clear existing polyline
    if (leafletPolylineRef.current) {
      try {
        leafletPolylineRef.current.remove();
      } catch {}
      leafletPolylineRef.current = null;
    }

    // add markers + polyline
    const pts: any[] = [];

    let displayIdx = 0;

    for (const d of locs) {
      const lat = Number(d.lat);
      const lng = Number(d.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      // Marker number should be the sequence within this document (1..N), NOT the page number.
      displayIdx += 1;
      const markerNo = displayIdx;

      pts.push([lat, lng]);

      const title = (d.label || "Location").replace(/</g, "&lt;");
      const note = (d.note || "").replace(/</g, "&lt;");

      // Hover tooltip should show: Page: <pageNumber> and the label
      const tooltipHtml = `<div style="font-weight:900;">Page: ${d.seq} • ${title}</div>`;

      // Popup can include marker number + page + label (+ optional note)
      const popupHtml = `<b>#${markerNo} • Page ${d.seq}: ${title}</b>${note ? `<br/>${note}` : ""}`;

      const icon = L.divIcon({
        className: "",
        html: `<div style="width:28px;height:28px;border-radius:999px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.25);border:2px solid rgba(255,255,255,0.9);">${markerNo}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const m = L.marker([lat, lng], { icon });
      m.bindPopup(popupHtml);
      m.bindTooltip(tooltipHtml, {
        direction: "top",
        offset: [0, -14],
        opacity: 0.95,
        sticky: true,
      });
      m.addTo(leafletLayerRef.current);
    }

    if (pts.length >= 2) {
      leafletPolylineRef.current = L.polyline(pts, {
        weight: 3,
        opacity: 0.85,
      }).addTo(map);
    }

    if (pts.length) {
      const b = L.latLngBounds(pts);
      map.fitBounds(b, { padding: [30, 30] });
    } else {
      map.setView([20, 0], 2);
    }

    try {
      map.invalidateSize?.();
    } catch {}
  }

  async function loadSuggestionsForPage(docId: string, pk: string) {
    if (!supabase) return;
    if (!docId || !pk) return;
    setIsLoadingSuggestions(true);
    try {
      const { data, error } = await supabase
        .from("suggestions")
        .select(
          "id,document_id,page_key,uid,suggested_text,comment,user_id,created_at,author_username,suggestion_votes(count)",
        )
        .eq("document_id", docId)
        .eq("page_key", pk);

      if (error) throw error;

      const grouped: Record<string, SuggestionRow[]> = {};

      (data ?? []).forEach((row: any) => {
        const uid = String(row.uid);

        const voteCount =
          Array.isArray(row.suggestion_votes) && row.suggestion_votes.length
            ? Number(row.suggestion_votes[0].count ?? 0)
            : 0;

        const s: SuggestionRow = {
          id: row.id,
          document_id: row.document_id,
          page_key: row.page_key,
          uid,
          suggested_text: row.suggested_text,
          comment: row.comment ?? null,
          user_id: row.user_id,
          created_at: row.created_at,
          vote_count: voteCount,
          author_username: row.author_username ?? null,
        };

        if (!grouped[uid]) grouped[uid] = [];
        grouped[uid].push(s);
      });

      // Sort: votes desc, then newest first
      for (const k of Object.keys(grouped)) {
        grouped[k].sort((a, b) => {
          const va = a.vote_count ?? 0;
          const vb = b.vote_count ?? 0;
          if (vb !== va) return vb - va;
          return (
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
        });
      }

      setSuggestionsByUid(grouped);

      // Fetch usernames for any user_ids we haven't cached yet
      const userIds = Array.from(
        new Set(
          (data ?? [])
            .map((r: any) => String(r.user_id || ""))
            .filter((x: string) => x.length > 0),
        ),
      );

      // Treat "missing" as: we don't have a non-empty username cached yet
      const missing = userIds.filter(
        (id) => !usernameByUserId[id]?.trim()?.length,
      );

      if (missing.length) {
        const { data: profs, error: pErr } = await supabase
          .from("profiles")
          .select("id, username")
          .in("id", missing);

        if (!pErr && profs) {
          setUsernameByUserId((prev) => {
            const next = { ...prev };
            for (const p of profs as any[]) {
              const id = String(p?.id || "");
              const uname = String(p?.username || "").trim();
              // Only cache non-empty usernames; otherwise keep it "missing" so we can backfill later
              if (id && uname) next[id] = uname;
            }
            return next;
          });
        } else if (pErr) {
          console.warn("profiles select failed", pErr);
        }
      }
    } catch (e) {
      console.warn(e);
      setSuggestionsByUid({});
    } finally {
      setIsLoadingSuggestions(false);
    }
  }

  async function submitSuggestion(uid: string, originalText: string) {
    if (!user) return alert("Please sign in to suggest edits.");
    if (!supabase)
      return alert("Missing Supabase env vars on this deployment.");
    if (!DOCUMENT_ID)
      return alert("Missing NEXT_PUBLIC_DOCUMENT_ID in .env.local");
    if (!pageKey) return;

    const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

    const text = normalizeText(suggestText);
    if (!text) return;

    const original = normalizeText(originalText || "");
    if (text === original)
      return alert(
        "Your suggestion is identical to the current transcription.",
      );

    const unameSnapshot =
      (usernameByUserId[user.id] && usernameByUserId[user.id].trim()) ||
      (user.email ? user.email.split("@")[0] : "") ||
      `user_${user.id.slice(0, 6)}`;

    const comment = suggestComment.trim();

    const { error } = await supabase.from("suggestions").insert({
      document_id: DOCUMENT_ID,
      page_key: pageKey,
      uid,
      suggested_text: text,
      comment: comment ? comment : null,
      user_id: user.id,
      author_username: unameSnapshot,
    });

    if (error) return alert(error.message);

    setOpenSuggestUid(null);
    setSuggestText("");
    setSuggestComment("");
    await loadSuggestionsForPage(DOCUMENT_ID, pageKey);
  }

  useEffect(() => {
    if (!supabase) return;
    if (!DOCUMENT_ID) return;

    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase
          .from("low_conf_labels")
          .select("*")
          .eq("document_id", DOCUMENT_ID)
          .limit(10000);

        if (error) throw error;
        if (cancelled) return;

        const next: Record<
          string,
          {
            corrected_class: "Paragraph" | "List" | "Table" | "Other";
            other_text: string;
            author_username?: string;
            user_id?: string;
            updated_at?: string;
          }
        > = {};

        for (const r of (data ?? []) as any[]) {
          const pk = String(r?.page_key ?? "");
          const tp = String(r?.target_pid ?? "");
          if (!pk || !tp) continue;

          const key = `${pk}|${tp}`;
          const cls = String(r?.corrected_class ?? "Other") as any;

          next[key] = {
            corrected_class: cls,
            other_text: String(r?.other_text ?? ""),
            author_username: String(r?.author_username ?? "") || undefined,
            user_id: String(r?.user_id ?? "") || undefined,
            updated_at: String(r?.updated_at ?? "") || undefined,
          };
        }

        setLowConfLabelsByKey(next);
        // Also hydrate any previously saved corrected bboxn so it shows immediately
        const drawnNext: Record<
          string,
          { x: number; y: number; w: number; h: number }
        > = {};

        for (const r of (data ?? []) as any[]) {
          const pk = String(r?.page_key ?? "");
          const tp = String(r?.target_pid ?? "");
          if (!pk || !tp) continue;

          const bbN = r?.corrected_bboxn;
          if (Array.isArray(bbN) && bbN.length === 4) {
            const x1 = Number(bbN[0]);
            const y1 = Number(bbN[1]);
            const x2 = Number(bbN[2]);
            const y2 = Number(bbN[3]);

            if ([x1, y1, x2, y2].every((v) => Number.isFinite(v))) {
              const xMin = Math.min(x1, x2);
              const xMax = Math.max(x1, x2);
              const yMin = Math.min(y1, y2);
              const yMax = Math.max(y1, y2);
              const w = Math.max(0, xMax - xMin);
              const h = Math.max(0, yMax - yMin);

              if (w > 0 && h > 0) {
                drawnNext[`${pk}|${tp}`] = {
                  x: Math.min(1, Math.max(0, xMin)),
                  y: Math.min(1, Math.max(0, yMin)),
                  w: Math.min(1, Math.max(0, w)),
                  h: Math.min(1, Math.max(0, h)),
                };
              }
            }
          }
        }

        setLowConfDrawnBoxByKey((prev) => ({ ...prev, ...drawnNext }));
      } catch (e) {
        console.warn("low_conf_labels load failed", e);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, DOCUMENT_ID]);

  async function saveLowConfLabel(args: {
    page_key: string;
    target_pid: string;
    predicted_class: string;
    predicted_confidence: number; // 0..1
    corrected_class: "Paragraph" | "List" | "Table" | "Other";
    other_text: string;
  }) {
    if (!supabase)
      return alert("Missing Supabase env vars on this deployment.");
    if (!DOCUMENT_ID)
      return alert("Missing NEXT_PUBLIC_DOCUMENT_ID in .env.local");
    if (!user) return alert("Please sign in to save labels.");

    const unameSnapshot =
      (usernameByUserId[user.id] && usernameByUserId[user.id].trim()) ||
      (user.email ? user.email.split("@")[0] : "") ||
      `user_${user.id.slice(0, 6)}`;

    const drawnKey = `${args.page_key}|${args.target_pid}`;
    const drawn = lowConfDrawnBoxByKey[drawnKey] ?? null;

    // Convert drawn box into bboxn (normalized) and bbox (pixel) if we have page dims.
    let corrected_bboxn: [number, number, number, number] | null = null;
    let corrected_bbox: [number, number, number, number] | null = null;

    if (drawn) {
      corrected_bboxn = boxToBboxn(drawn);

      const pageObj: any = (doc as any)?.[args.page_key];
      const pageW = Number(pageObj?.width);
      const pageH = Number(pageObj?.height);

      if (
        Number.isFinite(pageW) &&
        Number.isFinite(pageH) &&
        pageW > 0 &&
        pageH > 0
      ) {
        corrected_bbox = bboxFromBox(drawn, pageW, pageH);
      }
    }

    const basePayload: any = {
      document_id: DOCUMENT_ID,
      page_key: args.page_key,
      target_pid: args.target_pid,
      predicted_class: args.predicted_class,
      predicted_confidence: args.predicted_confidence,
      corrected_class: args.corrected_class,
      // NOTE: if the DB doesn't yet have corrected_bbox / corrected_bboxn columns,
      // we will fall back to storing the drawn box in other_text (see retry below).
      other_text: args.other_text ? args.other_text.trim() : null,
      user_id: user.id,
      author_username: unameSnapshot,
      updated_at: new Date().toISOString(),
    };

    // Try to include corrected bbox fields if the table has them.
    // Some deployments may not have these columns yet; if PostgREST complains,
    // retry the upsert without the bbox fields.
    const payloadWithBoxes: any = {
      ...basePayload,
      ...(corrected_bboxn ? { corrected_bboxn } : {}),
      ...(corrected_bbox ? { corrected_bbox } : {}),
    };

    let data: any = null;
    let error: any = null;

    // First attempt (with bbox fields if available)
    {
      const res = await supabase
        .from("low_conf_labels")
        .upsert(payloadWithBoxes, {
          onConflict: "document_id,page_key,target_pid",
        })
        .select("*")
        .maybeSingle();
      data = res.data;
      error = res.error;
    }

    // If the table doesn't have bbox columns, retry without them.
    // BUT still persist the drawn box by embedding it into other_text so no work is lost.
    if (
      error &&
      /corrected_bboxn|corrected_bbox/i.test(String(error.message || error))
    ) {
      const baseOther = (args.other_text ? args.other_text.trim() : "").trim();

      // Store bbox info in other_text in a parseable way.
      // (You can migrate it to real columns later without losing data.)
      const boxNote = corrected_bboxn
        ? `\n\n__corrected_bboxn__=${JSON.stringify(corrected_bboxn)}\n__corrected_bbox__=${
            corrected_bbox ? JSON.stringify(corrected_bbox) : "null"
          }`
        : "";

      const fallbackOther = (baseOther + boxNote).trim() || null;

      const res2 = await supabase
        .from("low_conf_labels")
        .upsert(
          { ...basePayload, other_text: fallbackOther },
          { onConflict: "document_id,page_key,target_pid" },
        )
        .select("*")
        .maybeSingle();
      data = res2.data;
      error = res2.error;
    }

    if (error) {
      console.warn("low_conf_labels upsert failed", error);
      return alert(error.message || String(error));
    }

    const key = `${args.page_key}|${args.target_pid}`;
    setLowConfLabelsByKey((prev) => ({
      ...prev,
      [key]: {
        corrected_class: data?.corrected_class ?? args.corrected_class,
        other_text: String(data?.other_text ?? args.other_text ?? ""),
        author_username:
          String(data?.author_username ?? unameSnapshot) || undefined,
        user_id: String(data?.user_id ?? user.id) || undefined,
        updated_at:
          String(data?.updated_at ?? basePayload.updated_at) || undefined,
      },
    }));
  }

  async function ensureProfileUsername(
    userId: string,
    fallbackEmail?: string | null,
  ) {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.warn("profiles select failed", error);
      return;
    }

    if (data?.username) {
      setUsernameByUserId((prev) => ({ ...prev, [userId]: data.username }));
      return;
    }

    // No profile row (or username empty) -> create one using a fallback
    const fallback =
      (fallbackEmail?.split("@")[0] ?? "").trim() ||
      `user_${userId.slice(0, 6)}`;

    const { error: upsertErr } = await supabase
      .from("profiles")
      .upsert({ id: userId, username: fallback }, { onConflict: "id" });

    if (upsertErr) {
      console.warn("profiles upsert failed", upsertErr);
      return;
    }

    setUsernameByUserId((prev) => ({ ...prev, [userId]: fallback }));
  }

  async function upvoteSuggestion(suggestionId: string) {
    if (!user) return alert("Please sign in to vote.");
    if (!supabase)
      return alert("Missing Supabase env vars on this deployment.");

    const { error } = await supabase.from("suggestion_votes").upsert(
      {
        suggestion_id: suggestionId,
        user_id: user.id,
        vote: 1,
      },
      { onConflict: "suggestion_id,user_id" },
    );

    if (error) return alert(error.message);

    await loadSuggestionsForPage(DOCUMENT_ID, pageKey);
  }

  async function loadLeaderboard() {
    if (!supabase) return;
    setIsLoadingLeaderboard(true);
    try {
      // Requires FK: suggestion_votes.suggestion_id -> suggestions.id
      const { data, error } = await supabase
        .from("suggestion_votes")
        .select("vote, suggestion:suggestions(user_id, author_username)")
        .limit(10000);

      if (error) throw error;

      const totals: Record<string, { upvotes: number; username: string }> = {};

      for (const row of (data ?? []) as any[]) {
        const vote = Number(row?.vote ?? 0);
        if (vote !== 1) continue;

        const sug = row?.suggestion;
        const uid = String(sug?.user_id ?? "");
        if (!uid) continue;

        const snap = String(sug?.author_username ?? "").trim();
        if (!totals[uid]) totals[uid] = { upvotes: 0, username: snap };
        totals[uid].upvotes += 1;
        if (!totals[uid].username && snap) totals[uid].username = snap;
      }

      let arr = Object.entries(totals)
        .map(([user_id, v]) => ({
          user_id,
          upvotes: v.upvotes,
          username: v.username || "",
        }))
        .sort((a, b) => b.upvotes - a.upvotes)
        .slice(0, 10);

      // Enrich with profiles usernames
      const ids = arr.map((r) => r.user_id);
      if (ids.length) {
        const { data: profs, error: pErr } = await supabase
          .from("profiles")
          .select("id, username")
          .in("id", ids);
        if (!pErr && profs) {
          const byId: Record<string, string> = {};
          for (const p of profs as any[]) {
            const id = String(p?.id ?? "");
            const uname = String(p?.username ?? "").trim();
            if (id && uname) byId[id] = uname;
          }
          arr = arr.map((r) => ({
            ...r,
            username:
              byId[r.user_id] || r.username || `user:${r.user_id.slice(0, 8)}`,
          }));
        }
      }

      arr = arr.map((r) => ({
        ...r,
        username: r.username || `user:${r.user_id.slice(0, 8)}`,
      }));
      setLeaderboardRows(arr);
    } catch (e) {
      console.warn("leaderboard load failed", e);
      setLeaderboardRows([]);
    } finally {
      setIsLoadingLeaderboard(false);
    }
  }

  const clampZoom = (z: number) => Math.max(0.5, Math.min(5, z));
  const zoomIn = () => setZoom((z) => clampZoom(Number((z * 1.15).toFixed(4))));
  const zoomOut = () =>
    setZoom((z) => clampZoom(Number((z / 1.15).toFixed(4))));
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
    // Allow deep-linking directly into the viewer and support Back/Forward.
    if (typeof window === "undefined") return;

    const syncFromUrl = () => {
      const sp = new URLSearchParams(window.location.search);
      setStarted(sp.get("start") === "1");
    };

    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  async function loadDocAndPdf() {
    if (!PDF_URL || !JSON_URL) {
      setFatalError(
        "Missing NEXT_PUBLIC_PDF_URL or NEXT_PUBLIC_JSON_URL. Set these in Vercel → Project → Settings → Environment Variables.",
      );
      return;
    }

    // Reset viewer state so entering the viewer always triggers a clean render
    setFatalError(null);
    setDoc(null);
    setPdf(null);

    const r = await fetch(JSON_URL);
    if (!r.ok) throw new Error(`JSON fetch failed: ${r.status}`);
    const j = (await r.json()) as DocJson;
    setDoc(j);

    const firstValid =
      Object.keys(j).find((k) => pageKeyToNumber(k) != null) ??
      Object.keys(j)[0];
    setPageKey(firstValid);

    // Dynamically import pdf.js on the client only.
    // NOTE: importing the package root keeps TypeScript happy (the legacy subpath often has no .d.ts).
    const pdfjsLib: any = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();

    const loaded = await pdfjsLib.getDocument(PDF_URL).promise;
    setPdf(loaded);
  }

  useEffect(() => {
    // Only load heavy viewer assets once the user enters the viewer.
    if (!started) return;

    loadDocAndPdf().catch((e) => {
      console.error(e);
      setFatalError(e?.message || String(e));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, PDF_URL, JSON_URL]);

  useEffect(() => {
    if (!supabase) return;
    // auth
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      setUser(u ? { id: u.id, email: u.email ?? null } : null);
      if (u?.id) ensureProfileUsername(u.id, u.email);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const u = session?.user;
      setUser(u ? { id: u.id, email: u.email ?? null } : null);
      if (u?.id) ensureProfileUsername(u.id, u.email);
    });

    // document title
    (async () => {
      try {
        if (!DOCUMENT_ID) return;
        const { data, error } = await supabase
          .from("documents")
          .select("title")
          .eq("id", DOCUMENT_ID)
          .maybeSingle();
        if (error) throw error;
        const t = (data?.title ?? "").toString().trim();
        if (t) setDocumentTitle(t);
      } catch (e) {
        console.warn("documents title fetch failed", e);
      }
    })();

    // viewer locations (for showing the current page location in the header)
    (async () => {
      try {
        if (!DOCUMENT_ID) return;
        await loadLocationsForViewer(DOCUMENT_ID);
      } catch (e) {
        console.warn("viewer locations init failed", e);
      }
    })();

    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signUp() {
    if (!supabase)
      return alert("Missing Supabase env vars on this deployment.");
    // If the user typed an email in the sign-in modal and signupEmail is empty, reuse it.
    if (!signupEmail.trim() && signinId.trim().includes("@")) {
      setSignupEmail(signinId.trim());
    }
    const email = signupEmail.trim();
    const uname = signupUsername.trim();
    const password = signupPw;

    if (!email.includes("@")) return alert("Please enter an email to sign up.");
    if (!uname) return alert("Please choose a username.");
    if (!password) return alert("Please enter a password.");

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { username: uname } },
    });

    if (error) return alert(error.message);

    const newUserId = data.user?.id;
    if (newUserId) {
      const { error: pErr } = await supabase
        .from("profiles")
        .upsert(
          { id: newUserId, username: uname, email },
          { onConflict: "id" },
        );

      if (pErr) console.warn("profiles upsert failed", pErr);

      setUsernameByUserId((prev) => ({ ...prev, [newUserId]: uname }));
    }

    setSignupPw("");
    setShowSignup(false);
    alert(
      "Signed up. If email confirmation is enabled, confirm your email, then sign in.",
    );
  }

  async function signIn() {
    if (!supabase)
      return alert("Missing Supabase env vars on this deployment.");
    const id = signinId.trim();
    if (!id) return alert("Enter your username or email.");

    let emailToUse = id;

    // If it doesn't look like an email, treat as username and look up email
    if (!id.includes("@")) {
      const { data: prof, error: pErr } = await supabase
        .from("profiles")
        .select("email")
        .ilike("username", id)
        .maybeSingle();

      if (pErr) return alert(pErr.message);
      if (!prof?.email)
        return alert(
          "No account found for that username (or missing email in profiles).",
        );

      emailToUse = prof.email;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: emailToUse,
      password: signinPw,
    });

    if (error) return alert(error.message);
    setShowSignin(false);
    setSigninPw("");

    const { data } = await supabase.auth.getUser();
    if (data.user?.id) ensureProfileUsername(data.user.id, data.user.email);
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  async function forgotPassword() {
    if (!supabase)
      return alert("Missing Supabase env vars on this deployment.");
    const raw = signinId.trim();
    if (!raw) return alert("Enter your email (or username) first.");

    // Password reset requires an email. If they typed a username, look up email.
    let emailToUse = raw;
    if (!raw.includes("@")) {
      const { data: prof, error: pErr } = await supabase
        .from("profiles")
        .select("email")
        .ilike("username", raw)
        .maybeSingle();

      if (pErr) return alert(pErr.message);
      if (!prof?.email)
        return alert(
          "No email found for that username. Please enter your email instead.",
        );
      emailToUse = prof.email;
    }

    // Where Supabase should send them back after they click the email link
    const redirectTo = `${window.location.origin}`;

    const { error } = await supabase.auth.resetPasswordForEmail(emailToUse, {
      redirectTo,
    });
    if (error) return alert(error.message);

    alert("Password reset email sent. Check your inbox.");
  }

  // Load suggestions for the currently selected page
  useEffect(() => {
    if (!DOCUMENT_ID || !pageKey) return;
    loadSuggestionsForPage(DOCUMENT_ID, pageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DOCUMENT_ID, pageKey]);

  useEffect(() => {
    if (!supabase) return;
    if (!DOCUMENT_ID) return;

    (async () => {
      try {
        const { data, error } = await supabase
          .from("suggestions")
          .select("user_id")
          .eq("document_id", DOCUMENT_ID)
          .limit(10000);

        if (error) throw error;

        const uniq = new Set(
          (data ?? [])
            .map((r: any) => String(r?.user_id ?? "").trim())
            .filter((x: string) => x.length > 0),
        );

        setWelcomeStats((prev) => ({ ...prev, volunteers: uniq.size }));
      } catch (e) {
        console.warn("welcome volunteers load failed", e);
      }
    })();
  }, [supabase, DOCUMENT_ID]);

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
    if (viewMode !== "map") return;
    if (typeof window === "undefined") return;

    let cancelled = false;

    (async () => {
      try {
        await loadLeafletOnce();
        if (cancelled) return;

        // Load selectable documents (id + title)
        const opts = await loadMapDocOptions();
        if (cancelled) return;

        const L = (window as any).L;
        const el = mapDivRef.current;
        if (!L || !el) return;

        // Init map once
        if (!leafletMapRef.current) {
          leafletMapRef.current = L.map(el, {
            zoomControl: true,
            attributionControl: true,
          });

          L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "© OpenStreetMap contributors",
          }).addTo(leafletMapRef.current);
        }

        // pick a doc id
        const initialId = selectedMapDocId || "__ALL__";
        if (!selectedMapDocId && initialId) setSelectedMapDocId(initialId);

        // Load + render trail for selected doc, or aggregates for ALL
        if (initialId === "__ALL__") {
          const aggs = await loadAggregatedLocationsAllDocs();
          if (cancelled) return;
          renderMapAggregates(aggs);
        } else if (initialId) {
          const locs = await loadLocationsForDoc(initialId);
          if (cancelled) return;
          renderMapTrail(locs);
        } else {
          renderMapTrail([]);
        }

        // invalidate size a few times (helps when switching tabs)
        const invalidate = () => {
          try {
            leafletMapRef.current?.invalidateSize?.();
          } catch {}
        };
        requestAnimationFrame(() => {
          invalidate();
          requestAnimationFrame(invalidate);
        });
        setTimeout(invalidate, 150);
        setTimeout(invalidate, 400);
      } catch (e: any) {
        console.warn("map init failed", e);
        setMapError(e?.message || String(e));
      }
    })();

    return () => {
      cancelled = true;

      // IMPORTANT: when navigating away from the Map view, Leaflet keeps a reference
      // to the old DOM element. If we re-enter Map, the div is a new element and
      // Leaflet won't re-render correctly unless we tear down the old map instance.
      try {
        if (leafletMapRef.current) {
          leafletMapRef.current.remove();
        }
      } catch {}

      leafletMapRef.current = null;
      leafletLayerRef.current = null;

      // Clear any leftover DOM from Leaflet just in case
      try {
        if (mapDivRef.current) mapDivRef.current.innerHTML = "";
      } catch {}

      // Clear errors/loading when leaving map
      setIsLoadingMap(false);
      setMapError(null);
    };
    // We intentionally exclude mapDocs from deps to avoid re-initting; marker refresh is handled by the button below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === "map") return;

    // If the map exists but the user left the map view, tear it down so
    // returning to Map always initializes cleanly.
    try {
      if (leafletMapRef.current) leafletMapRef.current.remove();
    } catch {}

    leafletMapRef.current = null;
    leafletLayerRef.current = null;

    try {
      if (mapDivRef.current) mapDivRef.current.innerHTML = "";
    } catch {}
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "map") return;
    if (typeof window === "undefined") return;
    if (!(window as any).L) return;
    if (!leafletMapRef.current) return;

    let cancelled = false;

    (async () => {
      try {
        const docId = selectedMapDocId;
        if (!docId) {
          renderMapTrail([]);
          return;
        }

        if (docId === "__ALL__") {
          const aggs = await loadAggregatedLocationsAllDocs();
          if (cancelled) return;
          renderMapAggregates(aggs);
          return;
        }

        const locs = await loadLocationsForDoc(docId);
        if (cancelled) return;
        renderMapTrail(locs);
      } catch (e: any) {
        console.warn("map trail refresh failed", e);
        setMapError(e?.message || String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedMapDocId]);

  useEffect(() => {
    if (!doc || !pdf || !pageKey) return;
    let cancelled = false;

    if (viewMode === "map") return;

    (async () => {
      const n = pageKeyToNumber(pageKey);
      if (!n) throw new Error(`Bad page key: ${pageKey}`);
      if (n < 1 || n > pdf.numPages)
        throw new Error(`Page ${n} out of range (PDF has ${pdf.numPages})`);

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

      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;

      // Cancel any previous in-flight render on this same canvas (prevents pdf.js error)
      try {
        renderTaskRef.current?.cancel?.();
      } catch {}
      renderTaskRef.current = null;

      const baseWidth =
        pdfViewportWidth || Math.floor(window.innerWidth * 0.48);
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
      // If this PDF page has no transcription JSON, we still render the PDF,
      // but we disable hit-testing/highlights for this page.
      if (!doc[pageKey]) {
        setHitBoxes([]);
        setParagraphItems([]);
        setActiveId(null);
        setActiveParagraphId(null);
        setActiveBox(null);
        return;
      }

      const pageObj = doc[pageKey];
      const lines = pageObj ? getAllLinesForPage(pageObj) : [];
      const nextHitBoxes: Array<{
        uid: string;
        x: number;
        y: number;
        w: number;
        h: number;
        area: number;
      }> = [];

      for (const l of lines) {
        const pageW = pageObj!.width;
        const pageH = pageObj!.height;

        const [x1p, y1p, x2p, y2p] = l.bbox;

        // Guard against bad data
        if (
          ![x1p, y1p, x2p, y2p, pageW, pageH].every((v) => Number.isFinite(v))
        )
          continue;
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
        if (h > 0.2) continue;
        if (area > 0.25) continue;
        if (w > 0.98 && h > 0.5) continue;
        if (w > 0.95 && h > 0.95) continue;

        // Extra safety: skip any box that is suspiciously large in either dimension
        if (w > 0.999 || h > 0.999) continue;

        if (
          process.env.NODE_ENV !== "production" &&
          (h > 0.08 || area > 0.08)
        ) {
          // eslint-disable-next-line no-console
          console.warn("Large bbox (from bbox pixels)", {
            uid: l.uid,
            bbox: l.bbox,
            w,
            h,
            area,
          });
        }

        boxByUidRef.current[l.uid] = { x: x1n, y: y1n, w, h };
        nextHitBoxes.push({ uid: l.uid, x: x1n, y: y1n, w, h, area });
      }

      // Sort for stable selection: prefer smallest area (most specific) first
      nextHitBoxes.sort((a, b) => a.area - b.area);
      setHitBoxes(nextHitBoxes);

      // Build paragraph/list/table-level boxes + text (for paragraph transcription mode)
      // IMPORTANT: keep items in page reading order by sorting by their top-left bbox.
      const parItems: Array<{
        pid: string;
        text: string;
        box: { x: number; y: number; w: number; h: number };
      }> = [];
      const pars = pageObj?.paragraphs || [];
      const pageW = pageObj!.width;
      const pageH = pageObj!.height;

      // Helper: get a normalized box from a block-like object.
      // Prefer pixel bbox if present; fall back to bboxn if present.
      const normBoxFromAny = (
        blk: any,
      ): { x: number; y: number; w: number; h: number } | null => {
        if (!blk) return null;

        // Prefer pixel bbox
        if (Array.isArray(blk.bbox) && blk.bbox.length === 4) {
          const nb = normBoxFromPixels(blk.bbox as any, pageW, pageH);
          if (nb) return { x: nb.x, y: nb.y, w: nb.w, h: nb.h };
        }

        // Fall back to normalized bbox
        if (Array.isArray(blk.bboxn) && blk.bboxn.length === 4) {
          const [x1n, y1n, x2n, y2n] = blk.bboxn as any;
          if (![x1n, y1n, x2n, y2n].every((v) => Number.isFinite(v)))
            return null;

          const x1 = Math.min(1, Math.max(0, Math.min(x1n, x2n)));
          const x2 = Math.min(1, Math.max(0, Math.max(x1n, x2n)));
          const y1 = Math.min(1, Math.max(0, Math.min(y1n, y2n)));
          const y2 = Math.min(1, Math.max(0, Math.max(y1n, y2n)));

          const w = Math.max(0, x2 - x1);
          const h = Math.max(0, y2 - y1);
          if (w <= 0 || h <= 0) return null;

          return { x: x1, y: y1, w, h };
        }

        return null;
      };

      // 1) Paragraphs (existing behavior)
      for (let pIdx = 0; pIdx < pars.length; pIdx++) {
        const par: any = pars[pIdx];
        const linesInPar: any[] = Array.isArray(par?.lines) ? par.lines : [];

        let minX = 1,
          minY = 1,
          maxX = 0,
          maxY = 0;
        let found = false;

        for (const ln of linesInPar) {
          const nb = normBoxFromPixels(ln.bbox, pageW, pageH);
          if (!nb) continue;
          found = true;
          minX = Math.min(minX, nb.x);
          minY = Math.min(minY, nb.y);
          maxX = Math.max(maxX, nb.x + nb.w);
          maxY = Math.max(maxY, nb.y + nb.h);
        }

        if (!found) continue;

        minX = Math.min(1, Math.max(0, minX));
        minY = Math.min(1, Math.max(0, minY));
        maxX = Math.min(1, Math.max(0, maxX));
        maxY = Math.min(1, Math.max(0, maxY));

        const box = {
          x: minX,
          y: minY,
          w: Math.max(0, maxX - minX),
          h: Math.max(0, maxY - minY),
        };
        if (box.w <= 0 || box.h <= 0) continue;

        const llmText = (par?.llm_text ?? "").toString().trim();
        const fallbackText = (linesInPar || [])
          .map((x: any) => String(x?.transcription ?? ""))
          .join("\n")
          .trim();
        const text = llmText || fallbackText;

        parItems.push({ pid: `p-${pIdx}`, text, box });
      }

      // 2) Lists (if present in JSON)
      // Robust: your JSON may call it `lists` or `list`.
      const listsAny: any[] = Array.isArray((pageObj as any)?.lists)
        ? (pageObj as any).lists
        : Array.isArray((pageObj as any)?.list)
          ? (pageObj as any).list
          : [];

      for (let i = 0; i < listsAny.length; i++) {
        const blk: any = listsAny[i];
        const box = normBoxFromAny(blk);
        if (!box) continue;

        const llmText = (blk?.llm_text ?? blk?.text ?? "").toString().trim();
        const items = Array.isArray(blk?.items)
          ? blk.items
          : Array.isArray(blk?.lines)
            ? blk.lines
            : [];
        const fallback = Array.isArray(items)
          ? items
              .map((x: any) => {
                if (typeof x === "string") return x;
                return String(x?.text ?? x?.transcription ?? "");
              })
              .filter((s: string) => s.trim().length)
              .join("\n")
              .trim()
          : "";

        const text = llmText || fallback || "(List)";
        parItems.push({ pid: `list-${i}`, text, box });
      }

      // 3) Tables (if present in JSON)
      const tablesAny: any[] = Array.isArray((pageObj as any)?.tables)
        ? (pageObj as any).tables
        : Array.isArray((pageObj as any)?.table)
          ? (pageObj as any).table
          : [];

      for (let i = 0; i < tablesAny.length; i++) {
        const blk: any = tablesAny[i];
        const box = normBoxFromAny(blk);
        if (!box) continue;

        const llmText = (blk?.llm_text ?? blk?.text ?? "").toString().trim();

        // Try to build a readable fallback from common table shapes
        let fallback = "";
        const rows = Array.isArray(blk?.rows)
          ? blk.rows
          : Array.isArray(blk?.data)
            ? blk.data
            : null;
        if (rows && Array.isArray(rows)) {
          fallback = rows
            .map((r: any) => {
              if (Array.isArray(r))
                return r
                  .map((c) => String(c ?? "").trim())
                  .filter(Boolean)
                  .join("\t");
              if (typeof r === "object" && r) {
                return Object.keys(r)
                  .sort()
                  .map((k) => String(r[k] ?? "").trim())
                  .filter(Boolean)
                  .join("\t");
              }
              return String(r ?? "").trim();
            })
            .filter((s: string) => s.trim().length)
            .join("\n")
            .trim();
        }

        const text = llmText || fallback || "(Table)";
        parItems.push({ pid: `table-${i}`, text, box });
      }

      // Sort ALL items by reading order.
      // If the PDF page is actually a 2-page spread (left page + right page scanned together),
      // order by page-half first (left half, then right half), then by y then x.
      // Otherwise, order by y then x.
      const centers: number[] = parItems
        .map((it) => it.box.x + it.box.w * 0.5)
        .filter((v) => Number.isFinite(v));

      let isTwoPageSpread = false;
      if (centers.length >= 6) {
        const leftCount = centers.filter((c) => c < 0.45).length;
        const rightCount = centers.filter((c) => c > 0.55).length;
        const fracLeft = leftCount / centers.length;
        const fracRight = rightCount / centers.length;
        if (fracLeft > 0.2 && fracRight > 0.2) isTwoPageSpread = true;
      }

      parItems.sort((a, b) => {
        const aCenter = a.box.x + a.box.w * 0.5;
        const bCenter = b.box.x + b.box.w * 0.5;

        if (isTwoPageSpread) {
          const halfA = aCenter < 0.5 ? 0 : 1;
          const halfB = bCenter < 0.5 ? 0 : 1;
          if (halfA !== halfB) return halfA - halfB; // left half first
        }

        const dy = a.box.y - b.box.y;
        if (Math.abs(dy) > 0.002) return dy;

        const dx = a.box.x - b.box.x;
        if (Math.abs(dx) > 0.002) return dx;

        // Stable tie-breaker
        return String(a.pid).localeCompare(String(b.pid));
      });

      setParagraphItems(parItems);

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
    })().catch((e) => {
      console.error(e);
      alert(e?.message || String(e));
    });

    return () => {
      cancelled = true;
      try {
        renderTaskRef.current?.cancel?.();
      } catch {}
    };
  }, [doc, pdf, pageKey, zoom, pdfViewportWidth, viewMode]);

  // Apply a pending Low Confidence jump after the page has rendered its boxes
  useEffect(() => {
    if (!pendingLowConfJump) return;
    if (!pageKey || pendingLowConfJump.pageKey !== pageKey) return;

    // Switch to paragraph mode so p-#/list-#/table-# targets exist
    setTranscriptionMode("paragraph");

    setActiveSource("menu");
    setActiveParagraphId(pendingLowConfJump.targetPid);
    setActiveId(null);
    setActiveBox(pendingLowConfJump.box);

    // Ensure community suggestions visible for the target
    setCollapseSuggestions(false);

    setIsDrawingLowConfBox(false);
    setDrawPreviewBox(null);

    // Clear once applied
    setPendingLowConfJump(null);
  }, [pendingLowConfJump, pageKey]);

  useEffect(() => {
    if (!autoScrollEnabled) return;
    if (!activeParagraphId) return;
    if (activeSource !== "left" && activeSource !== "menu") return;
    if (lowConfLockKey || isDrawingLowConfBox) return;

    const el = paragraphElByIdRef.current[String(activeParagraphId)];
    const container = rightScrollRef.current;
    if (!el || !container) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    const offsetTop = elRect.top - containerRect.top;

    const targetTop =
      container.scrollTop +
      offsetTop -
      container.clientHeight / 2 +
      el.clientHeight / 2;

    container.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [activeParagraphId, activeSource]);

  // Auto-scroll: when hovering/clicking a LINE on the LEFT (PDF), center the matching line on the RIGHT.
  useEffect(() => {
    if (!autoScrollEnabled) return;
    if (!activeId) return;
    if (activeSource !== "left" && activeSource !== "menu") return;
    if (lowConfLockKey || isDrawingLowConfBox) return;

    const el = lineElByIdRef.current[String(activeId)];
    const container = rightScrollRef.current;
    if (!el || !container) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    const offsetTop = elRect.top - containerRect.top;

    // Center the line within the right panel
    const targetTop =
      container.scrollTop +
      offsetTop -
      container.clientHeight / 2 +
      el.clientHeight / 2;

    container.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [activeId, activeSource]);

  // ------------------------------
  // Point-based hit-testing (PDF image -> transcript)
  // ------------------------------
  function pickLineBoxAt(u: number, v: number) {
    for (const b of hitBoxes) {
      if (u >= b.x && u <= b.x + b.w && v >= b.y && v <= b.y + b.h) return b;
    }
    return null;
  }

  function pickParagraphAt(u: number, v: number) {
    let best: {
      pid: string;
      box: { x: number; y: number; w: number; h: number };
      area: number;
    } | null = null;
    for (const p of paragraphItems) {
      const b = p.box;
      if (u >= b.x && u <= b.x + b.w && v >= b.y && v <= b.y + b.h) {
        const area = b.w * b.h;
        if (!best || area < best.area) best = { pid: p.pid, box: b, area };
      }
    }
    return best;
  }

  const onHitSvgClick: MouseEventHandler<SVGSVGElement> = (e) => {
    // If the user is drag-panning (zoomed-in), don't treat this as a click.
    if (isDraggingRef.current) return;
    if (lowConfLockKey || isDrawingLowConfBox) return;
    if (isDrawingLowConfBox) return;

    // If this PDF page has no transcription JSON, there's nothing to open.
    if (!doc || !pageKey || !doc[pageKey]) return;

    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const uu = Math.min(1, Math.max(0, u));
    const vv = Math.min(1, Math.max(0, v));

    // Paragraph mode: click toggles collapse for that paragraph id
    if (transcriptionMode === "paragraph") {
      const pickedP = pickParagraphAt(uu, vv);
      if (!pickedP) return;

      const pid = pickedP.pid;
      const wasSame = activeParagraphId === pid;

      setActiveSource("left");
      setActiveParagraphId(pid);
      setActiveId(null);
      setActiveBox(pickedP.box);

      // Click again toggles collapse for that paragraph’s suggestions (same behavior as line mode)
      setCollapsedUid((prev) => {
        const cur = !!prev[pid];
        if (!wasSame) return { ...prev, [pid]: false };
        return { ...prev, [pid]: cur ? false : true };
      });

      // Ensure community suggestions are visible when interacting
      setCollapseSuggestions(false);

      // Don’t auto-open suggest-edit on click
      setOpenSuggestUid(null);
      return;
    }

    // Line mode
    const picked = pickLineBoxAt(uu, vv);
    if (!picked) return;

    const uid = picked.uid;
    const wasSame = activeId === uid;

    setActiveSource("left");
    setActiveId(uid);
    setActiveParagraphId(null);
    setActiveBox(boxByUidRef.current[uid] ?? null);

    // Ensure community suggestions are visible
    setCollapseSuggestions(false);

    // Click again toggles collapse for that line’s suggestions
    setCollapsedUid((prev) => {
      const cur = !!prev[uid];
      if (!wasSame) return { ...prev, [uid]: false };
      return { ...prev, [uid]: cur ? false : true };
    });

    // Do NOT open the suggest-edit form automatically
    setOpenSuggestUid(null);
  };

  const onHitSvgMouseDown: MouseEventHandler<SVGSVGElement> = (e) => {
    if (!isDrawingLowConfBox) return;
    if (isDraggingRef.current) return;
    if (e.button !== 0) return;
    if (!doc || !pageKey || !doc[pageKey]) return;
    if (transcriptionMode !== "paragraph") return;
    if (!activeParagraphId) return;

    // only allow drawing when the active paragraph/list/table is low confidence on this page
    if (!lowConfByPid[String(activeParagraphId)]) return;

    const lockKey = `${pageKey}|${String(activeParagraphId)}`;
    beginLowConfLock(lockKey);

    setDrawHoverBox(null);

    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const x = Math.min(1, Math.max(0, u));
    const y = Math.min(1, Math.max(0, v));

    drawStartRef.current = { x, y };
    setDrawPreviewBox({ x, y, w: 0, h: 0 });
    setDrawHoverBox(null);

    e.preventDefault();
    e.stopPropagation();
  };

  const onHitSvgMouseUp: MouseEventHandler<SVGSVGElement> = (e) => {
    if (!isDrawingLowConfBox) return;
    const start = drawStartRef.current;
    if (!start) return;

    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const endX = Math.min(1, Math.max(0, u));
    const endY = Math.min(1, Math.max(0, v));

    const x1 = Math.min(start.x, endX);
    const y1 = Math.min(start.y, endY);
    const x2 = Math.max(start.x, endX);
    const y2 = Math.max(start.y, endY);

    const w = Math.max(0, x2 - x1);
    const h = Math.max(0, y2 - y1);

    // ignore tiny drags
    if (w >= 0.003 && h >= 0.003 && activeParagraphId) {
      const key = `${pageKey}|${String(activeParagraphId)}`;
      setLowConfDrawnBoxByKey((prev) => ({
        ...prev,
        [key]: { x: x1, y: y1, w, h },
      }));
    }

    drawStartRef.current = null;
    setDrawPreviewBox(null);
    setDrawHoverBox(null);
    setIsDrawingLowConfBox(false);
    setDrawHoverBox(null);

    e.preventDefault();
    e.stopPropagation();
  };

  function getSortedSuggestions(uid: string) {
    const arr = suggestionsByUid[uid] ? [...suggestionsByUid[uid]] : [];
    const mode = sortModeByUid[uid] ?? "top";

    if (mode === "newest") {
      arr.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      return arr;
    }

    // "top": votes desc, then newest
    arr.sort((a, b) => {
      const va = a.vote_count ?? 0;
      const vb = b.vote_count ?? 0;
      if (vb !== va) return vb - va;
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });

    return arr;
  }

  const onHitSvgMouseMove: MouseEventHandler<SVGSVGElement> = (e) => {
    // While locked OR drawing mode is enabled (but not dragging yet), show hovered block boxes on the PDF
    // but do NOT change the active selection (right-panel highlight).
    if ((lowConfLockKey || isDrawingLowConfBox) && !drawStartRef.current) {
      const svg = e.currentTarget;
      const r = svg.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const u = (e.clientX - r.left) / r.width;
        const v = (e.clientY - r.top) / r.height;
        const uu = Math.min(1, Math.max(0, u));
        const vv = Math.min(1, Math.max(0, v));

        const pickedP = pickParagraphAt(uu, vv);
        setDrawHoverBox(pickedP ? pickedP.box : null);
      }
      return;
    }

    // If we're drawing a corrected bbox, update the preview box and skip hover behavior.
    if (isDrawingLowConfBox && drawStartRef.current) {
      const svg = e.currentTarget;
      const r = svg.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;

      const u = (e.clientX - r.left) / r.width;
      const v = (e.clientY - r.top) / r.height;
      const endX = Math.min(1, Math.max(0, u));
      const endY = Math.min(1, Math.max(0, v));

      const start = drawStartRef.current;
      const x1 = Math.min(start.x, endX);
      const y1 = Math.min(start.y, endY);
      const x2 = Math.max(start.x, endX);
      const y2 = Math.max(start.y, endY);

      setDrawPreviewBox({
        x: x1,
        y: y1,
        w: Math.max(0, x2 - x1),
        h: Math.max(0, y2 - y1),
      });
      return;
    }

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

      // Ignore hover updates while drag-panning
      if (isDraggingRef.current) return;

      if (transcriptionMode === "paragraph") {
        const pickedP = pickParagraphAt(uu, vv);
        if (!pickedP) return;

        if (activeParagraphId === pickedP.pid && activeSource === "left")
          return;

        setActiveSource("left");
        setActiveParagraphId(pickedP.pid);
        setActiveId(null);
        setActiveBox(pickedP.box);
        return;
      }

      const picked = pickLineBoxAt(uu, vv);
      if (!picked) return;

      if (activeId === picked.uid && activeSource === "left") return;

      setActiveSource("left");
      setActiveId(picked.uid);
      setActiveParagraphId(null);
      setActiveBox(boxByUidRef.current[picked.uid] ?? null);
    });
  };

  const onHitSvgMouseLeave: MouseEventHandler<SVGSVGElement> = () => {
    hoverPtRef.current = null;
    if (lowConfLockKey || isDrawingLowConfBox) {
      setDrawHoverBox(null);
      hoverPtRef.current = null;
      if (hoverRafRef.current != null) {
        cancelAnimationFrame(hoverRafRef.current);
        hoverRafRef.current = null;
      }
      return;
    }
    if (hoverRafRef.current != null) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }

    // While in drawing mode, do NOT clear active selection/highlights.
    if (isDrawingLowConfBox) {
      setDrawHoverBox(null);
      return;
    }

    setActiveSource(null);
    setActiveId(null);
    setActiveParagraphId(null);
    setActiveBox(null);
  };

  if (started && (missingEnv.length || !supabase)) {
    return (
      <div style={{ padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>
          Missing required environment variables
        </div>
        <div style={{ marginTop: 8, opacity: 0.85 }}>
          This deployment is missing one or more <code>NEXT_PUBLIC_*</code>{" "}
          variables. Add them in Vercel → Project → Settings → Environment
          Variables, then redeploy.
        </div>
        <ul style={{ marginTop: 10 }}>
          {missingEnv.map((k) => (
            <li key={k}>
              <code>{k}</code>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (started && fatalError) {
    return (
      <div style={{ padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Application error</div>
        <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{fatalError}</div>
      </div>
    );
  }

  // ------------------------------
  // Welcome / landing screen
  // ------------------------------
  if (!started) {
    const bgUrl = "/welcome-bg.png";

    return (
      <div
        style={{
          height: "100vh",
          width: "100vw",
          position: "relative",
          overflow: "hidden",
          fontFamily: "ui-sans-serif, system-ui",
          color: "white",
          background: bgUrl
            ? `url(${bgUrl}) center/cover no-repeat`
            : "radial-gradient(1200px 600px at 50% 15%, rgba(255,255,255,0.12), rgba(0,0,0,0)), linear-gradient(135deg, #2b2b2b 0%, #0f0f0f 100%)",
        }}
      >
        {/* dark overlay for readability */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.35) 35%, rgba(0,0,0,0.65) 100%)",
          }}
        />

        <div
          style={{
            position: "relative",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
          }}
        >
          <div style={{ maxWidth: 780, width: "100%" }}>
            <div
              style={{
                fontWeight: 900,
                letterSpacing: 0.2,
                fontSize: 56,
                lineHeight: 1.05,
                textShadow: "0 3px 12px rgba(0,0,0,0.55)",
              }}
            >
              Voices from The Past
            </div>

            <div
              style={{
                marginTop: 16,
                fontSize: 16,
                lineHeight: 1.5,
                opacity: 0.95,
                textShadow: "0 2px 10px rgba(0,0,0,0.45)",
              }}
            >
              Help transcribe HBC Records.
              <br />
              Every word you transcribe brings a piece of history back to life.
            </div>

            <div
              style={{
                marginTop: 22,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  // Ensure we enter the viewer in a clean state
                  setViewMode("viewer");
                  setShowLeaderboard(false);
                  setShowSignin(false);
                  setShowSignup(false);

                  setStarted(true);

                  // Make the viewer a distinct URL state so users can go back to the welcome page.
                  try {
                    const url = new URL(window.location.href);
                    url.searchParams.set("start", "1");
                    window.history.pushState({}, "", url.toString());
                  } catch {}
                }}
                disabled={missingEnv.length > 0}
                title={
                  missingEnv.length
                    ? `Missing env vars: ${missingEnv.join(", ")}. Add them in .env.local or Vercel before starting.`
                    : ""
                }
                style={{
                  border: "1px solid rgba(255,255,255,0.28)",
                  background: "rgba(255,255,255,0.14)",
                  color: "white",
                  padding: "12px 18px",
                  borderRadius: 14,
                  fontWeight: 900,
                  cursor: missingEnv.length ? "not-allowed" : "pointer",
                  boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                  backdropFilter: "blur(6px)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 16,
                  opacity: missingEnv.length ? 0.6 : 1,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(255,255,255,0.18)",
                    border: "1px solid rgba(255,255,255,0.28)",
                  }}
                >
                  ➤
                </span>
                Start Transcribing
              </button>
            </div>

            <div
              style={{
                marginTop: 26,
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 10,
              }}
            >
              {[
                {
                  big:
                    typeof welcomeStats.pages === "number"
                      ? welcomeStats.pages.toLocaleString()
                      : "—",
                  small: "Pages Available",
                },
                {
                  big:
                    typeof welcomeStats.lines === "number"
                      ? welcomeStats.lines.toLocaleString()
                      : "—",
                  small: "Lines Available",
                },
                {
                  big:
                    typeof welcomeStats.volunteers === "number"
                      ? welcomeStats.volunteers.toLocaleString()
                      : "—",
                  small: "Active Volunteers",
                },
              ].map((s) => (
                <div
                  key={s.small}
                  style={{
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(0,0,0,0.25)",
                    borderRadius: 14,
                    padding: "12px 14px",
                    backdropFilter: "blur(6px)",
                  }}
                >
                  <div
                    style={{ fontWeight: 900, fontSize: 22, lineHeight: 1.1 }}
                  >
                    {s.big}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.92, marginTop: 4 }}>
                    {s.small}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!doc) return <div style={{ padding: 16 }}>Loading…</div>;
  const hasTranscriptionForPage = !!(pageKey && doc && doc[pageKey]);
  const lines = pageKey && doc[pageKey] ? getAllLinesForPage(doc[pageKey]) : [];

  // ---------- UI helpers (inline styles) ----------
  const btnBase: React.CSSProperties = {
    padding: "8px 14px",
    borderRadius: 10,
    border: "1px solid rgba(0,0,0,0.18)",
    background: "white",
    cursor: "pointer",
    fontWeight: 800,
    boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
    outline: "none",
    appearance: "none",
    transition:
      "transform 120ms ease, box-shadow 120ms ease, background 120ms ease",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const btnSoft: React.CSSProperties = {
    ...btnBase,
    background: "rgba(0,0,0,0.05)",
    boxShadow: "none",
  };

  const btnSecondary: React.CSSProperties = {
    ...btnBase,
    background: "transparent",
    boxShadow: "none",
    border: "1px solid rgba(0,0,0,0.14)",
    fontWeight: 800,
    color: "rgba(0,0,0,0.75)",
  };

  const btnTiny: React.CSSProperties = {
    ...btnBase,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 800,
  };

  const iconBtn: React.CSSProperties = {
    border: "none",
    background: "transparent",
    padding: 6,
    borderRadius: 10,
    cursor: "pointer",
    lineHeight: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "rgba(0,0,0,0.65)",
    transition: "transform 120ms ease, background 120ms ease",
    outline: "none",
    appearance: "none",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const btnLink: React.CSSProperties = {
    padding: 0,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontWeight: 700,
    color: "rgba(0,0,0,0.65)",
    textDecoration: "underline",
    outline: "none",
    appearance: "none",
  };

  const blurOnFocus = (e: React.FocusEvent<HTMLElement>) => {
    // Prevent “permanently selected” focus styles after click
    (e.currentTarget as HTMLElement).blur();
  };

  const preventMouseDownFocus = (e: React.MouseEvent<HTMLElement>) => {
    // Stops mouse down from moving focus to the button
    e.preventDefault();
  };

  const openLeaderboard = () => {
    setShowLeaderboard(true);
    loadLeaderboard();
  };

  async function loadLeafletOnce() {
    if (typeof window === "undefined") return;
    // already loaded
    if ((window as any).L) return;

    // CSS
    const cssId = "leaflet-css";
    if (!document.getElementById(cssId)) {
      const link = document.createElement("link");
      link.id = cssId;
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    // JS
    await new Promise<void>((resolve, reject) => {
      const jsId = "leaflet-js";
      if (document.getElementById(jsId)) {
        // script tag exists; wait a tick for L
        const t = window.setInterval(() => {
          if ((window as any).L) {
            window.clearInterval(t);
            resolve();
          }
        }, 50);
        window.setTimeout(() => {
          window.clearInterval(t);
          if ((window as any).L) resolve();
          else reject(new Error("Leaflet failed to load"));
        }, 4000);
        return;
      }

      const script = document.createElement("script");
      script.id = jsId;
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Leaflet failed to load"));
      document.body.appendChild(script);
    });
  }

  async function loadDocsForMap(): Promise<MapDoc[]> {
    if (!supabase) return [];
    setIsLoadingMap(true);
    setMapError(null);

    try {
      // Preferred: fetch documents with coordinates
      const { data, error } = await supabase
        .from("documents")
        .select("id,title,lat,lng")
        .limit(5000);

      if (error) {
        const msg = error.message || String(error);

        // If the project hasn't added lat/lng yet, don't show an error.
        // Just treat it as: "no locations configured".
        if (/column\s+documents\.(lat|lng)\s+does\s+not\s+exist/i.test(msg)) {
          setMapDocs([]);
          return [];
        }

        throw error;
      }

      const rows = (data ?? []) as any[];
      const docs: MapDoc[] = rows
        .map((r) => ({
          id: String(r?.id ?? ""),
          title: String(r?.title ?? "").trim() || "(Untitled)",
          lat: Number(r?.lat),
          lng: Number(r?.lng),
        }))
        .filter(
          (d) => d.id && Number.isFinite(d.lat) && Number.isFinite(d.lng),
        );

      setMapDocs(docs);
      return docs;
    } catch (e: any) {
      console.warn("map docs load failed", e);
      // For any other error, show it.
      setMapError(e?.message || String(e));
      setMapDocs([]);
      return [];
    } finally {
      setIsLoadingMap(false);
    }
  }

  // Inline SVG pencil icon for "Suggest edit" buttons
  function PencilGlyph({ size = 16 }: { size?: number }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M12 20h9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M16.5 3.5a2.121 2.121 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Global header (does not scroll) */}
      <div
        style={{
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "0 16px",
          borderBottom: "1px solid #e6e6e6",
          background: "white",
          zIndex: 10,
          flex: "0 0 auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>
            Hudson&apos;s Bay Company Records
          </div>

          <button
            type="button"
            onClick={() => {
              setStarted(false);
              setFatalError(null);
              setActiveId(null);
              setActiveParagraphId(null);
              setActiveBox(null);
              setOpenSuggestUid(null);
              setViewMode("viewer");
              setShowLeaderboard(false);
              setShowSignin(false);
              setShowSignup(false);
              try {
                const url = new URL(window.location.href);
                url.searchParams.delete("start");
                window.history.pushState(
                  {},
                  "",
                  url.pathname +
                    (url.searchParams.toString()
                      ? `?${url.searchParams.toString()}`
                      : ""),
                );
              } catch {}
            }}
            style={btnSecondary}
            onMouseDown={preventMouseDownFocus}
            onFocus={blurOnFocus}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(0,0,0,0.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            Home
          </button>

          {isLoadingSuggestions ? (
            <div style={{ fontSize: 12, opacity: 0.75, whiteSpace: "nowrap" }}>
              Loading…
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <div style={{ position: "relative" }}>
            <button
              ref={lowConfBtnRef}
              type="button"
              onClick={() => setShowLowConfidenceMenu((v) => !v)}
              style={btnBase}
              onMouseDown={preventMouseDownFocus}
              onFocus={blurOnFocus}
              onMouseEnter={(e) =>
                (e.currentTarget.style.transform = "translateY(1px)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.transform = "translateY(0px)")
              }
              aria-expanded={showLowConfidenceMenu}
              title="Pages/blocks where class confidence is below 50"
            >
              Low Confidence Pages
              {lowConfItems.length ? ` (${lowConfItems.length})` : ""}
            </button>

            {showLowConfidenceMenu ? (
              <div
                ref={lowConfMenuRef}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 8px)",
                  width: "min(360px, 92vw)",
                  maxHeight: 360,
                  overflow: "auto",
                  border: "1px solid rgba(0,0,0,0.12)",
                  borderRadius: 14,
                  background: "rgba(255,255,255,0.98)",
                  boxShadow: "0 18px 50px rgba(0,0,0,0.18)",
                  padding: 10,
                  zIndex: 9999,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div style={{ fontWeight: 900, fontSize: 13, opacity: 0.85 }}>
                    Low confidence blocks
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowLowConfidenceMenu(false)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.18)",
                      background: "white",
                      cursor: "pointer",
                      fontWeight: 800,
                      outline: "none",
                      appearance: "none",
                    }}
                    onMouseDown={preventMouseDownFocus}
                    onFocus={blurOnFocus}
                  >
                    ✕
                  </button>
                </div>

                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                  {lowConfItems.length ? (
                    lowConfItems.map((it) => (
                      <div
                        key={`${it.pageKey}|${it.targetPid}`}
                        onClick={() => {
                          setShowLowConfidenceMenu(false);

                          if (it.pageKey !== pageKey) {
                            setPageKey(it.pageKey);
                          }

                          setPendingLowConfJump({
                            pageKey: it.pageKey,
                            targetPid: it.targetPid,
                            box: it.box || { x: 0, y: 0, w: 0, h: 0 },
                          });
                        }}
                        style={{
                          padding: 12,
                          borderRadius: 12,
                          border: "1px solid rgba(0,0,0,0.10)",
                          background: "white",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          cursor: "pointer",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 12,
                            width: "100%",
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 900,
                              fontSize: 14,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            Page {it.pageNum ?? ""} • {it.label}
                          </div>

                          <div
                            style={{
                              fontWeight: 900,
                              fontSize: 14,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {Math.round(it.confPct)}%
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ fontSize: 13, opacity: 0.75 }}>
                      No low-confidence paragraph/list/table blocks found.
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          {!user ? (
            <>
              <button
                type="button"
                onClick={openLeaderboard}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "translateY(1px)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "translateY(0px)")
                }
              >
                Community Leaderboard
              </button>

              <button
                type="button"
                onClick={() =>
                  setViewMode((m) => (m === "map" ? "viewer" : "map"))
                }
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "translateY(1px)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "translateY(0px)")
                }
              >
                {viewMode === "map" ? "Back to Viewer" : "Map"}
              </button>

              <button
                type="button"
                onClick={() => setCollapseSuggestions((v) => !v)}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "translateY(1px)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "translateY(0px)")
                }
              >
                {collapseSuggestions
                  ? "Show community suggestions"
                  : "Hide community suggestions"}
              </button>

              <button
                type="button"
                onClick={() => setShowSignin(true)}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "translateY(1px)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "translateY(0px)")
                }
              >
                Sign In
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={openLeaderboard}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "translateY(1px)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "translateY(0px)")
                }
              >
                Community Leaderboard
              </button>

              <button
                type="button"
                onClick={() =>
                  setViewMode((m) => (m === "map" ? "viewer" : "map"))
                }
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "translateY(1px)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "translateY(0px)")
                }
              >
                {viewMode === "map" ? "Back to Viewer" : "Map"}
              </button>

              <button
                type="button"
                onClick={() => setCollapseSuggestions((v) => !v)}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "translateY(1px)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "translateY(0px)")
                }
              >
                {collapseSuggestions
                  ? "Show community suggestions"
                  : "Hide community suggestions"}
              </button>

              <div style={{ fontSize: 13, opacity: 0.9 }}>
                Signed in as{" "}
                <b>{usernameByUserId[user.id] || user.email || user.id}</b>
              </div>

              <button
                type="button"
                onClick={signOut}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.transform = "translateY(1px)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.transform = "translateY(0px)")
                }
              >
                Sign Out
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main content (viewer or map) */}
      {viewMode === "map" ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid #e6e6e6",
              background: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontWeight: 900, fontSize: 14, opacity: 0.85 }}>
                Document Map
              </div>

              <div
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                <div style={{ fontSize: 12, opacity: 0.75 }}>Document:</div>
                <select
                  value={selectedMapDocId}
                  onChange={(e) => setSelectedMapDocId(e.target.value)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: "white",
                    fontSize: 12,
                    fontWeight: 800,
                    outline: "none",
                    cursor: "pointer",
                    minWidth: 240,
                  }}
                >
                  <option value="__ALL__">All documents</option>
                  {mapDocOptions.length ? (
                    mapDocOptions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))
                  ) : (
                    <option value="">No documents</option>
                  )}
                </select>
              </div>
            </div>
          </div>

          {mapError ? (
            <div
              style={{
                padding: 12,
                color: "#b00020",
                fontFamily: "ui-sans-serif, system-ui",
              }}
            >
              {mapError}
            </div>
          ) : null}

          {isLoadingMap ? (
            <div
              style={{
                padding: 12,
                opacity: 0.75,
                fontFamily: "ui-sans-serif, system-ui",
              }}
            >
              Loading map…
            </div>
          ) : null}

          <div
            ref={mapDivRef}
            style={{ flex: 1, minHeight: 0, width: "100%" }}
          />
          <div
            style={{
              padding: 10,
              borderTop: "1px solid #e6e6e6",
              fontSize: 12,
              opacity: 0.8,
            }}
          >
            {selectedMapDocId
              ? selectedMapDocId === "__ALL__"
                ? mapAggLocations.length
                  ? `Showing ${mapAggLocations.length.toLocaleString()} locations across all documents.`
                  : "No locations have been tagged yet."
                : mapLocations.length
                  ? `Showing ${mapLocations.length.toLocaleString()} locations for this document.`
                  : "No locations for this document yet."
              : "No document selected."}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            flex: 1,
            minHeight: 0,
          }}
        >
          <div
            style={{
              borderRight: "1px solid #e6e6e6",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
            }}
          >
            {/* Header (does NOT scroll over the PDF) */}
            <div
              style={{
                position: "sticky",
                top: 0,
                height: 56,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "0 16px",
                borderBottom: "1px solid #e6e6e6",
                background: "white",
                zIndex: 10000,
                flex: "0 0 auto",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "nowrap",
                  justifyContent: "space-between",
                }}
              >
                {/* Controls (left) */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      gap: 4,
                      alignItems: "center",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        const idx = pageKeys.indexOf(pageKey);
                        if (idx > 0) setPageKey(pageKeys[idx - 1]);
                      }}
                      disabled={pageKeys.indexOf(pageKey) <= 0}
                      style={{
                        padding: "4px 8px",
                        fontSize: 16,
                        lineHeight: 1,
                        cursor:
                          pageKeys.indexOf(pageKey) <= 0
                            ? "not-allowed"
                            : "pointer",
                        opacity: pageKeys.indexOf(pageKey) <= 0 ? 0.35 : 1,
                        border: "1px solid rgba(0,0,0,0.18)",
                        borderRadius: 8,
                        background: "white",
                      }}
                      title="Previous page"
                    >
                      ‹
                    </button>
                    <select
                      value={pageKey}
                      onChange={(e) => setPageKey(e.target.value)}
                    >
                      {pageKeys.map((k) => (
                        <option key={k} value={k}>
                          Page {pageKeyToNumber(k) ?? ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        const idx = pageKeys.indexOf(pageKey);
                        if (idx < pageKeys.length - 1)
                          setPageKey(pageKeys[idx + 1]);
                      }}
                      disabled={
                        pageKeys.indexOf(pageKey) >= pageKeys.length - 1
                      }
                      style={{
                        padding: "4px 8px",
                        fontSize: 16,
                        lineHeight: 1,
                        cursor:
                          pageKeys.indexOf(pageKey) >= pageKeys.length - 1
                            ? "not-allowed"
                            : "pointer",
                        opacity:
                          pageKeys.indexOf(pageKey) >= pageKeys.length - 1
                            ? 0.35
                            : 1,
                        border: "1px solid rgba(0,0,0,0.18)",
                        borderRadius: 8,
                        background: "white",
                      }}
                      title="Next page"
                    >
                      ›
                    </button>
                  </span>

                  <span
                    style={{
                      display: "inline-flex",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <button
                      type="button"
                      onClick={zoomOut}
                      style={{ padding: "4px 8px" }}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={zoomReset}
                      style={{ padding: "4px 8px" }}
                    >
                      {Math.round(zoom * 100)}%
                    </button>
                    <button
                      type="button"
                      onClick={zoomIn}
                      style={{ padding: "4px 8px" }}
                    >
                      +
                    </button>
                  </span>

                  {(() => {
                    const hasTranscription = !!(
                      doc &&
                      pageKey &&
                      (doc as any)[pageKey]
                    );
                    if (!hasTranscription) return null;
                    const seq = pageKeyToNumber(pageKey);
                    const existing = seq
                      ? viewerLocations.find((x) => x.seq === seq)
                      : null;
                    const hasExisting = !!existing;
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          if (!user)
                            return alert("Please sign in to add locations.");
                          const seq2 = pageKeyToNumber(pageKey);
                          if (!seq2)
                            return alert(
                              "Could not determine page number for this page.",
                            );
                          const ex =
                            viewerLocations.find((x) => x.seq === seq2) || null;
                          if (ex) {
                            setLocLabel((ex.label ?? "").toString());
                            setLocLat(
                              Number.isFinite(Number(ex.lat))
                                ? String(ex.lat)
                                : "",
                            );
                            setLocLng(
                              Number.isFinite(Number(ex.lng))
                                ? String(ex.lng)
                                : "",
                            );
                            setLocNote((ex.note ?? "").toString());
                          } else {
                            setLocLabel("");
                            setLocLat("");
                            setLocLng("");
                            setLocNote("");
                          }
                          setShowAddLocation(true);
                        }}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 10,
                          border: "1px solid rgba(0,0,0,0.18)",
                          background: "white",
                          cursor: "pointer",
                          fontWeight: 800,
                          boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                          whiteSpace: "nowrap",
                        }}
                        title={
                          hasExisting
                            ? "Change the map location for this page"
                            : "Add a map location for this page"
                        }
                      >
                        {hasExisting ? "Change location" : "Add location"}
                      </button>
                    );
                  })()}

                  {(() => {
                    const seq = pageKeyToNumber(pageKey);
                    if (!seq) return null;
                    const loc = viewerLocations.find((x) => x.seq === seq);
                    if (!loc) return null;
                    const label = (loc.label ?? "").trim();
                    const lat = Number(loc.lat);
                    const lng = Number(loc.lng);
                    const coordsOk =
                      Number.isFinite(lat) && Number.isFinite(lng);
                    return (
                      <div
                        title={
                          coordsOk
                            ? `Location${label ? `: ${label}` : ""} (${lat.toFixed(5)}, ${lng.toFixed(5)})`
                            : label
                              ? `Location: ${label}`
                              : "Location"
                        }
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 10px",
                          borderRadius: 999,
                          border: "1px solid rgba(0,0,0,0.12)",
                          background: "rgba(0,0,0,0.03)",
                          fontSize: 12,
                          fontWeight: 900,
                          opacity: 0.9,
                          maxWidth: 360,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span aria-hidden="true">📍</span>
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {label ? label : ""}
                          {coordsOk
                            ? label
                              ? ` • ${lat.toFixed(5)}, ${lng.toFixed(5)}`
                              : `${lat.toFixed(5)}, ${lng.toFixed(5)}`
                            : ""}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Absolutely-positioned document title at far-right of the left column header */}
              <div
                style={{
                  position: "absolute",
                  right: 16,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontWeight: 900,
                  fontSize: 15,
                  opacity: 0.9,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "45%",
                  textAlign: "right",
                }}
                title={documentTitle ? documentTitle : "(Untitled document)"}
              >
                {documentTitle ? documentTitle : "(Untitled document)"}
              </div>
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
                minHeight: 0,
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
                  onMouseDown={onHitSvgMouseDown}
                  onMouseUp={onHitSvgMouseUp}
                  onClick={onHitSvgClick}
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: "100%",
                    height: "100%",
                    pointerEvents: "auto",
                    cursor: isDrawingLowConfBox ? "crosshair" : "default",
                  }}
                />

                {/* Visible highlight layer (non-interactive) */}
                <svg
                  ref={highlightSvgRef}
                  viewBox="0 0 1 1"
                  preserveAspectRatio="none"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: "100%",
                    height: "100%",
                    pointerEvents: "none",
                  }}
                >
                  {/* Active hover/selection highlight */}
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

                  {/* While drawing: live preview box */}
                  {drawPreviewBox ? (
                    <rect
                      x={drawPreviewBox.x}
                      y={drawPreviewBox.y}
                      width={drawPreviewBox.w}
                      height={drawPreviewBox.h}
                      fill="rgba(40, 80, 255, 0.06)"
                      stroke="rgba(40, 80, 255, 0.95)"
                      strokeWidth={3}
                      strokeDasharray="8 6"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}

                  {/* While locked OR in drawing mode (not dragging): show hovered block bbox without changing right-panel selection */}
                  {(lowConfLockKey || isDrawingLowConfBox) &&
                  !drawPreviewBox &&
                  drawHoverBox ? (
                    <rect
                      x={drawHoverBox.x}
                      y={drawHoverBox.y}
                      width={drawHoverBox.w}
                      height={drawHoverBox.h}
                      fill="rgba(0,0,0,0)"
                      stroke="rgba(255, 200, 0, 0.95)"
                      strokeWidth={3}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}

                  {/* Saved user-drawn box for the currently active low-confidence block */}
                  {pageKey &&
                  activeParagraphId &&
                  lowConfByPid[String(activeParagraphId)]
                    ? (() => {
                        const k = `${pageKey}|${String(activeParagraphId)}`;
                        const b = lowConfDrawnBoxByKey[k];
                        if (!b) return null;
                        return (
                          <rect
                            x={b.x}
                            y={b.y}
                            width={b.w}
                            height={b.h}
                            fill="rgba(40, 80, 255, 0.06)"
                            stroke="rgba(40, 80, 255, 0.95)"
                            strokeWidth={3}
                            vectorEffect="non-scaling-stroke"
                          />
                        );
                      })()
                    : null}
                </svg>
              </div>
            </div>
          </div>

          <div
            ref={rightScrollRef}
            style={{
              padding: 12,
              overflow: isLowConfLocked ? "hidden" : "auto",
              minHeight: 0,
            }}
          >
            {/* Sticky transcription mode toggle */}
            <div
              style={{
                position: "sticky",
                top: 0,
                background: "white",
                paddingBottom: 10,
                zIndex: 2,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 14, opacity: 0.8 }}>
                  Transcription Source
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => setAutoScrollEnabled((v) => !v)}
                    style={{
                      ...btnBase,
                      padding: "6px 10px",
                      fontSize: 12,
                      fontWeight: 900,
                      border: "1px solid rgba(0,0,0,0.14)",
                      background: autoScrollEnabled
                        ? "white"
                        : "rgba(0,0,0,0.05)",
                      opacity: autoScrollEnabled ? 1 : 0.85,
                    }}
                    onMouseDown={preventMouseDownFocus}
                    onFocus={blurOnFocus}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.transform = "translateY(1px)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.transform = "translateY(0px)")
                    }
                    aria-pressed={autoScrollEnabled}
                    title="Toggle auto-scrolling of the right panel when hovering the PDF"
                  >
                    Auto-Scroll: {autoScrollEnabled ? "On" : "Off"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTranscriptionMode("lines")}
                    aria-pressed={transcriptionMode === "lines"}
                    style={{
                      ...btnBase,
                      ...(transcriptionMode === "lines"
                        ? {
                            border: "1px solid rgba(0,0,0,0.22)",
                            background: "white",
                            fontWeight: 900,
                          }
                        : {
                            border: "1px solid rgba(0,0,0,0.14)",
                            background: "white",
                            fontWeight: 800,
                            opacity: 0.85,
                          }),
                    }}
                    onMouseDown={(e) => {
                      // prevent the "stuck selected" look from focus rings
                      e.preventDefault();
                      (e.currentTarget as HTMLButtonElement).blur();
                    }}
                    onFocus={blurOnFocus}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.transform = "translateY(1px)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.transform = "translateY(0px)")
                    }
                  >
                    By Line
                  </button>
                  <button
                    type="button"
                    onClick={() => setTranscriptionMode("paragraph")}
                    aria-pressed={transcriptionMode === "paragraph"}
                    style={{
                      ...btnBase,
                      ...(transcriptionMode === "paragraph"
                        ? {
                            border: "1px solid rgba(0,0,0,0.22)",
                            background: "white",
                            fontWeight: 900,
                          }
                        : {
                            border: "1px solid rgba(0,0,0,0.14)",
                            background: "white",
                            fontWeight: 800,
                            opacity: 0.85,
                          }),
                    }}
                    onMouseDown={(e) => {
                      // prevent the "stuck selected" look from focus rings
                      e.preventDefault();
                      (e.currentTarget as HTMLButtonElement).blur();
                    }}
                    onFocus={blurOnFocus}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.transform = "translateY(1px)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.transform = "translateY(0px)")
                    }
                  >
                    By Paragraph
                  </button>
                </div>
              </div>
            </div>

            {transcriptionMode === "paragraph" ? (
              paragraphItems.length ? (
                <div
                  style={{
                    position: "relative",
                    display: "grid",
                    gap: 10,
                    fontSize: 16,
                  }}
                >
                  {isLowConfLocked ? (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        zIndex: 1,
                        cursor: "not-allowed",
                      }}
                    />
                  ) : null}
                  {paragraphItems.map((p) => {
                    const isActive = activeParagraphId === p.pid;
                    const lowMeta = lowConfByPid[p.pid];
                    const isLowConf = !!lowMeta;
                    const lowKey = `${pageKey}|${p.pid}`;

                    const saved = lowConfLabelsByKey[lowKey];
                    const draft = lowConfDraftByKey[lowKey] || {
                      corrected_class: saved?.corrected_class || "Paragraph",
                      other_text: saved?.other_text || "",
                    };

                    const isThisLocked = lowConfLockKey === lowKey;

                    return (
                      <div
                        key={p.pid}
                        ref={(el) => {
                          paragraphElByIdRef.current[String(p.pid)] = el;
                        }}
                        onMouseEnter={() => {
                          if (isDrawingLowConfBox) return;
                          setActiveSource("right");
                          setActiveParagraphId(p.pid);
                          setActiveId(null);
                          setActiveBox(p.box);
                        }}
                        onMouseLeave={() => {
                          if (isDrawingLowConfBox) return;
                          setActiveSource(null);
                          setActiveParagraphId(null);
                          setActiveBox(null);
                        }}
                        onClick={() => {
                          if (isDrawingLowConfBox) return;
                          setActiveSource("right");
                          setActiveParagraphId(p.pid);
                          setActiveId(null);
                          setActiveBox(p.box);
                        }}
                        style={{
                          padding: "10px 6px",
                          borderRadius: 10,
                          lineHeight: 1.35,
                          cursor: "pointer",
                          border: "1px solid rgba(0,0,0,0.06)",
                          background: isActive
                            ? "rgba(255,242,168,0.75)"
                            : isLowConf
                              ? "rgba(255,242,168,0.28)"
                              : "transparent",
                          boxShadow: "none",
                          fontFamily: "Georgia, 'Times New Roman', serif",
                          fontSize: 15,
                          position: "relative",
                          zIndex: isThisLocked ? 2 : "auto",
                        }}
                      >
                        {/* Always-visible low-confidence badge */}
                        {isLowConf ? (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 10,
                              marginBottom: 6,
                              padding: "6px 10px",
                              borderRadius: 12,
                              border: "1px solid rgba(255, 200, 0, 0.35)",
                              background: "rgba(255, 242, 168, 0.22)",
                              fontFamily: "ui-sans-serif, system-ui",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                color: "rgba(120,80,0,0.92)",
                              }}
                            >
                              Low confidence •{" "}
                              {Math.round(lowMeta?.confPct ?? 0)}%
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                opacity: 0.7,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {lowMeta?.predicted_class
                                ? String(lowMeta.predicted_class)
                                : ""}
                            </div>
                          </div>
                        ) : null}

                        <div
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                          }}
                        >
                          <div style={{ flex: 1, whiteSpace: "pre-wrap" }}>
                            {p.text}
                          </div>
                          <button
                            type="button"
                            aria-label="Suggest edit"
                            title="Suggest edit"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (openSuggestUid === p.pid) {
                                setOpenSuggestUid(null);
                                setSuggestText("");
                                setSuggestComment("");
                              } else {
                                setOpenSuggestUid(p.pid);
                                setSuggestText(p.text);
                                setSuggestComment("");
                              }
                            }}
                            style={iconBtn}
                            onMouseDown={preventMouseDownFocus}
                            onFocus={blurOnFocus}
                            onMouseEnter={(e) => {
                              (
                                e.currentTarget as HTMLButtonElement
                              ).style.background = "rgba(0,0,0,0.06)";
                              (
                                e.currentTarget as HTMLButtonElement
                              ).style.transform = "translateY(1px)";
                            }}
                            onMouseLeave={(e) => {
                              (
                                e.currentTarget as HTMLButtonElement
                              ).style.background = "transparent";
                              (
                                e.currentTarget as HTMLButtonElement
                              ).style.transform = "translateY(0px)";
                            }}
                          >
                            <PencilGlyph size={16} />
                          </button>
                        </div>

                        {/* Low-confidence dropdown editor: only show when active AND low confidence */}
                        {(isActive || isThisLocked) && isLowConf ? (
                          <div
                            style={{
                              marginTop: 10,
                              padding: 10,
                              borderRadius: 12,
                              border: "1px solid rgba(255, 200, 0, 0.45)",
                              background: "rgba(255, 242, 168, 0.25)",
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 10,
                              }}
                            >
                              <div style={{ fontWeight: 900, fontSize: 13 }}>
                                Low confidence • {Math.round(lowMeta.confPct)}%
                              </div>
                              {saved?.updated_at ? (
                                <div
                                  style={{
                                    fontSize: 12,
                                    opacity: 0.65,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  saved
                                </div>
                              ) : null}
                            </div>

                            <div
                              style={{
                                display: "flex",
                                gap: 10,
                                alignItems: "center",
                                marginTop: 10,
                                flexWrap: "wrap",
                              }}
                            >
                              <div style={{ fontSize: 12, opacity: 0.75 }}>
                                This is actually:
                              </div>

                              <select
                                value={draft.corrected_class}
                                onChange={(e) => {
                                  const v = e.target.value as any;
                                  setLowConfDraftByKey((prev) => ({
                                    ...prev,
                                    [lowKey]: {
                                      corrected_class: v,
                                      other_text:
                                        v === "Other"
                                          ? draft.other_text || ""
                                          : "",
                                    },
                                  }));
                                }}
                                style={{
                                  padding: "6px 10px",
                                  borderRadius: 10,
                                  border: "1px solid rgba(0,0,0,0.15)",
                                  background: "white",
                                  fontWeight: 800,
                                  fontSize: 12,
                                  cursor: "pointer",
                                }}
                              >
                                <option value="Paragraph">Paragraph</option>
                                <option value="List">List</option>
                                <option value="Table">Table</option>
                                <option value="Other">Other</option>
                              </select>

                              {draft.corrected_class === "Other" ? (
                                <input
                                  value={draft.other_text}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setLowConfDraftByKey((prev) => ({
                                      ...prev,
                                      [lowKey]: {
                                        corrected_class: "Other",
                                        other_text: v,
                                      },
                                    }));
                                  }}
                                  placeholder="What is it?"
                                  style={{
                                    flex: "1 1 220px",
                                    minWidth: 180,
                                    padding: "6px 10px",
                                    borderRadius: 10,
                                    border: "1px solid rgba(0,0,0,0.15)",
                                  }}
                                />
                              ) : null}

                              <button
                                type="button"
                                onClick={() => {
                                  setIsDrawingLowConfBox((v) => {
                                    const next = !v;
                                    if (next) {
                                      // turning on — lock immediately so Cancel appears right away
                                      beginLowConfLock(lowKey);
                                      drawStartRef.current = null;
                                      setDrawPreviewBox(null);
                                      setDrawHoverBox(null);
                                    } else {
                                      // turning off
                                      drawStartRef.current = null;
                                      setDrawPreviewBox(null);
                                      setDrawHoverBox(null);
                                    }
                                    return next;
                                  });
                                }}
                                style={{
                                  padding: "6px 10px",
                                  fontSize: 12,
                                  borderRadius: 10,
                                  border: "1px solid rgba(0,0,0,0.18)",
                                  background: isDrawingLowConfBox
                                    ? "rgba(40, 80, 255, 0.10)"
                                    : "white",
                                  cursor: "pointer",
                                  fontWeight: 900,
                                  whiteSpace: "nowrap",
                                }}
                                title="Draw a corrected bounding box on the left PDF by click-dragging"
                              >
                                {isDrawingLowConfBox
                                  ? "Drawing… (drag on PDF)"
                                  : "Draw box"}
                              </button>

                              <button
                                type="button"
                                disabled={!user || !!isSavingLowConf[lowKey]}
                                onClick={async () => {
                                  if (!user)
                                    return alert(
                                      "Please sign in to save labels.",
                                    );

                                  setIsSavingLowConf((prev) => ({
                                    ...prev,
                                    [lowKey]: true,
                                  }));
                                  try {
                                    await saveLowConfLabel({
                                      page_key: pageKey,
                                      target_pid: p.pid,
                                      predicted_class: lowMeta.predicted_class,
                                      predicted_confidence:
                                        lowMeta.predicted_confidence,
                                      corrected_class: draft.corrected_class,
                                      other_text: draft.other_text || "",
                                    });

                                    // ✅ unlock after save (only if this block is the one locked)
                                    if (lowConfLockKey === lowKey) {
                                      clearLowConfLock();
                                    }
                                  } finally {
                                    setIsSavingLowConf((prev) => ({
                                      ...prev,
                                      [lowKey]: false,
                                    }));
                                  }
                                }}
                                style={{
                                  padding: "6px 10px",
                                  fontSize: 12,
                                  borderRadius: 10,
                                  border: "1px solid rgba(0,0,0,0.18)",
                                  background: !user
                                    ? "rgba(0,0,0,0.06)"
                                    : "white",
                                  cursor: !user ? "not-allowed" : "pointer",
                                  fontWeight: 900,
                                  opacity: !user ? 0.65 : 1,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {isSavingLowConf[lowKey] ? "Saving…" : "Save"}
                              </button>

                              {/* ✅ cancel only shows when locked on THIS block */}
                              {isThisLocked ? (
                                <button
                                  type="button"
                                  onClick={() => cancelLowConfLock(lowKey)}
                                  style={{
                                    padding: "6px 10px",
                                    fontSize: 12,
                                    borderRadius: 10,
                                    border: "1px solid rgba(0,0,0,0.18)",
                                    background: "white",
                                    cursor: "pointer",
                                    fontWeight: 900,
                                    whiteSpace: "nowrap",
                                  }}
                                  title="Cancel drawing and restore the previous box"
                                >
                                  Cancel
                                </button>
                              ) : null}

                              {!user ? (
                                <div style={{ fontSize: 12, opacity: 0.7 }}>
                                  Sign in to save.
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        {/* (rest of your file continues unchanged) */}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ opacity: 0.75, fontSize: 15 }}>
                  No paragraph transcription available for this page.
                </div>
              )
            ) : (
              <div style={{ fontSize: 16 }}>
                {lines.map((l) => (
                  <div
                    key={l.uid}
                    ref={(el) => {
                      lineElByIdRef.current[String(l.uid)] = el;
                    }}
                    onMouseEnter={() => {
                      if (lowConfLockKey || isDrawingLowConfBox) return;
                      setActiveSource("right");
                      setActiveId(l.uid);
                      setActiveParagraphId(null);
                      setActiveBox(boxByUidRef.current[l.uid] ?? null);
                    }}
                    onMouseLeave={() => {
                      if (lowConfLockKey || isDrawingLowConfBox) return;
                      setActiveSource(null);
                      setActiveId(null);
                      setActiveBox(null);
                    }}
                    onClick={() => {
                      if (lowConfLockKey || isDrawingLowConfBox) return;
                      setActiveSource("right");
                      setActiveId(l.uid);
                      setActiveParagraphId(null);
                      setActiveBox(boxByUidRef.current[l.uid] ?? null);
                    }}
                    style={{
                      padding: "10px 6px",
                      borderRadius: 10,
                      lineHeight: 1.3,
                      fontSize: 15,
                      cursor: "pointer",
                      border: "1px solid rgba(0,0,0,0.06)",
                      background:
                        activeId === l.uid
                          ? "rgba(255,242,168,0.75)"
                          : "transparent",
                      boxShadow: "none",
                      fontFamily: "Georgia, 'Times New Roman', serif",
                    }}
                  >
                    <div
                      style={{ display: "flex", gap: 10, alignItems: "center" }}
                    >
                      <div style={{ flex: 1, whiteSpace: "pre-wrap" }}>
                        {l.transcription}
                      </div>
                      <button
                        type="button"
                        aria-label="Suggest edit"
                        title="Suggest edit"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (openSuggestUid === l.uid) {
                            setOpenSuggestUid(null);
                            setSuggestText("");
                            setSuggestComment("");
                          } else {
                            setOpenSuggestUid(l.uid);
                            setSuggestText(l.transcription);
                            setSuggestComment("");
                          }
                        }}
                        style={iconBtn}
                        onMouseDown={preventMouseDownFocus}
                        onFocus={blurOnFocus}
                        onMouseEnter={(e) => {
                          (
                            e.currentTarget as HTMLButtonElement
                          ).style.background = "rgba(0,0,0,0.06)";
                          (
                            e.currentTarget as HTMLButtonElement
                          ).style.transform = "translateY(1px)";
                        }}
                        onMouseLeave={(e) => {
                          (
                            e.currentTarget as HTMLButtonElement
                          ).style.background = "transparent";
                          (
                            e.currentTarget as HTMLButtonElement
                          ).style.transform = "translateY(0px)";
                        }}
                      >
                        <PencilGlyph size={16} />
                      </button>
                    </div>

                    {openSuggestUid === l.uid ? (
                      <div
                        style={{ marginTop: 8 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <textarea
                          value={suggestText}
                          onChange={(e) => setSuggestText(e.target.value)}
                          rows={3}
                          style={{
                            width: "100%",
                            padding: 8,
                            borderRadius: 10,
                            border: "1px solid rgba(0,0,0,0.15)",
                          }}
                        />
                        <textarea
                          value={suggestComment}
                          onChange={(e) => setSuggestComment(e.target.value)}
                          rows={2}
                          placeholder="Optional note (why this edit?)"
                          style={{
                            width: "100%",
                            padding: 8,
                            borderRadius: 10,
                            border: "1px solid rgba(0,0,0,0.15)",
                            marginTop: 8,
                          }}
                        />
                        <div
                          style={{
                            display: "flex",
                            gap: 10,
                            marginTop: 10,
                            alignItems: "center",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              submitSuggestion(l.uid, l.transcription)
                            }
                            style={btnBase}
                            onMouseDown={preventMouseDownFocus}
                            onFocus={blurOnFocus}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.transform =
                                "translateY(1px)")
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.transform =
                                "translateY(0px)")
                            }
                          >
                            Submit
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setOpenSuggestUid(null);
                              setSuggestText("");
                              setSuggestComment("");
                            }}
                            style={btnBase}
                            onMouseDown={preventMouseDownFocus}
                            onFocus={blurOnFocus}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.transform =
                                "translateY(1px)")
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.transform =
                                "translateY(0px)")
                            }
                          >
                            Cancel
                          </button>

                          {!user ? (
                            <div
                              style={{
                                marginLeft: "auto",
                                fontSize: 12,
                                opacity: 0.8,
                              }}
                            >
                              Sign in to submit.
                            </div>
                          ) : null}
                        </div>

                        <div
                          style={{
                            height: 2,
                            background: "rgba(0,0,0,0.18)",
                            marginTop: 12,
                          }}
                        />
                      </div>
                    ) : null}

                    {!collapseSuggestions && suggestionsByUid[l.uid]?.length ? (
                      <div
                        style={{ marginTop: 10, fontSize: 14 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                            marginBottom: 6,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setCollapsedUid((prev) => ({
                                ...prev,
                                [l.uid]: !prev[l.uid],
                              }))
                            }
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              fontWeight: 800,
                              padding: "6px 10px",
                              borderRadius: 10,
                              border: "1px solid rgba(0,0,0,0.12)",
                              background: "white",
                              cursor: "pointer",
                              boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                              outline: "none",
                              appearance: "none",
                            }}
                            onMouseDown={preventMouseDownFocus}
                            onFocus={blurOnFocus}
                          >
                            <span>Suggestions</span>
                            <span style={{ fontSize: 12, opacity: 0.8 }}>
                              {collapsedUid[l.uid] ? "▸" : "▾"}
                            </span>
                            <span style={{ fontSize: 12, opacity: 0.65 }}>
                              ({suggestionsByUid[l.uid].length})
                            </span>
                          </button>

                          <div
                            style={{ display: "flex", alignItems: "center" }}
                          >
                            <select
                              aria-label="Sort suggestions"
                              value={sortModeByUid[l.uid] ?? "top"}
                              onChange={(e) =>
                                setSortModeByUid((prev) => ({
                                  ...prev,
                                  [l.uid]: e.target.value as "top" | "newest",
                                }))
                              }
                              style={{
                                padding: "6px 10px",
                                borderRadius: 10,
                                border: "1px solid rgba(0,0,0,0.12)",
                                background: "white",
                                fontSize: 12,
                                fontWeight: 800,
                                outline: "none",
                                cursor: "pointer",
                              }}
                            >
                              <option value="top">Upvotes</option>
                              <option value="newest">Newest</option>
                            </select>
                          </div>
                        </div>

                        {!collapsedUid[l.uid] &&
                          getSortedSuggestions(l.uid)
                            .slice(0, 5)
                            .map((s) => (
                              <div
                                key={s.id}
                                style={{
                                  padding: "6px 8px",
                                  border: "1px solid rgba(0,0,0,0.10)",
                                  borderRadius: 10,
                                  marginBottom: 6,
                                  fontSize: 14,
                                  background: "rgba(255,255,255,0.75)",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "flex-start",
                                    gap: 10,
                                  }}
                                >
                                  <div
                                    style={{ whiteSpace: "pre-wrap", flex: 1 }}
                                  >
                                    {s.suggested_text}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 13,
                                      opacity: 0.85,
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    ▲ {s.vote_count ?? 0}
                                  </div>
                                </div>

                                {s.comment ? (
                                  <div
                                    style={{
                                      marginTop: 6,
                                      fontSize: 12,
                                      opacity: 0.85,
                                      whiteSpace: "pre-wrap",
                                    }}
                                  >
                                    <span style={{ fontWeight: 700 }}>
                                      Note:
                                    </span>{" "}
                                    {s.comment}
                                  </div>
                                ) : null}

                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    gap: 10,
                                    marginTop: 8,
                                  }}
                                >
                                  <div style={{ minWidth: 0 }}>
                                    <div
                                      style={{
                                        fontSize: 13,
                                        opacity: 0.75,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      by{" "}
                                      {s.author_username ||
                                        usernameByUserId[s.user_id] ||
                                        `user:${s.user_id.slice(0, 8)}`}{" "}
                                      •{" "}
                                      {new Date(s.created_at).toLocaleString()}
                                    </div>
                                    {!user ? (
                                      <div
                                        style={{
                                          marginTop: 4,
                                          fontSize: 12,
                                          opacity: 0.8,
                                        }}
                                      >
                                        Sign in to vote.
                                      </div>
                                    ) : null}
                                  </div>

                                  <button
                                    type="button"
                                    disabled={!user}
                                    onMouseEnter={() => setHoverVoteId(s.id)}
                                    onMouseLeave={() =>
                                      setHoverVoteId((cur) =>
                                        cur === s.id ? null : cur,
                                      )
                                    }
                                    onClick={() => upvoteSuggestion(s.id)}
                                    style={{
                                      padding: "6px 10px",
                                      fontSize: 12,
                                      borderRadius: 10,
                                      border: "1px solid rgba(0,0,0,0.18)",
                                      background: !user
                                        ? "rgba(0,0,0,0.06)"
                                        : "white",
                                      cursor: !user ? "not-allowed" : "pointer",
                                      transition:
                                        "transform 120ms ease, box-shadow 120ms ease, background 120ms ease",
                                      transform:
                                        hoverVoteId === s.id && user
                                          ? "translateY(1px)"
                                          : "translateY(0px)",
                                      boxShadow:
                                        hoverVoteId === s.id && user
                                          ? "inset 0 2px 4px rgba(0,0,0,0.18)"
                                          : "0 1px 2px rgba(0,0,0,0.10)",
                                      opacity: !user ? 0.6 : 1,
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    Upvote
                                  </button>
                                </div>
                              </div>
                            ))}

                        {collapsedUid[l.uid] ? (
                          <div
                            style={{
                              marginTop: 4,
                              opacity: 0.7,
                              paddingLeft: 2,
                            }}
                          >
                            Click “Suggestions” to expand.
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Close the 2-panel grid before rendering overlays */}
        </div>
      )}

      {/* ADD LOCATION MODAL OVERLAY */}
      {showAddLocation ? (
        <div
          {...backdropHandlers(() => setShowAddLocation(false))}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.18)",
            zIndex: 100000,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            paddingTop: 70,
            paddingLeft: 16,
            paddingRight: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 92vw)",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 16,
              padding: 14,
              background: "rgba(255,255,255,0.98)",
              boxShadow: "0 18px 50px rgba(0,0,0,0.18)",
              fontFamily: "ui-sans-serif, system-ui",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, fontSize: 16 }}>
                Add location for Page {pageKeyToNumber(pageKey) ?? ""}
              </div>
              <button
                type="button"
                onClick={() => setShowAddLocation(false)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 800,
                  outline: "none",
                  appearance: "none",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
              This location will be saved for{" "}
              <b>Page {pageKeyToNumber(pageKey) ?? ""}</b> and will appear on
              the map trail.
            </div>

            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <input
                value={locLabel}
                onChange={(e) => setLocLabel(e.target.value)}
                placeholder="Label (optional)"
                style={{
                  padding: "10px 12px",
                  border: "1px solid rgba(0,0,0,0.15)",
                  borderRadius: 12,
                }}
              />

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                }}
              >
                <input
                  value={locLat}
                  onChange={(e) => setLocLat(e.target.value)}
                  placeholder="Latitude in Degrees (e.g. 45.5017)"
                  style={{
                    padding: "10px 12px",
                    border: "1px solid rgba(0,0,0,0.15)",
                    borderRadius: 12,
                  }}
                />
                <input
                  value={locLng}
                  onChange={(e) => setLocLng(e.target.value)}
                  placeholder="Longitude in Degrees (e.g. -73.5673)"
                  style={{
                    padding: "10px 12px",
                    border: "1px solid rgba(0,0,0,0.15)",
                    borderRadius: 12,
                  }}
                />
              </div>

              <textarea
                value={locNote}
                onChange={(e) => setLocNote(e.target.value)}
                rows={3}
                placeholder="Note (optional)"
                style={{
                  padding: "10px 12px",
                  border: "1px solid rgba(0,0,0,0.15)",
                  borderRadius: 12,
                  resize: "vertical",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 12,
                alignItems: "center",
              }}
            >
              <button
                type="button"
                onClick={saveLocationForCurrentPage}
                disabled={isSavingLocation}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: isSavingLocation ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                  opacity: isSavingLocation ? 0.6 : 1,
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                {isSavingLocation ? "Saving…" : "Save location"}
              </button>

              <button
                type="button"
                onClick={() => setShowAddLocation(false)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.14)",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 800,
                  color: "rgba(0,0,0,0.75)",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* COMMUNITY LEADERBOARD MODAL */}
      {showLeaderboard ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.18)",
            zIndex: 100000,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            paddingTop: 70,
            paddingLeft: 16,
            paddingRight: 16,
          }}
          onClick={() => setShowLeaderboard(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "relative",
              zIndex: 100001,
              width: "min(720px, 92vw)",
              borderRadius: 16,
              background: "rgba(255,255,255,0.98)",
              boxShadow: "0 18px 50px rgba(0,0,0,0.18)",
              border: "1px solid rgba(0,0,0,0.12)",
              padding: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, fontSize: 16 }}>
                Community Leaderboard
              </div>
              <button
                type="button"
                onClick={() => setShowLeaderboard(false)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 800,
                  outline: "none",
                  appearance: "none",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
              Top contributors ranked by total upvotes received on their
              suggestions.
            </div>

            <div style={{ marginTop: 12 }}>
              {isLoadingLeaderboard ? (
                <div style={{ padding: 10, opacity: 0.75 }}>Loading…</div>
              ) : leaderboardRows.length ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {leaderboardRows.map((r, idx) => (
                    <div
                      key={r.user_id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "10px 12px",
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "white",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 999,
                            background: "rgba(0,0,0,0.08)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 900,
                            fontSize: 12,
                            flex: "0 0 auto",
                          }}
                        >
                          {idx + 1}
                        </div>
                        <div
                          style={{
                            fontWeight: 900,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.username ||
                            `user:${String(r.user_id).slice(0, 8)}`}
                        </div>
                      </div>
                      <div style={{ fontWeight: 900, whiteSpace: "nowrap" }}>
                        ▲ {Number(r.upvotes || 0).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding: 10, opacity: 0.75 }}>No votes yet.</div>
              )}
            </div>

            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 14,
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={() => loadLeaderboard()}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 900,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => setShowLeaderboard(false)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.14)",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 800,
                  color: "rgba(0,0,0,0.75)",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {/* SIGN IN MODAL OVERLAY */}
      {showSignin ? (
        <div
          {...backdropHandlers(() => setShowSignin(false))}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.18)",
            zIndex: 100000,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            paddingTop: 70,
            paddingLeft: 16,
            paddingRight: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 92vw)",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 16,
              padding: 14,
              background: "rgba(255,255,255,0.98)",
              boxShadow: "0 18px 50px rgba(0,0,0,0.18)",
              fontFamily: "ui-sans-serif, system-ui",
              position: "relative",
              zIndex: 100001,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, fontSize: 16 }}>Sign in</div>
              <button
                type="button"
                onClick={() => setShowSignin(false)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 800,
                  outline: "none",
                  appearance: "none",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <input
                value={signinId}
                onChange={(e) => setSigninId(e.target.value)}
                placeholder="Username or email"
                style={{
                  padding: "10px 12px",
                  border: "1px solid rgba(0,0,0,0.15)",
                  borderRadius: 12,
                }}
              />
              <input
                type="password"
                value={signinPw}
                onChange={(e) => setSigninPw(e.target.value)}
                placeholder="Password"
                style={{
                  padding: "10px 12px",
                  border: "1px solid rgba(0,0,0,0.15)",
                  borderRadius: 12,
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={signIn}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 900,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Sign in
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowSignin(false);
                  setShowSignup(true);
                }}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.14)",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 800,
                  color: "rgba(0,0,0,0.75)",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Create account
              </button>

              <button
                type="button"
                onClick={forgotPassword}
                style={{
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 800,
                  color: "rgba(0,0,0,0.65)",
                  textDecoration: "underline",
                  marginLeft: "auto",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Forgot password?
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* SIGN UP MODAL OVERLAY */}
      {showSignup ? (
        <div
          {...backdropHandlers(() => setShowSignup(false))}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.18)",
            zIndex: 100000,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            paddingTop: 70,
            paddingLeft: 16,
            paddingRight: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 92vw)",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 16,
              padding: 14,
              background: "rgba(255,255,255,0.98)",
              boxShadow: "0 18px 50px rgba(0,0,0,0.18)",
              fontFamily: "ui-sans-serif, system-ui",
              position: "relative",
              zIndex: 100001,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, fontSize: 16 }}>
                Create account
              </div>
              <button
                type="button"
                onClick={() => setShowSignup(false)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 800,
                  outline: "none",
                  appearance: "none",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <input
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                placeholder="Email"
                style={{
                  padding: "10px 12px",
                  border: "1px solid rgba(0,0,0,0.15)",
                  borderRadius: 12,
                }}
              />
              <input
                value={signupUsername}
                onChange={(e) => setSignupUsername(e.target.value)}
                placeholder="Username"
                style={{
                  padding: "10px 12px",
                  border: "1px solid rgba(0,0,0,0.15)",
                  borderRadius: 12,
                }}
              />
              <input
                type="password"
                value={signupPw}
                onChange={(e) => setSignupPw(e.target.value)}
                placeholder="Password"
                style={{
                  padding: "10px 12px",
                  border: "1px solid rgba(0,0,0,0.15)",
                  borderRadius: 12,
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={signUp}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 900,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Sign up
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowSignup(false);
                  setShowSignin(true);
                }}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.14)",
                  background: "transparent",
                  cursor: "pointer",
                  fontWeight: 800,
                  color: "rgba(0,0,0,0.75)",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Back to sign in
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
