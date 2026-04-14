import { AlertTriangle, Camera, Loader2, QrCode, Search, StopCircle } from 'lucide-react';
import jsQR from 'jsqr';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { Button } from '../../components/ui/button';
import { Card, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { validatePatientQrConsultationAccessLiveOrDemo } from '../../lib/supabase-clinic';
import { extractPatientQrCode } from './patient-qr';

function readQrFromVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    return '';
  }

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return '';
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const decoded = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });

  return decoded?.data?.trim() ?? '';
}

export function PatientQrLookupPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialQuery = searchParams.get('qr') ?? '';
  const [value, setValue] = useState(initialQuery);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isResolving, setIsResolving] = useState(false);
  const [isAccessBlocked, setIsAccessBlocked] = useState(false);
  const [cameraState, setCameraState] = useState<'idle' | 'requesting' | 'active' | 'unsupported' | 'denied'>('idle');
  const [cameraMessage, setCameraMessage] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const normalizedCode = useMemo(() => extractPatientQrCode(value), [value]);

  const resolvePatientConsultationAccess = useCallback(async (rawQrValue: string) => {
    if (isResolving) {
      return;
    }

    setIsResolving(true);
    setError('');
    setStatusMessage('Validating patient and latest payment status...');
    setIsAccessBlocked(false);

    try {
      const validation = await validatePatientQrConsultationAccessLiveOrDemo(extractPatientQrCode(rawQrValue));

      if (!validation) {
        setStatusMessage('');
        setError('That QR code is not linked to a patient record yet.');
        setIsAccessBlocked(false);
        return;
      }

      if (!validation.isAllowed) {
        setStatusMessage('Consultation access is blocked for this scan.');
        setError(validation.gateMessage);
        setIsAccessBlocked(true);
        return;
      }

      setStatusMessage(validation.gateMessage);
      setIsAccessBlocked(false);
      const destination = validation.appointmentId
        ? `/app/consultation/${validation.patient.id}?source=qr&appointmentId=${encodeURIComponent(validation.appointmentId)}`
        : `/app/consultation/${validation.patient.id}?source=qr`;
      void navigate(destination, { replace: true });
    } catch (resolveError) {
      setStatusMessage('');
      setIsAccessBlocked(false);
      setError(
        resolveError instanceof Error
          ? `Unable to validate payment status right now. ${resolveError.message}`
          : 'Unable to validate payment status right now. Please try again.',
      );
    } finally {
      setIsResolving(false);
    }
  }, [isResolving, navigate]);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setCameraState((current) => (current === 'unsupported' ? current : 'idle'));
    setCameraMessage('');
  };

  useEffect(() => {
    if (!initialQuery) {
      return;
    }

    void resolvePatientConsultationAccess(initialQuery);
  }, [initialQuery, resolvePatientConsultationAccess]);

  useEffect(
    () => () => {
      stopCamera();
    },
    [],
  );

  useEffect(() => {
    if (cameraState !== 'active' || !videoRef.current || !canvasRef.current || isResolving) {
      return;
    }

    let cancelled = false;

    const scanFrame = async () => {
      if (cancelled || !videoRef.current || !canvasRef.current) {
        return;
      }

      try {
        const rawValue = readQrFromVideoFrame(videoRef.current, canvasRef.current);
        const code = extractPatientQrCode(rawValue);
        if (code) {
          stopCamera();
          setValue(rawValue);
          await resolvePatientConsultationAccess(rawValue);
          return;
        }
      } catch {
        setCameraMessage('Camera is active. Align the patient QR inside the frame and keep it steady.');
      }

      window.setTimeout(scanFrame, 450);
    };

    void scanFrame();

    return () => {
      cancelled = true;
    };
  }, [cameraState, isResolving, resolvePatientConsultationAccess]);

  useEffect(() => {
    if (cameraState !== 'requesting' && cameraState !== 'active') {
      return;
    }

    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) {
      return;
    }

    video.srcObject = stream;
    void video.play().catch(() => {
      setCameraMessage('Camera is ready. Tap Start camera again if preview does not appear.');
    });
  }, [cameraState]);

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('unsupported');
      setCameraMessage('This device or browser does not support camera access.');
      return;
    }

    stopCamera();
    setError('');
    setStatusMessage('');
    setIsAccessBlocked(false);
    setCameraState('requesting');
    setCameraMessage('Requesting camera permission...');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });

      streamRef.current = stream;
      setCameraState('active');
      setCameraMessage('Camera ready. Point it at the patient QR code.');
    } catch {
      setCameraState('denied');
      setCameraMessage('Camera permission was denied. You can still paste the patient QR code manually.');
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!normalizedCode) {
      setError('Scan a patient QR code or paste the patient code.');
      return;
    }

    await resolvePatientConsultationAccess(normalizedCode);
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-6 xl:grid-cols-[1.1fr_0.9fr]">
      <Card>
        <p className="text-sm uppercase tracking-[0.18em] text-slate-400">QR lookup</p>
        <CardTitle className="mt-2 text-3xl">Scan patient QR for consultation entry</CardTitle>
        <p className="mt-3 max-w-2xl text-sm text-slate-500">
          Doctors can allow camera access, scan the patient QR, validate payment status, and continue straight to SOAP documentation.
        </p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-3 rounded-3xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap gap-3">
              <Button className="gap-2" disabled={isResolving} onClick={() => void startCamera()} type="button">
                <Camera className="size-4" />
                {cameraState === 'active' ? 'Restart camera' : 'Allow camera and scan'}
              </Button>
              {cameraState === 'active' ? (
                <Button className="gap-2" disabled={isResolving} onClick={stopCamera} type="button" variant="secondary">
                  <StopCircle className="size-4" />
                  Stop camera
                </Button>
              ) : null}
            </div>
            {cameraMessage ? <p className="text-sm text-slate-600">{cameraMessage}</p> : null}
            {cameraState === 'requesting' || cameraState === 'active' ? (
              <div className="overflow-hidden rounded-3xl border border-slate-200 bg-black">
                <video className="aspect-video w-full object-cover" muted playsInline ref={videoRef} />
                <canvas className="hidden" ref={canvasRef} />
              </div>
            ) : null}
          </div>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">QR link or patient code</span>
            <div className="flex items-center gap-3 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-3">
              <QrCode className="size-5 text-slate-400" />
              <Input
                className="border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
                onChange={(event) => setValue(event.target.value)}
                placeholder="Paste scanned QR result here"
                value={value}
              />
            </div>
          </label>

          {statusMessage ? (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{statusMessage}</div>
          ) : null}

          {error ? <p className="text-sm text-rose-600">{error}</p> : null}

          {isAccessBlocked ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                <AlertTriangle className="size-4" />
                Consultation blocked until payment is settled.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  className="inline-flex items-center justify-center rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wider text-amber-800 transition hover:bg-amber-100"
                  to="/app/billing"
                >
                  Open Billing
                </Link>
                <button
                  className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-700 transition hover:bg-slate-50"
                  onClick={() => {
                    setError('');
                    setStatusMessage('');
                    setIsAccessBlocked(false);
                  }}
                  type="button"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Button className="gap-2" disabled={isResolving} type="submit">
              {isResolving ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {isResolving ? 'Validating...' : 'Validate and open SOAP'}
            </Button>
            <Link
              className="inline-flex items-center justify-center rounded-2xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              to="/app/patients"
            >
              Back to patients
            </Link>
          </div>
        </form>
      </Card>

      <Card className="bg-slate-950 text-white">
        <p className="text-sm uppercase tracking-[0.18em] text-slate-400">How this works</p>
        <CardTitle className="mt-2 text-white">Doctor scanning workflow</CardTitle>
        <div className="mt-5 space-y-4 text-sm text-slate-300">
          <p>The page asks for camera permission before opening the live scanner.</p>
          <p>After scanning, the app checks the patient&apos;s latest invoice payment status.</p>
          <p>If paid, the appointment is confirmed and you are redirected to the SOAP interface automatically.</p>
        </div>
      </Card>
    </div>
  );
}
