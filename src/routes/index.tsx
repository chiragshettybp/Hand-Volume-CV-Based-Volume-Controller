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
      <div className="max-w-7xl mx-auto px-6 py-10 lg:py-14">
        {/* HERO */}
        <header className="text-center animate-float-up">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass text-xs uppercase tracking-widest text-muted-foreground mb-6">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            Live Computer Vision Demo
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            <span className="text-gradient">Hand Gesture</span>
            <br />
            Volume Controller
          </h1>
          <p className="mt-5 text-base md:text-lg text-muted-foreground max-w-2xl mx-auto">
            Control volume using thumb and index finger distance in real time — powered by
            MediaPipe Hands and your webcam.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={startCamera}
              disabled={active || state === "loading"}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-hero text-primary-foreground font-semibold neon-glow transition hover:scale-[1.03] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              <Camera className="w-5 h-5" />
              {state === "loading" ? "Starting…" : "Start Camera"}
            </button>
            <button
              onClick={stopCamera}
              disabled={!active}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl glass font-medium transition hover:bg-secondary/50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <CameraOff className="w-5 h-5" />
              Stop Camera
            </button>
          </div>
          {errorMsg && (
            <p className="mt-4 text-sm text-destructive">{errorMsg}</p>
          )}
        </header>

        {/* MAIN PANELS */}
        <section className="mt-12 grid lg:grid-cols-[1fr_360px] gap-6">
          {/* CAMERA PANEL */}
          <div className="glass rounded-2xl p-4 relative overflow-hidden animate-float-up">
            <div className="flex items-center justify-between mb-3 px-2">
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={`w-2 h-2 rounded-full ${
                    state === "tracking"
                      ? "bg-success animate-pulse"
                      : active
                      ? "bg-warning animate-pulse"
                      : "bg-muted-foreground/50"
                  }`}
                />
                <span className="text-muted-foreground">
                  {state === "loading" && "Initializing model…"}
                  {state === "no-hand" && "No hand detected"}
                  {state === "tracking" && "Tracking hand"}
                  {state === "denied" && "Camera denied"}
                  {state === "idle" && "Camera off"}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5" /> {fps} FPS
                </span>
                <span className="flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5" /> {confidence}%
                </span>
              </div>
            </div>

            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-black/50 border border-border">
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
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-black/40">
                  <div className="relative mb-4">
                    <Hand className="w-14 h-14 text-primary" />
                    <span className="absolute inset-0 rounded-full border border-primary animate-pulse-ring" />
                  </div>
                  <p className="text-lg font-medium">Camera is off</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Click <span className="text-primary">Start Camera</span> to begin tracking
                  </p>
                </div>
              )}

              {active && state === "loading" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <div className="flex items-center gap-3">
                    <span className="w-3 h-3 rounded-full bg-primary animate-pulse" />
                    <p>Loading hand tracking model…</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* VOLUME PANEL */}
          <div className="glass rounded-2xl p-6 flex flex-col animate-float-up">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Volume</h2>
              <span
                className="text-xs font-mono uppercase tracking-wider px-2 py-1 rounded-md"
                style={{
                  background: `color-mix(in oklab, ${volColor} 20%, transparent)`,
                  color: volColor,
                }}
              >
                {volLabel}
              </span>
            </div>

            <div className="flex items-center gap-6">
              {/* Vertical bar */}
              <div className="relative w-14 h-64 rounded-full bg-secondary/40 overflow-hidden border border-border">
                <div
                  className="absolute bottom-0 left-0 right-0 bg-gradient-volume transition-[height] duration-100 ease-out"
                  style={{ height: `${volume}%` }}
                />
                {/* Tick marks */}
                {[25, 50, 75].map((t) => (
                  <span
                    key={t}
                    className="absolute left-0 right-0 h-px bg-foreground/15"
                    style={{ bottom: `${t}%` }}
                  />
                ))}
              </div>

              <div className="flex-1">
                <div className="text-5xl font-bold tabular-nums text-gradient">
                  {Math.round(volume)}%
                </div>
                <p className="text-xs text-muted-foreground mt-1">Current level</p>

                <div className="mt-6 space-y-2 text-sm">
                  <Row label="Distance" value={distance.toFixed(3)} />
                  <Row
                    label="Gesture"
                    value={
                      state === "tracking"
                        ? volume > 1
                          ? "Volume changing"
                          : "Tracking"
                        : state === "no-hand"
                        ? "No hand"
                        : "—"
                    }
                  />
                  <Row label="FPS" value={String(fps)} />
                </div>
              </div>
            </div>

            <div className="mt-6 text-xs text-muted-foreground leading-relaxed border-t border-border pt-4">
              Browsers cannot directly change system volume from a webpage. This bar simulates
              system volume visually based on your gesture.
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="mt-16">
          <h2 className="text-2xl md:text-3xl font-semibold text-center">How it works</h2>
          <p className="text-center text-muted-foreground mt-2 max-w-xl mx-auto">
            Closer fingers = lower volume. Farther fingers = higher volume.
          </p>
          <div className="mt-8 grid md:grid-cols-3 gap-4">
            <Step
              n={1}
              title="Start your webcam"
              desc="Grant camera access. The MediaPipe model loads and locks onto your hand."
              icon={<Camera className="w-5 h-5" />}
            />
            <Step
              n={2}
              title="Show your hand"
              desc="Hold one hand in view. Landmarks for thumb (4) and index tip (8) are tracked."
              icon={<Hand className="w-5 h-5" />}
            />
            <Step
              n={3}
              title="Pinch or stretch"
              desc="The Euclidean distance between fingertips is mapped smoothly to a 0–100% scale."
              icon={<Zap className="w-5 h-5" />}
            />
          </div>
        </section>

        {/* TECH STACK */}
        <section className="mt-16">
          <h2 className="text-2xl md:text-3xl font-semibold text-center">Tech stack</h2>
          <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { t: "OpenCV Concept", d: "Distance-based gesture mapping logic" },
              { t: "MediaPipe Hands", d: "21-point hand landmark detection" },
              { t: "Gesture Mapping", d: "Smoothed Euclidean → volume scale" },
              { t: "Browser Camera API", d: "Live WebRTC video stream" },
            ].map((x) => (
              <div key={x.t} className="glass rounded-xl p-5">
                <div className="flex items-center gap-2 mb-2 text-primary">
                  <Cpu className="w-4 h-4" />
                  <span className="font-medium text-foreground">{x.t}</span>
                </div>
                <p className="text-sm text-muted-foreground">{x.d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FOOTER */}
        <footer className="mt-20 text-center text-sm text-muted-foreground">
          Built with AI + Computer Vision
        </footer>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
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
    <div className="glass rounded-2xl p-6 relative overflow-hidden">
      <span className="absolute top-3 right-4 text-5xl font-bold text-foreground/5">
        0{n}
      </span>
      <div className="w-10 h-10 rounded-lg bg-gradient-hero flex items-center justify-center text-primary-foreground mb-3">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1.5">{desc}</p>
    </div>
  );
}
