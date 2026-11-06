import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { TemplateLayout } from '@/components/template-layout'
import { api, fileUrl } from '@/lib/api'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const DEBOUNCE_MS = 400

export interface PreviewOptions {
  tax: boolean
  long: boolean
  arabic: boolean
}

export type PreviewRequest = PreviewOptions & { layout: TemplateLayout }

/**
 * Draws the rendered page on the editor canvas, falling back to the blank template PDF.
 * This only ever renders. Unsaved edits travel in the request and nothing is stored.
 */
export function useLivePreview({
  templateId,
  pdfFile,
  request,
  paused,
  pageIndex,
  canvasRef,
  surfaceRef,
}: {
  templateId: number
  pdfFile: string
  /** Null while the local state cannot be sent. The page on screen stays as it is. */
  request: PreviewRequest | null
  /** True during a drag. The request goes out when the drag ends. */
  paused: boolean
  pageIndex: number
  canvasRef: RefObject<HTMLCanvasElement | null>
  surfaceRef: RefObject<HTMLDivElement | null>
}) {
  const [blank, setBlank] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [live, setLive] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 })
  const [surfaceWidth, setSurfaceWidth] = useState(0)
  const sent = useRef<string | null>(null)
  const inFlight = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    const task = pdfjs.getDocument({ url: fileUrl(pdfFile) })
    task.promise
      .then((loaded) => {
        if (!cancelled) setBlank(loaded)
      })
      .catch(() => {
        if (!cancelled) toast.error('This template PDF could not be shown')
      })
    return () => {
      cancelled = true
      task.destroy()
    }
  }, [pdfFile])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const observer = new ResizeObserver(() => setSurfaceWidth(surface.clientWidth))
    observer.observe(surface)
    return () => observer.disconnect()
  }, [surfaceRef])

  useEffect(() => {
    if (!request || paused) return
    const key = JSON.stringify(request)
    if (key === sent.current) return

    const timer = setTimeout(async () => {
      sent.current = key
      inFlight.current?.abort()
      const controller = new AbortController()
      inFlight.current = controller
      const { signal } = controller
      try {
        const blob = await api.blob(`/templates/${templateId}/preview`, request, { signal })
        const data = await blob.arrayBuffer()
        const doc = await pdfjs.getDocument({ data }).promise
        if (signal.aborted) {
          doc.loadingTask.destroy()
          return
        }
        setLive(doc)
        setFailure(null)
      } catch (error) {
        if (signal.aborted) return
        setLive(null)
        setFailure(error instanceof Error ? error.message : 'The result could not be rendered')
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [templateId, request, paused])

  useEffect(() => () => inFlight.current?.abort(), [])

  // Cleanups run in order, so a render in progress is cancelled before the doc is destroyed below.
  const shown = live ?? blank
  useEffect(() => {
    if (!shown || !surfaceWidth) return
    let cancelled = false
    let task: pdfjs.RenderTask | null = null

    async function draw(doc: pdfjs.PDFDocumentProxy) {
      const page = await doc.getPage(Math.min(pageIndex + 1, doc.numPages))
      if (cancelled) return
      const natural = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({
        scale: (surfaceWidth / natural.width) * window.devicePixelRatio,
      })
      // The old page stays visible until the new one is finished.
      const buffer = document.createElement('canvas')
      buffer.width = viewport.width
      buffer.height = viewport.height
      task = page.render({ canvas: buffer, viewport })
      await task.promise
      const canvas = canvasRef.current
      if (cancelled || !canvas) return
      canvas.width = buffer.width
      canvas.height = buffer.height
      canvas.getContext('2d')?.drawImage(buffer, 0, 0)
      setPageSize((size) =>
        size.width === natural.width && size.height === natural.height
          ? size
          : { width: natural.width, height: natural.height },
      )
    }

    draw(shown).catch(() => undefined)
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [shown, pageIndex, surfaceWidth, canvasRef])

  useEffect(
    () => () => {
      live?.loadingTask.destroy()
    },
    [live],
  )

  return { pageSize, scale: surfaceWidth ? surfaceWidth / pageSize.width : 1, failure }
}
