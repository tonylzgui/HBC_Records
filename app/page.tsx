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
  comment?: string | null;
  user_id: string;
  created_at: string;
  vote_count?: number;
  author_username?: string | null; // snapshot stored on suggestion
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
  // Removed inline sign-in state.

  const [showSignup, setShowSignup] = useState(false);
  const [showSignin, setShowSignin] = useState(false);
  const [signinId, setSigninId] = useState(""); // username OR email
  const [signinPw, setSigninPw] = useState("");

  const [signupEmail, setSignupEmail] = useState("");
  const [signupUsername, setSignupUsername] = useState("");
  const [signupPw, setSignupPw] = useState("");
  const [user, setUser] = useState<{ id: string; email: string | null } | null>(null);
  const [documentTitle, setDocumentTitle] = useState<string>("");

  // Suggestions (grouped by uid)
  const [suggestionsByUid, setSuggestionsByUid] = useState<Record<string, SuggestionRow[]>>({});
  const [openSuggestUid, setOpenSuggestUid] = useState<string | null>(null);
  const [suggestText, setSuggestText] = useState<string>("");
  const [suggestComment, setSuggestComment] = useState<string>("");
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [collapseSuggestions, setCollapseSuggestions] = useState(false);
  const [collapsedUid, setCollapsedUid] = useState<Record<string, boolean>>({});
  const [sortModeByUid, setSortModeByUid] = useState<Record<string, "top" | "newest">>({});
  const [hoverVoteId, setHoverVoteId] = useState<string | null>(null);
  const [usernameByUserId, setUsernameByUserId] = useState<Record<string, string>>({});

  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboardRows, setLeaderboardRows] = useState<Array<{ user_id: string; username: string; upvotes: number }>>(
    []
  );
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);

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
    return Object.keys(doc).sort((a, b) => (pageKeyToNumber(a) ?? 0) - (pageKeyToNumber(b) ?? 0));
  }, [doc, pdf]);

  useEffect(() => {
    if (!pageKeys.length) return;
    if (!pageKey || !pageKeys.includes(pageKey)) {
      setPageKey(pageKeys[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKeys]);

  async function loadSuggestionsForPage(docId: string, pk: string) {
    if (!docId || !pk) return;
    setIsLoadingSuggestions(true);
    try {
      const { data, error } = await supabase
        .from("suggestions")
        .select("id,document_id,page_key,uid,suggested_text,comment,user_id,created_at,author_username,suggestion_votes(count)")
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
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
      }

      setSuggestionsByUid(grouped);

      // Fetch usernames for any user_ids we haven't cached yet
      const userIds = Array.from(
        new Set(
          (data ?? [])
            .map((r: any) => String(r.user_id || ""))
            .filter((x: string) => x.length > 0)
        )
      );

      // Treat "missing" as: we don't have a non-empty username cached yet
      const missing = userIds.filter((id) => !(usernameByUserId[id]?.trim()?.length));

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
    if (!DOCUMENT_ID) return alert("Missing NEXT_PUBLIC_DOCUMENT_ID in .env.local");
    if (!pageKey) return;

    const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

    const text = normalizeText(suggestText);
    if (!text) return;

    const original = normalizeText(originalText || "");
    if (text === original) return alert("Your suggestion is identical to the current transcription.");

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

  async function ensureProfileUsername(userId: string, fallbackEmail?: string | null) {
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
    (fallbackEmail?.split("@")[0] ?? "").trim() || `user_${userId.slice(0, 6)}`;

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



  const { error } = await supabase
    .from("suggestion_votes")
    .upsert(
      {
        suggestion_id: suggestionId,
        user_id: user.id,
        vote: 1,
      },
      { onConflict: "suggestion_id,user_id" }
    );

  if (error) return alert(error.message);

  await loadSuggestionsForPage(DOCUMENT_ID, pageKey);
  }

  async function loadLeaderboard() {
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
        .map(([user_id, v]) => ({ user_id, upvotes: v.upvotes, username: v.username || "" }))
        .sort((a, b) => b.upvotes - a.upvotes)
        .slice(0, 10);

      // Enrich with profiles usernames
      const ids = arr.map((r) => r.user_id);
      if (ids.length) {
        const { data: profs, error: pErr } = await supabase.from("profiles").select("id, username").in("id", ids);
        if (!pErr && profs) {
          const byId: Record<string, string> = {};
          for (const p of profs as any[]) {
            const id = String(p?.id ?? "");
            const uname = String(p?.username ?? "").trim();
            if (id && uname) byId[id] = uname;
          }
          arr = arr.map((r) => ({
            ...r,
            username: byId[r.user_id] || r.username || `user:${r.user_id.slice(0, 8)}`,
          }));
        }
      }

      arr = arr.map((r) => ({ ...r, username: r.username || `user:${r.user_id.slice(0, 8)}` }));
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
      // NOTE: importing the package root keeps TypeScript happy (the legacy subpath often has no .d.ts).
      const pdfjsLib: any = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
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
    // auth
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      setUser(u ? { id: u.id, email: u.email } : null);
      if (u?.id) ensureProfileUsername(u.id, u.email);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const u = session?.user;
      setUser(u ? { id: u.id, email: u.email } : null);
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

    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signUp() {
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
        .upsert({ id: newUserId, username: uname, email }, { onConflict: "id" });

      if (pErr) console.warn("profiles upsert failed", pErr);

      setUsernameByUserId((prev) => ({ ...prev, [newUserId]: uname }));
    }

    setSignupPw("");
    setShowSignup(false);
    alert("Signed up. If email confirmation is enabled, confirm your email, then sign in.");
  }

  async function signIn() {
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
      if (!prof?.email) return alert("No account found for that username (or missing email in profiles).");

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
    await supabase.auth.signOut();
  }
  async function forgotPassword() {
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
      if (!prof?.email) return alert("No email found for that username. Please enter your email instead.");
      emailToUse = prof.email;
    }

    // Where Supabase should send them back after they click the email link
    const redirectTo = `${window.location.origin}`;

    const { error } = await supabase.auth.resetPasswordForEmail(emailToUse, { redirectTo });
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
      // If this PDF page has no transcription JSON, we still render the PDF,
      // but we disable hit-testing/highlights for this page.
      if (!doc[pageKey]) {
        setHitBoxes([]);
        setActiveId(null);
        setActiveBox(null);
        return;
      }

      const pageObj = doc[pageKey];
      const lines = pageObj ? getAllLinesForPage(pageObj) : [];
      const nextHitBoxes: Array<{ uid: string; x: number; y: number; w: number; h: number; area: number }> = [];

      for (const l of lines) {
        const pageW = pageObj!.width;
        const pageH = pageObj!.height;

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

  const onHitSvgClick: MouseEventHandler<SVGSVGElement> = (e) => {
    // If the user is drag-panning (zoomed-in), don't treat this as a click.
    if (isDraggingRef.current) return;

    // If this PDF page has no transcription JSON, there's nothing to open.
    if (!doc || !pageKey || !doc[pageKey]) return;

    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const uu = Math.min(1, Math.max(0, u));
    const vv = Math.min(1, Math.max(0, v));

    const picked = pickBoxAt(uu, vv);
    if (!picked) return;

    const uid = picked.uid;

    // Add: check if user clicked the same bbox as before
    const wasSame = activeId === uid;

    // Highlight + scroll the matching line on the right
    setActiveSource("left");
    setActiveId(uid);
    setActiveBox(boxByUidRef.current[uid] ?? null);

    // Ensure community suggestions are visible
    setCollapseSuggestions(false);

    setCollapsedUid((prev) => {
      const cur = !!prev[uid];
      if (!wasSame) return { ...prev, [uid]: false };
      // Same bbox clicked again -> toggle
      return { ...prev, [uid]: cur ? false : true };
    });

    // Do NOT open the suggest-edit form automatically
    setOpenSuggestUid(null);
  };



  function getSortedSuggestions(uid: string) {
  const arr = suggestionsByUid[uid] ? [...suggestionsByUid[uid]] : [];
  const mode = sortModeByUid[uid] ?? "top";

  if (mode === "newest") {
    arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return arr;
  }

  // "top": votes desc, then newest
  arr.sort((a, b) => {
    const va = a.vote_count ?? 0;
    const vb = b.vote_count ?? 0;
    if (vb !== va) return vb - va;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return arr;
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
    transition: "transform 120ms ease, box-shadow 120ms ease, background 120ms ease",
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
          zIndex: 5,
          flex: "0 0 auto",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 18 }}>Hudson&apos;s Bay Company Records</div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {!user ? (
            <>
              <button
              type="button"
              onClick={openLeaderboard}
              style={btnBase}
              onMouseDown={preventMouseDownFocus}
              onFocus={blurOnFocus}
              onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
              onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
            >
              Community Leaderboard
            </button>

              <button
                type="button"
                onClick={() => setCollapseSuggestions((v) => !v)}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
              >
                {collapseSuggestions ? "Show community suggestions" : "Hide community suggestions"}
              </button>

              <button
                type="button"
                onClick={() => setShowSignin(true)}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
              >
                Sign In
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, opacity: 0.9 }}>
                Signed in as <b>{usernameByUserId[user.id] || user.email || user.id}</b>
              </div>

              <button
                type="button"
                onClick={openLeaderboard}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
              >
                Community Leaderboard
              </button>

              <button
                type="button"
                onClick={() => setCollapseSuggestions((v) => !v)}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
              >
                {collapseSuggestions ? "Show community suggestions" : "Hide community suggestions"}
              </button>

              <button
                type="button"
                onClick={signOut}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
              >
                Sign Out
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main two-panel layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", flex: 1, minHeight: 0 }}>
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
            padding: 12,
            borderBottom: "1px solid #e6e6e6",
            background: "white",
            zIndex: 1,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            {isLoadingSuggestions ? <span style={{ fontSize: 12, opacity: 0.7 }}>Loading suggestions…</span> : null}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              justifyContent: "space-between",
            }}
          >
            {/* Controls (left) */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <select value={pageKey} onChange={(e) => setPageKey(e.target.value)}>
                {pageKeys.map((k) => (
                  <option key={k} value={k}>
                    Page {pageKeyToNumber(k) ?? ""}
                  </option>
                ))}
              </select>

              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <button type="button" onClick={zoomOut} style={{ padding: "4px 8px" }}>
                  −
                </button>
                <button type="button" onClick={zoomReset} style={{ padding: "4px 8px" }}>
                  {Math.round(zoom * 100)}%
                </button>
                <button type="button" onClick={zoomIn} style={{ padding: "4px 8px" }}>
                  +
                </button>
              </span>
            </div>

            {/* Document title (right) */}
            <div
              style={{
                fontWeight: 900,
                fontSize: 15,
                opacity: 0.9,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "55%",
                textAlign: "right",
              }}
              title={documentTitle ? documentTitle : "(Untitled document)"}
            >
              {documentTitle ? documentTitle : "(Untitled document)"}
            </div>
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
              onClick={onHitSvgClick}
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

      <div ref={rightScrollRef} style={{ padding: 12, overflow: "auto", minHeight: 0, fontSize: 15 }}>
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
              fontSize: 16,
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
                    setSuggestComment("");
                  } else {
                    setOpenSuggestUid(l.uid);
                    setSuggestText(l.transcription);
                    setSuggestComment("");
                  }
                }}
                style={btnTiny}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Suggest Edit
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
                <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => submitSuggestion(l.uid, l.transcription)}
                    style={btnBase}
                    onMouseDown={preventMouseDownFocus}
                    onFocus={blurOnFocus}
                    onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
                    onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
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
                    onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
                    onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
                  >
                    Cancel
                  </button>

                  {!user ? <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>Sign in to submit.</div> : null}
                </div>

                {/* Divider so the live suggestions below are clearly separated */}
                <div style={{ height: 2, background: "rgba(0,0,0,0.18)", marginTop: 12 }} />
              </div>
            ) : null}

            {!collapseSuggestions && suggestionsByUid[l.uid]?.length ? (
              <div style={{ marginTop: 10, fontSize: 14 }} onClick={(e) => e.stopPropagation()}>
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
                    onClick={() => setCollapsedUid((prev) => ({ ...prev, [l.uid]: !prev[l.uid] }))}
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
                    <span style={{ fontSize: 12, opacity: 0.8 }}>{collapsedUid[l.uid] ? "▸" : "▾"}</span>
                    <span style={{ fontSize: 12, opacity: 0.65 }}>({suggestionsByUid[l.uid].length})</span>
                  </button>

                  <div style={{ display: "flex", alignItems: "center" }}>
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
                        {/* Row 1: suggestion text (left) + vote count (right) */}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            gap: 10,
                          }}
                        >
                          <div style={{ whiteSpace: "pre-wrap", flex: 1 }}>{s.suggested_text}</div>
                          <div style={{ fontSize: 13, opacity: 0.85, whiteSpace: "nowrap" }}>▲ {s.vote_count ?? 0}</div>
                        </div>

                        {/* Optional note */}
                        {s.comment ? (
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85, whiteSpace: "pre-wrap" }}>
                            <span style={{ fontWeight: 700 }}>Note:</span> {s.comment}
                          </div>
                        ) : null}

                        {/* Row 2: by/date (left) + upvote button (right) */}
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
                            <div style={{ fontSize: 13, opacity: 0.75, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              by {s.author_username || usernameByUserId[s.user_id] || `user:${s.user_id.slice(0, 8)}`} • {new Date(
                                s.created_at
                              ).toLocaleString()}
                            </div>
                            {!user ? (
                              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>Sign in to vote.</div>
                            ) : null}
                          </div>

                          <button
                            type="button"
                            disabled={!user}
                            onMouseEnter={() => setHoverVoteId(s.id)}
                            onMouseLeave={() => setHoverVoteId((cur) => (cur === s.id ? null : cur))}
                            onClick={() => upvoteSuggestion(s.id)}
                            style={{
                              padding: "6px 10px",
                              fontSize: 12,
                              borderRadius: 10,
                              border: "1px solid rgba(0,0,0,0.18)",
                              background: !user ? "rgba(0,0,0,0.06)" : "white",
                              cursor: !user ? "not-allowed" : "pointer",
                              transition: "transform 120ms ease, box-shadow 120ms ease, background 120ms ease",
                              transform: hoverVoteId === s.id && user ? "translateY(1px)" : "translateY(0px)",
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
                  <div style={{ marginTop: 4, opacity: 0.7, paddingLeft: 2 }}>
                    Click “Suggestions” to expand.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {/* LEADERBOARD MODAL OVERLAY */}
      {showLeaderboard ? (
        <div
          onClick={() => setShowLeaderboard(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.18)",
            zIndex: 9999,
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
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Community Leaderboard</div>
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

            <div style={{ marginTop: 12 }}>
              {isLoadingLeaderboard ? (
                <div style={{ fontSize: 13, opacity: 0.8 }}>Loading leaderboard…</div>
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
                        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <div style={{ width: 28, textAlign: "right", fontWeight: 900, opacity: 0.8 }}>#{idx + 1}</div>
                        <div
                          style={{
                            fontWeight: 900,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.username}
                        </div>
                      </div>
                      <div style={{ fontWeight: 900, opacity: 0.9 }}>▲ {r.upvotes}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, opacity: 0.8 }}>No votes yet.</div>
              )}
            </div>

            <div style={{ marginTop: 12, fontSize: 12, opacity: 0.65 }}>
              Ranked by total upvotes received on suggestions.
            </div>
          </div>
        </div>
      ) : null}
      {/* SIGNIN MODAL OVERLAY (does not affect layout) */}
      {!user && showSignin ? (
        <div
          onClick={() => setShowSignin(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.18)",
            zIndex: 9999,
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
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
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

            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <input
                value={signinId}
                onChange={(e) => setSigninId(e.target.value)}
                placeholder="username or email"
                style={{ padding: "10px 12px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12 }}
              />

              <input
                value={signinPw}
                onChange={(e) => setSigninPw(e.target.value)}
                placeholder="password"
                type="password"
                style={{ padding: "10px 12px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12 }}
              />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
              <button
                type="button"
                onClick={signIn}
                style={{
                  padding: "9px 14px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 900,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                  outline: "none",
                  appearance: "none",
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
                  if (signinId.trim().includes("@")) setSignupEmail(signinId.trim());
                  setShowSignup(true);
                }}
                style={{
                  padding: "9px 14px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 900,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                  outline: "none",
                  appearance: "none",
                }}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
              >
                Create account
              </button>

              <button type="button" onClick={forgotPassword} style={btnLink}>
                Forgot password?
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {/* SIGNUP MODAL OVERLAY (does not affect layout) */}
      {!user && showSignup ? (
        <div
          onClick={() => setShowSignup(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.18)",
            zIndex: 9999,
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
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Create an account</div>
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

            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <input
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                placeholder="email"
                style={{ padding: "10px 12px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12 }}
              />

              <input
                value={signupUsername}
                onChange={(e) => setSignupUsername(e.target.value)}
                placeholder="username (public)"
                style={{ padding: "10px 12px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12 }}
              />

              <input
                value={signupPw}
                onChange={(e) => setSignupPw(e.target.value)}
                placeholder="password"
                type="password"
                style={{ padding: "10px 12px", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12 }}
              />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
              <button
                type="button"
                onClick={signUp}
                style={btnBase}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(1px)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0px)")}
              >
                Create account
              </button>

              <button
                type="button"
                onClick={() => setShowSignup(false)}
                style={btnSecondary}
                onMouseDown={preventMouseDownFocus}
                onFocus={blurOnFocus}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.03)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                Cancel
              </button>

              <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>
                Username is shown publicly.
              </div>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}