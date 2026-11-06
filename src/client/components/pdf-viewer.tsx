import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'
import { Loading } from '@/components/common'
import { cn } from '@/lib/utils'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Draws every page with pdf.js, so previews look the same on all browsers and phones. */
export function PdfViewer({
  src,
  title,
  className,
}: {
  src: string
  title: string
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let loaded: pdfjs.PDFDocumentLoadingTask | null = null
    setState('loading')
    host.replaceChildren()

    async function draw() {
      const res = await fetch(src, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('Could not load the PDF')
      loaded = pdfjs.getDocument({ data: await res.arrayBuffer() })
      const doc = await loaded.promise
      for (let number = 1; number <= doc.numPages && !cancelled; number += 1) {
        const page = await doc.getPage(number)
        const width = host?.clientWidth || 600
        const natural = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({
          scale: (width / natural.width) * window.devicePixelRatio,
        })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.className = 'mb-2 w-full border bg-white'
        canvas.setAttribute('aria-label', `${title}, page ${number}`)
        host?.append(canvas)
        await page.render({ canvas, viewport }).promise
      }
      if (!cancelled) setState('ready')
    }

    draw().catch(() => {
      if (!cancelled) setState('failed')
    })
    return () => {
      cancelled = true
      loaded?.destroy()
    }
  }, [src, title])

  return (
    <div className={cn('min-h-0 overflow-y-auto', className)}>
      {state === 'loading' && <Loading />}
      {state === 'failed' && (
        <p className="text-destructive p-4 text-sm">This PDF could not be shown.</p>
      )}
      <div ref={hostRef} />
    </div>
  )
}
