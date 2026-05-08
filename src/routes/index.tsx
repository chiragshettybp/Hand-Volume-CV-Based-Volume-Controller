import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Hand, Activity, Cpu, Eye, Zap, Sparkles } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Hand Gesture Volume Controller — Real-time CV Demo" },
      {
        name: "description",
        content:
          "Control volume in real time with your thumb and index finger using your webcam. A live MediaPipe Hands computer vision demo.",
      },
    ],
  }),
});

type GestureState = "idle" | "loading" | "no-hand" | "tracking" | "denied";

function Index() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handsRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);

  // Smoothing state held in refs so RAF updates don't trigger re-renders
  const smoothedVolRef = useRef(0);
  const fpsRef = useRef({ last: performance.now(), frames: 0, value: 0 });

  const [active, setActive] = useState(false);
  const [state, setState] = useState<GestureState>("idle");
  const [volume, setVolume] = useState(0);
  const [distance, setDistance] = useState(0);
  const [confidence, setConfidence] = useState(0);
  const [fps, setFps] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Map distance (in normalized units) to 0-100 volume.
  // Typical pinch ≈ 0.02, full stretch ≈ 0.30 in normalized image coords.
  const mapDistanceToVolume = (d: number) => {
    const min = 0.03;
    const max = 0.28;
    const v = ((d - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, v));
  };

  const onResults = useCallback((results: any) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Match canvas size to video
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
    }

    // FPS
    const now = performance.now();
    fpsRef.current.frames += 1;
    if (now - fpsRef.current.last >= 500) {
      fpsRef.current.value = Math.round(
        (fpsRef.current.frames * 1000) / (now - fpsRef.current.last)
      );
      fpsRef.current.frames = 0;
      fpsRef.current.last = now;
      setFps(fpsRef.current.value);
    }

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Mirror to match the mirrored video display
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);

    const landmarks = results.multiHandLandmarks?.[0];
    const handedness = results.multiHandedness?.[0];

    if (landmarks && landmarks.length >= 21) {
      setState("tracking");
      setConfidence(Math.round((handedness?.score ?? 0) * 100));

      // Draw skeleton connections (simplified set)
      const CONNECTIONS: Array<[number, number]> = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [5, 9], [9, 10], [10, 11], [11, 12],
        [9, 13], [13, 14], [14, 15], [15, 16],
        [13, 17], [17, 18], [18, 19], [19, 20],
        [0, 17],
      ];
      ctx.strokeStyle = "rgba(150, 200, 255, 0.55)";
      ctx.lineWidth = 2;
      for (const [a, b] of CONNECTIONS) {
        const pa = landmarks[a];
        const pb = landmarks[b];
        ctx.beginPath();
        ctx.moveTo(pa.x * canvas.width, pa.y * canvas.height);
        ctx.lineTo(pb.x * canvas.width, pb.y * canvas.height);
        ctx.stroke();
      }
      // Joints
      ctx.fillStyle = "rgba(180, 220, 255, 0.9)";
      for (const lm of landmarks) {
        ctx.beginPath();
        ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      const thumb = landmarks[4];
      const index = landmarks[8];
      const tx = thumb.x * canvas.width;
      const ty = thumb.y * canvas.height;
      const ix = index.x * canvas.width;
      const iy = index.y * canvas.height;

      // Connection line thumb-index
      const grad = ctx.createLinearGradient(tx, ty, ix, iy);
      grad.addColorStop(0, "rgba(180, 120, 255, 0.95)");
      grad.addColorStop(1, "rgba(80, 180, 255, 0.95)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      // Fingertip glow circles
      const drawTip = (x: number, y: number, color: string) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, 22);
        g.addColorStop(0, color);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      };
      drawTip(tx, ty, "rgba(180, 120, 255, 0.7)");
      drawTip(ix, iy, "rgba(80, 200, 255, 0.7)");

      // Midpoint pulse
      const mx = (tx + ix) / 2;
      const my = (ty + iy) / 2;
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, my, 10 + Math.sin(now / 200) * 4, 0, Math.PI * 2);
      ctx.stroke();

      // Compute Euclidean distance in normalized space
      const dx = thumb.x - index.x;
      const dy = thumb.y - index.y;
      const dz = (thumb.z ?? 0) - (index.z ?? 0);
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const target = mapDistanceToVolume(dist);
      // Exponential smoothing to reduce jitter
      smoothedVolRef.current = smoothedVolRef.current * 0.75 + target * 0.25;

      setDistance(dist);
      setVolume(smoothedVolRef.current);
    } else {
      setState("no-hand");
      setConfidence(0);
      // Decay volume slightly so the bar settles
      smoothedVolRef.current = smoothedVolRef.current * 0.9;
      setVolume(smoothedVolRef.current);
    }

    ctx.restore();
  }, []);

  const startCamera = useCallback(async () => {
    setErrorMsg(null);
    setState("loading");
    try {
      // Dynamic imports — MediaPipe is browser-only.
      // The package sets `Hands` as a global side-effect; the ESM export may be undefined.
      const handsMod: any = await import("@mediapipe/hands");
      const HandsCtor =
        handsMod.Hands ?? handsMod.default?.Hands ?? (window as any).Hands;
      if (!HandsCtor) throw new Error("Failed to load MediaPipe Hands library.");

      // Init Hands solution; load assets from CDN to avoid bundler asset path issues
      const hands = new HandsCtor({
        locateFile: (file: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
      hands.onResults(onResults);
      handsRef.current = hands;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: "user" },
        audio: false,
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      // Custom RAF loop (lighter than @mediapipe/camera_utils)
      const loop = async () => {
        if (!handsRef.current || !videoRef.current) return;
        try {
          await handsRef.current.send({ image: videoRef.current });
        } catch {
          /* ignore frame errors */
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);

      setActive(true);
      setState("no-hand");
    } catch (err: any) {
      console.error(err);
      if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
        setState("denied");
        setErrorMsg("Camera permission denied. Please allow access in your browser settings.");
      } else {
        setState("idle");
        setErrorMsg(err?.message ?? "Failed to start the camera.");
      }
      setActive(false);
    }
  }, [onResults]);

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const video = videoRef.current;
    const stream = video?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
    try {
      handsRef.current?.close?.();
    } catch {}
    handsRef.current = null;
    cameraRef.current = null;
    setActive(false);
    setState("idle");
    setVolume(0);
    setDistance(0);
    setConfidence(0);
    setFps(0);
    smoothedVolRef.current = 0;
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && canvasRef.current) {
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const volLabel = volume <= 30 ? "Low" : volume <= 70 ? "Medium" : "High";
  const levels: Array<"Low" | "Medium" | "High"> = ["Low", "Medium", "High"];

  return (
    <main className="min-h-screen bg-black text-white">
      {/* NAVBAR */}
      <nav className="fixed top-0 inset-x-0 z-50 navbar-blur border-b border-[#1F1F1F]">
        <div className="max-w-[1200px] mx-auto h-[60px] px-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white text-black flex items-center justify-center">
              <Hand className="w-4 h-4" />
            </div>
            <span className="font-semibold tracking-tight">GestureVol</span>
          </div>
          <div className="hidden md:flex items-center gap-7 text-sm font-medium text-[#A1A1A1]">
            <a href="#demo" className="hover:text-white transition-colors">Demo</a>
            <a href="#how" className="hover:text-white transition-colors">How it works</a>
            <a href="#stack" className="hover:text-white transition-colors">Stack</a>
          </div>
          <button
            onClick={startCamera}
            disabled={active || state === "loading"}
            className="bg-white text-black font-semibold text-sm px-4 py-2 rounded-full hover:opacity-90 transition disabled:opacity-40"
          >
            {active ? "Running" : "Launch"}
          </button>
        </div>
      </nav>

      <div className="max-w-[1200px] mx-auto px-5 pt-[140px] pb-24">
        {/* HERO */}
        <header className="text-center animate-float-up">
          <div className="pill mx-auto">
            <span className="live-dot" />
            <span>Live computer vision demo</span>
          </div>
          <h1
            className="heading-tight font-bold mt-7 mx-auto max-w-4xl"
            style={{ fontSize: "clamp(38px, 7vw, 72px)" }}
          >
            Control volume<br />
            <span className="text-[#A1A1A1]">with your hand.</span>
          </h1>
          <p className="mt-6 text-[15px] md:text-base text-[#A1A1A1] max-w-xl mx-auto leading-relaxed">
            A real-time hand gesture controller. Pinch and stretch your fingers to
            adjust volume — powered by MediaPipe Hands and your webcam.
          </p>
          <div className="mt-9 flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={startCamera}
              disabled={active || state === "loading"}
              className="btn-primary inline-flex items-center gap-2"
            >
              <Camera className="w-4 h-4" />
              {state === "loading" ? "Starting…" : "Start Camera"}
            </button>
            <button
              onClick={stopCamera}
              disabled={!active}
              className="btn-secondary inline-flex items-center gap-2"
            >
              <CameraOff className="w-4 h-4" />
              Stop
            </button>
          </div>
          {errorMsg && (
            <p className="mt-5 text-sm text-destructive">{errorMsg}</p>
          )}
        </header>

        {/* DEMO PANEL */}
        <section id="demo" className="mt-20 grid lg:grid-cols-[1fr_360px] gap-5">
          {/* CAMERA WINDOW */}
          <div
            className="panel overflow-hidden"
            style={{ borderRadius: 18, boxShadow: "var(--shadow-panel)" }}
          >
            <div className="flex items-center justify-between px-4 h-11 border-b border-[#1F1F1F]">
              <div className="flex items-center gap-2.5 text-xs">
                <span
                  className={
                    state === "tracking"
                      ? "live-dot"
                      : "w-2 h-2 rounded-full bg-[#2A2A2A]"
                  }
                />
                <span className="text-[#A1A1A1] mono uppercase tracking-wider">
                  {state === "loading" && "initializing"}
                  {state === "no-hand" && "awaiting hand"}
                  {state === "tracking" && "tracking"}
                  {state === "denied" && "denied"}
                  {state === "idle" && "offline"}
                </span>
              </div>
              <div className="flex items-center gap-4 text-[11px] text-[#6B6B6B] mono">
                <span>{fps} FPS</span>
                <span>CONF {confidence}%</span>
              </div>
            </div>

            <div className="relative aspect-video w-full bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover"
                style={{ transform: "scaleX(-1)" }}
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
              />

              {!active && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-black">
                  <div className="icon-box mb-4" style={{ width: 56, height: 56 }}>
                    <Hand className="w-6 h-6 text-white" />
                  </div>
                  <p className="text-base font-semibold">Camera offline</p>
                  <p className="text-sm text-[#A1A1A1] mt-1.5">
                    Press <span className="text-white">Start Camera</span> to begin
                    <span className="cursor-blink ml-1.5" />
                  </p>
                </div>
              )}

              {active && state === "loading" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                  <div className="flex items-center gap-3 text-sm">
                    <span className="live-dot" />
                    <span className="mono text-[#A1A1A1]">loading model…</span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-4 h-12 border-t border-[#1F1F1F]">
              <span className="text-[11px] mono text-[#6B6B6B] uppercase tracking-wider">
                MediaPipe · 21 landmarks
              </span>
              <button
                onClick={active ? stopCamera : startCamera}
                disabled={state === "loading"}
                className="text-xs font-semibold px-3 py-1.5 rounded-md bg-white text-black hover:opacity-90 transition disabled:opacity-40"
              >
                {active ? "Stop" : "Start"}
              </button>
            </div>
          </div>

          {/* VOLUME PANEL */}
          <div
            className="panel p-5 flex flex-col"
            style={{ borderRadius: 18, boxShadow: "var(--shadow-panel)" }}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[#A1A1A1]">
                Volume
              </h2>
              <div className="flex items-center gap-1.5">
                {levels.map((l) => (
                  <span
                    key={l}
                    className={`chip ${l === volLabel && active ? "chip-active" : ""}`}
                  >
                    {l}
                  </span>
                ))}
              </div>
            </div>

            <div className="code-box p-5">
              <div
                className="font-bold tabular-nums text-white leading-none"
                style={{ fontSize: "clamp(48px, 7vw, 64px)", letterSpacing: "-0.03em" }}
              >
                {Math.round(volume)}
                <span className="text-[#6B6B6B] text-3xl font-medium ml-1">%</span>
              </div>
              <p className="text-[11px] text-[#6B6B6B] mt-2 mono uppercase tracking-wider">
                Current level
              </p>

              <div className="mt-5 h-2 w-full rounded-full bg-[#1F1F1F] overflow-hidden">
                <div
                  className="h-full bg-white transition-[width] duration-100 ease-out"
                  style={{ width: `${volume}%` }}
                />
              </div>
            </div>

            <div className="mt-5 space-y-3 text-sm">
              <Row label="Distance" value={distance.toFixed(3)} />
              <Row
                label="Gesture"
                value={
                  state === "tracking"
                    ? volume > 1
                      ? "Adjusting"
                      : "Tracking"
                    : state === "no-hand"
                    ? "No hand"
                    : "—"
                }
              />
              <Row label="FPS" value={String(fps)} />
              <Row label="Confidence" value={`${confidence}%`} />
            </div>

            <p className="mt-5 text-[11px] text-[#6B6B6B] leading-relaxed border-t border-[#1F1F1F] pt-4">
              Browsers can't change system volume directly. This bar simulates
              system volume based on your gesture.
            </p>
          </div>
        </section>

        {/* STATS */}
        <section className="mt-20 grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { n: "21", l: "Hand landmarks" },
            { n: "60", l: "FPS target" },
            { n: "<50", l: "ms latency" },
            { n: "0", l: "Server calls" },
          ].map((s) => (
            <div key={s.l} className="panel p-6 text-center">
              <div className="text-3xl md:text-4xl font-bold tracking-tight">{s.n}</div>
              <div className="text-xs text-[#6B6B6B] mt-2 mono uppercase tracking-wider">
                {s.l}
              </div>
            </div>
          ))}
        </section>

        {/* HOW IT WORKS */}
        <section id="how" className="mt-24">
          <div className="text-center">
            <div className="pill mx-auto">
              <span className="live-dot" />
              <span>Workflow</span>
            </div>
            <h2
              className="heading-tight font-bold mt-6"
              style={{ fontSize: "clamp(28px, 4vw, 44px)" }}
            >
              Three steps.<br />
              <span className="text-[#A1A1A1]">Zero setup.</span>
            </h2>
          </div>
          <div className="mt-12 grid md:grid-cols-3 gap-4">
            <Step n={1} title="Start your webcam" desc="Grant camera access. The MediaPipe model loads and locks onto your hand." icon={<Camera className="w-4 h-4" />} />
            <Step n={2} title="Show your hand" desc="Hold one hand in view. Landmarks for thumb (4) and index tip (8) are tracked." icon={<Hand className="w-4 h-4" />} />
            <Step n={3} title="Pinch or stretch" desc="The Euclidean distance between fingertips is mapped smoothly to a 0–100% scale." icon={<Zap className="w-4 h-4" />} />
          </div>
        </section>

        {/* TECH STACK */}
        <section id="stack" className="mt-24">
          <div className="text-center">
            <h2
              className="heading-tight font-bold"
              style={{ fontSize: "clamp(28px, 4vw, 44px)" }}
            >
              Built with<br />
              <span className="text-[#A1A1A1]">a tight stack.</span>
            </h2>
          </div>
          <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { t: "OpenCV Concept", d: "Distance-based gesture mapping logic", I: Eye },
              { t: "MediaPipe Hands", d: "21-point hand landmark detection", I: Hand },
              { t: "Gesture Mapping", d: "Smoothed Euclidean → volume scale", I: Activity },
              { t: "Browser Camera API", d: "Live WebRTC video stream", I: Camera },
            ].map((x) => (
              <div key={x.t} className="panel p-5">
                <div className="icon-box mb-4">
                  <x.I className="w-4 h-4 text-white" />
                </div>
                <div className="font-semibold text-[15px]">{x.t}</div>
                <p className="text-sm text-[#A1A1A1] mt-1.5 leading-relaxed">{x.d}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* FOOTER */}
      <footer className="border-t border-[#1F1F1F] bg-[#0A0A0A]">
        <div className="max-w-[1200px] mx-auto px-5 py-10">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-white text-black flex items-center justify-center">
                <Hand className="w-4 h-4" />
              </div>
              <div>
                <div className="font-semibold text-sm">GestureVol</div>
                <div className="text-xs text-[#6B6B6B]">Real-time hand tracking demo</div>
              </div>
            </div>
            <div className="flex items-center gap-6 text-sm text-[#A1A1A1]">
              <a href="#demo" className="hover:text-white transition-colors">Demo</a>
              <a href="#how" className="hover:text-white transition-colors">How it works</a>
              <a href="#stack" className="hover:text-white transition-colors">Stack</a>
            </div>
          </div>
          <div className="mt-8 pt-6 border-t border-[#1F1F1F] flex items-center justify-between text-xs text-[#6B6B6B]">
            <span>© {new Date().getFullYear()} GestureVol</span>
            <span className="mono flex items-center gap-2">
              <span className="live-dot" />
              all systems live
            </span>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#A1A1A1]">{label}</span>
      <span className="mono text-white">{value}</span>
    </div>
  );
}

function Step({
  n,
  title,
  desc,
  icon,
}: {
  n: number;
  title: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="panel p-6 relative overflow-hidden">
      <span className="absolute top-3 right-4 text-5xl font-bold text-white/[0.04] mono">
        0{n}
      </span>
      <div className="icon-box mb-4">{icon}</div>
      <h3 className="font-semibold text-[15px]">{title}</h3>
      <p className="text-sm text-[#A1A1A1] mt-1.5 leading-relaxed">{desc}</p>
    </div>
  );
}
