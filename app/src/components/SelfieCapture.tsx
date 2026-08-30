import { useCallback, useEffect, useRef, useState } from 'react'

/** Live front-camera capture. Calls onAccept with a JPEG data URL. */
export function SelfieCapture({
  optional,
  orgName,
  onAccept,
  onSkip,
  onBack,
}: {
  optional: boolean
  /** The congregation this kiosk belongs to. Null when it could not be
   *  resolved, in which case nobody is named rather than the wrong body. */
  orgName: string | null
  onAccept: (image: string) => void
  onSkip: () => void
  onBack: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  const startCamera = useCallback(async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
    } catch {
      setError('Could not access the camera. Please allow camera access and try again.')
    }
  }, [])

  useEffect(() => {
    void startCamera()
    return stopCamera
  }, [startCamera])

  function capture() {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0)
    setPhoto(canvas.toDataURL('image/jpeg', 0.85))
    stopCamera()
  }

  function retake() {
    setPhoto(null)
    void startCamera()
  }

  return (
    <main className="page">
      <h1>{orgName ?? 'Guest Badges'}</h1>
      <p className="big">Take a selfie</p>

      {error ? (
        <>
          <div className="error">{error}</div>
          <div className="actions">
            <button onClick={() => void startCamera()}>Try again</button>
            {optional && (
              <button className="secondary" onClick={onSkip}>
                Skip
              </button>
            )}
            <button className="secondary" onClick={onBack}>
              Back
            </button>
          </div>
        </>
      ) : photo ? (
        <>
          <div className="selfie-frame">
            <img src={photo} alt="Your selfie" />
          </div>
          <div className="actions">
            <button onClick={() => onAccept(photo)}>Use this photo</button>
            <button className="secondary" onClick={retake}>
              Retake
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="selfie-frame">
            <video ref={videoRef} playsInline muted />
          </div>
          <div className="actions">
            <button onClick={capture}>Capture</button>
            {optional && (
              <button className="secondary" onClick={onSkip}>
                Skip
              </button>
            )}
            <button className="secondary" onClick={onBack}>
              Back
            </button>
          </div>
        </>
      )}

      <p className="muted small">
        Your photo will be saved by {orgName ?? 'this congregation'}.
      </p>
    </main>
  )
}
