import { Plus, Trash2 } from 'lucide-react'
import { type PointerEvent, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Choice } from '@/components/common'
import { CustomFieldsPanel } from '@/components/custom-fields-panel'
import { PdfViewer } from '@/components/pdf-viewer'
import { RegionPanel } from '@/components/region-panel'
import { SeparatorPanel } from '@/components/separator-panel'
import {
  MAX_SEPARATORS,
  moveSeparator,
  newSeparator,
  parseLayout,
  resizeSeparator,
  sortFields,
} from '@/components/template-layout'
import { TemplateStylePanel } from '@/components/template-style-panel'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  type PreviewOptions,
  type PreviewRequest,
  useLivePreview,
} from '@/components/use-live-preview'
import { api, run, useApi } from '@/lib/api'
import type { Font, Template } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  DEFAULT_COLUMNS,
  REGION_KEYS,
  REGION_LABELS,
  REQUIRED_REGIONS,
  type Region,
  type RegionKey,
  type Separator,
  type TemplateStyle,
} from '../../shared/render.ts'

type Selection = { kind: 'region'; key: RegionKey } | { kind: 'separator'; id: string } | null

type Drag =
  | { kind: 'draw'; key: RegionKey; startX: number; startY: number }
  | { kind: 'move' | 'resize'; key: RegionKey; startX: number; startY: number; origin: Region }
  | { kind: 'line'; grip: 'move' | 'resize'; startX: number; startY: number; origin: Separator }

const OPTION_LABELS: Record<keyof PreviewOptions, string> = {
  tax: 'With tax',
  long: 'Long invoice',
  arabic: 'Arabic text',
}

/** A thin line must still be easy to grab. */
const LINE_HIT_PX = 10

function newRegion(
  key: RegionKey,
  page: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Region {
  const table = key === 'line_table'
  return {
    key,
    page,
    x,
    y,
    width,
    height,
    fontSize: table ? 9 : 10,
    align: 'left',
    columns: table ? DEFAULT_COLUMNS : null,
    rowHeight: table ? 20 : null,
    showHeader: true,
  }
}

export function MappingEditor({ template }: { template: Template }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const fonts = useApi<Font[]>('/fonts').data ?? []
  const [pageIndex, setPageIndex] = useState(0)
  const [regions, setRegions] = useState<Region[]>(template.regions)
  const [style, setStyle] = useState<TemplateStyle>({
    textColor: template.textColor,
    lineHeight: template.lineHeight,
    fontId: template.fontId,
  })
  const [separators, setSeparators] = useState<Separator[]>(template.separators)
  const [customFields, setCustomFields] = useState(() => sortFields(template.customFields))
  const [selected, setSelected] = useState<Selection>(null)
  const [armed, setArmed] = useState<RegionKey | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [showBoxes, setShowBoxes] = useState(true)
  const [preview, setPreview] = useState<string | null>(null)
  const [options, setOptions] = useState<PreviewOptions>({ tax: true, long: false, arabic: false })

  const parsed = useMemo(
    () => parseLayout({ regions, style, separators, customFields }),
    [regions, style, separators, customFields],
  )
  const request = useMemo<PreviewRequest | null>(
    () => (parsed.ok ? { ...options, layout: parsed.layout } : null),
    [parsed, options],
  )
  const { pageSize, scale, failure } = useLivePreview({
    templateId: template.id,
    pdfFile: template.pdfFile,
    request,
    paused: drag !== null,
    pageIndex,
    canvasRef,
    surfaceRef,
  })

  const point = (event: PointerEvent) => {
    const box = surfaceRef.current?.getBoundingClientRect()
    return {
      x: Math.max(0, Math.round((event.clientX - (box?.left ?? 0)) / scale)),
      y: Math.max(0, Math.round((event.clientY - (box?.top ?? 0)) / scale)),
    }
  }

  const update = (key: RegionKey, patch: Partial<Region>) =>
    setRegions((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const updateSeparator = (id: string, patch: Partial<Separator>) =>
    setSeparators((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))

  function arm(key: RegionKey) {
    setArmed(key)
    setShowBoxes(true)
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!armed) return
    const { x, y } = point(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    setRegions((rows) => [
      ...rows.filter((row) => row.key !== armed),
      newRegion(armed, pageIndex, x, y, 10, 10),
    ])
    setSelected({ kind: 'region', key: armed })
    setDrag({ kind: 'draw', key: armed, startX: x, startY: y })
    setArmed(null)
  }

  function startDrag(event: PointerEvent, region: Region, kind: 'move' | 'resize') {
    event.stopPropagation()
    if (armed) return
    const { x, y } = point(event)
    surfaceRef.current?.setPointerCapture(event.pointerId)
    setSelected({ kind: 'region', key: region.key })
    setDrag({ kind, key: region.key, startX: x, startY: y, origin: region })
  }

  function startLineDrag(event: PointerEvent, separator: Separator, grip: 'move' | 'resize') {
    event.stopPropagation()
    if (armed) return
    const { x, y } = point(event)
    surfaceRef.current?.setPointerCapture(event.pointerId)
    setSelected({ kind: 'separator', id: separator.id })
    setDrag({ kind: 'line', grip, startX: x, startY: y, origin: separator })
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag) return
    const { x, y } = point(event)
    if (drag.kind === 'line') {
      const change = drag.grip === 'move' ? moveSeparator : resizeSeparator
      updateSeparator(
        drag.origin.id,
        change(drag.origin, x - drag.startX, y - drag.startY, pageSize),
      )
    } else if (drag.kind === 'draw') {
      update(drag.key, {
        x: Math.min(x, drag.startX),
        y: Math.min(y, drag.startY),
        width: Math.max(10, Math.abs(x - drag.startX)),
        height: Math.max(10, Math.abs(y - drag.startY)),
      })
    } else if (drag.kind === 'move') {
      update(drag.key, {
        x: Math.max(0, drag.origin.x + x - drag.startX),
        y: Math.max(0, drag.origin.y + y - drag.startY),
      })
    } else {
      update(drag.key, {
        width: Math.max(10, drag.origin.width + x - drag.startX),
        height: Math.max(10, drag.origin.height + y - drag.startY),
      })
    }
  }

  function save() {
    if (!parsed.ok) {
      toast.error(parsed.problem)
      return
    }
    return run(() => api.put(`/templates/${template.id}/regions`, parsed.layout), 'Layout saved')
  }

  async function showPreview() {
    if (!request) {
      if (!parsed.ok) toast.error(parsed.problem)
      return
    }
    const blob = await run(() => api.blob(`/templates/${template.id}/preview`, request))
    if (blob) {
      if (preview) URL.revokeObjectURL(preview)
      setPreview(URL.createObjectURL(blob))
    }
  }

  function closePreview() {
    if (preview) URL.revokeObjectURL(preview)
    setPreview(null)
  }

  function addLine() {
    const line = newSeparator(pageIndex, pageSize)
    setSeparators((rows) => [...rows, line])
    setSelected({ kind: 'separator', id: line.id })
    setShowBoxes(true)
  }

  function removeLine(id: string) {
    setSeparators((rows) => rows.filter((row) => row.id !== id))
    if (selected?.kind === 'separator' && selected.id === id) setSelected(null)
  }

  const isRegion = (key: RegionKey) => selected?.kind === 'region' && selected.key === key
  const isLine = (id: string) => selected?.kind === 'separator' && selected.id === id
  const currentRegion =
    selected?.kind === 'region' ? regions.find((row) => row.key === selected.key) : undefined
  const currentLine =
    selected?.kind === 'separator' ? separators.find((row) => row.id === selected.id) : undefined
  const mapped = new Set(regions.map((region) => region.key))
  const note = parsed.ok
    ? failure && `Showing the blank template. ${failure}`
    : `Result not updated. ${parsed.problem}`

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {template.pageCount > 1 && (
            <Choice
              className="w-32"
              value={pageIndex}
              onChange={(value) => setPageIndex(Number(value))}
              options={Array.from({ length: template.pageCount }, (_, index) => ({
                value: index,
                label: `Page ${index + 1}`,
              }))}
            />
          )}
          <div className="flex gap-2">
            <Button onClick={save}>Save layout</Button>
            <Button variant="outline" onClick={showPreview}>
              Preview
            </Button>
          </div>
          {(Object.keys(OPTION_LABELS) as (keyof PreviewOptions)[]).map((option) => (
            <Label key={option} className="flex items-center gap-2">
              <Checkbox
                checked={options[option]}
                onCheckedChange={(value) =>
                  setOptions((current) => ({ ...current, [option]: value === true }))
                }
              />
              {OPTION_LABELS[option]}
            </Label>
          ))}
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={showBoxes}
              onCheckedChange={(value) => setShowBoxes(value === true)}
            />
            Show boxes
          </Label>
        </div>
        {note && <p className="text-muted-foreground mb-2 text-sm">{note}</p>}
        {armed && (
          <p className="mb-2 text-sm">
            Drag on the page to place {REGION_LABELS[armed].toLowerCase()}.
          </p>
        )}
        <div
          ref={surfaceRef}
          className={cn(
            'relative w-full max-w-3xl touch-none overflow-hidden border bg-white select-none',
            armed && 'cursor-crosshair',
          )}
          style={{ aspectRatio: `${pageSize.width} / ${pageSize.height}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
        >
          <canvas ref={canvasRef} className="absolute inset-0 size-full" />
          {showBoxes &&
            regions
              .filter((region) => region.page === pageIndex)
              .map((region) => (
                <div
                  key={region.key}
                  className={cn(
                    'absolute cursor-move border',
                    isRegion(region.key)
                      ? 'border-primary bg-primary/5'
                      : 'border-blue-500/70 bg-blue-500/5',
                  )}
                  style={{
                    left: region.x * scale,
                    top: region.y * scale,
                    width: region.width * scale,
                    height: region.height * scale,
                  }}
                  onPointerDown={(event) => startDrag(event, region, 'move')}
                >
                  {/* Sits above the box so it does not cover the text being checked. */}
                  <span
                    className={cn(
                      'bg-background/80 absolute left-0 px-0.5 text-[10px] leading-tight whitespace-nowrap',
                      region.y * scale < 14 ? 'top-0' : 'bottom-full',
                    )}
                  >
                    {REGION_LABELS[region.key]}
                  </span>
                  <div
                    className="bg-primary absolute right-0 bottom-0 size-2.5 cursor-se-resize"
                    onPointerDown={(event) => startDrag(event, region, 'resize')}
                  />
                </div>
              ))}
          {showBoxes &&
            separators
              .filter((separator) => separator.page === pageIndex)
              .map((separator) => {
                const horizontal = separator.orientation === 'horizontal'
                const along = separator.length * scale
                const across = Math.max(LINE_HIT_PX, separator.thickness * scale)
                const mark = Math.max(1, separator.thickness * scale)
                return (
                  <div
                    key={separator.id}
                    className={cn(
                      'absolute flex items-center justify-center',
                      horizontal ? 'cursor-ns-resize' : 'cursor-ew-resize',
                    )}
                    style={{
                      left: separator.x * scale - (horizontal ? 0 : across / 2),
                      top: separator.y * scale - (horizontal ? across / 2 : 0),
                      width: horizontal ? along : across,
                      height: horizontal ? across : along,
                    }}
                    onPointerDown={(event) => startLineDrag(event, separator, 'move')}
                  >
                    <div
                      className={isLine(separator.id) ? 'bg-primary' : 'bg-blue-500/70'}
                      style={{
                        width: horizontal ? '100%' : mark,
                        height: horizontal ? mark : '100%',
                      }}
                    />
                    <div
                      className={cn(
                        'bg-primary absolute size-2.5',
                        horizontal
                          ? 'top-1/2 right-0 -translate-y-1/2 cursor-ew-resize'
                          : 'bottom-0 left-1/2 -translate-x-1/2 cursor-ns-resize',
                      )}
                      onPointerDown={(event) => startLineDrag(event, separator, 'resize')}
                    />
                  </div>
                )
              })}
        </div>
      </div>

      <div className="grid content-start gap-4">
        <TemplateStylePanel
          style={style}
          fonts={fonts}
          onChange={(patch) => setStyle((current) => ({ ...current, ...patch }))}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Regions</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1">
            {REGION_KEYS.map((key) => (
              <div key={key} className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className={cn(
                    'hover:bg-accent flex-1 rounded px-2 py-1 text-left text-sm',
                    isRegion(key) && 'bg-accent',
                  )}
                  onClick={() => {
                    if (mapped.has(key)) {
                      setSelected({ kind: 'region', key })
                      const region = regions.find((row) => row.key === key)
                      if (region) setPageIndex(region.page)
                    } else arm(key)
                  }}
                >
                  {REGION_LABELS[key]}
                  {REQUIRED_REGIONS.includes(key) && !mapped.has(key) ? ' (required)' : ''}
                </button>
                {mapped.has(key) ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${REGION_LABELS[key]}`}
                    onClick={() => {
                      setRegions((rows) => rows.filter((row) => row.key !== key))
                      if (isRegion(key)) setSelected(null)
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Place ${REGION_LABELS[key]}`}
                    onClick={() => arm(key)}
                  >
                    <Plus className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Lines</CardTitle>
            <Button
              size="sm"
              variant="outline"
              disabled={separators.length >= MAX_SEPARATORS}
              onClick={addLine}
            >
              <Plus className="size-4" /> Add line
            </Button>
          </CardHeader>
          {separators.length > 0 && (
            <CardContent className="grid gap-1">
              {separators.map((separator, index) => (
                <div key={separator.id} className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className={cn(
                      'hover:bg-accent flex-1 rounded px-2 py-1 text-left text-sm',
                      isLine(separator.id) && 'bg-accent',
                    )}
                    onClick={() => {
                      setSelected({ kind: 'separator', id: separator.id })
                      setPageIndex(separator.page)
                    }}
                  >
                    Line {index + 1}
                    {template.pageCount > 1 ? ` (page ${separator.page + 1})` : ''}
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete line ${index + 1}`}
                    onClick={() => removeLine(separator.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          )}
        </Card>

        {currentRegion && (
          <RegionPanel
            key={currentRegion.key}
            region={currentRegion}
            style={style}
            fonts={fonts}
            onChange={(patch) => update(currentRegion.key, patch)}
          />
        )}
        {currentLine && (
          <SeparatorPanel
            key={currentLine.id}
            separator={currentLine}
            onChange={(patch) => updateSeparator(currentLine.id, patch)}
            onDelete={() => removeLine(currentLine.id)}
          />
        )}
      </div>

      <CustomFieldsPanel fields={customFields} mapped={mapped} onChange={setCustomFields} />

      <Dialog open={preview !== null} onOpenChange={(open) => !open && closePreview()}>
        <DialogContent className="flex h-[90svh] flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Preview with sample data</DialogTitle>
          </DialogHeader>
          {preview && <PdfViewer src={preview} title="Template preview" className="flex-1" />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
