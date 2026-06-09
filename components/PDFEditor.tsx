'use client'

import { useState, useRef, useCallback } from 'react'
import styles from './PDFEditor.module.css'

declare global {
  interface Window {
    loadPyodide: (opts: { indexURL: string }) => Promise<PyodideInterface>
    _pyodide?: PyodideInterface
  }
}
interface PyodideInterface {
  loadPackage: (pkgs: string[]) => Promise<void>
  pyimport: (name: string) => { install: (pkgs: string[]) => Promise<void> }
  runPythonAsync: (code: string) => Promise<void>
  setStdout: (opts: { batched: (s: string) => void }) => void
  setStderr: (opts: { batched: (s: string) => void }) => void
}

type Tool = 'replace_text' | 'watermark' | 'delete_pages' | 'extract_pages' | 'page_numbers' | 'rotate'

interface ToolParams {
  replace_text: { find: string; replace: string }
  watermark: { text: string; opacity: string; color: string }
  delete_pages: { pages: string }
  extract_pages: { pages: string }
  page_numbers: { position: string; size: string }
  rotate: { pages: string; angle: string }
}

const TOOLS: { id: Tool; label: string; icon: string; desc: string }[] = [
  { id: 'replace_text', icon: 'ti-replace', label: 'Заменить текст', desc: 'Найти и заменить' },
  { id: 'watermark', icon: 'ti-droplet', label: 'Водяной знак', desc: 'Текст на всех страницах' },
  { id: 'delete_pages', icon: 'ti-trash', label: 'Удалить страницы', desc: 'Убрать страницы из PDF' },
  { id: 'extract_pages', icon: 'ti-scissors', label: 'Извлечь страницы', desc: 'Сохранить только нужные' },
  { id: 'page_numbers', icon: 'ti-hash', label: 'Номера страниц', desc: 'Добавить нумерацию' },
  { id: 'rotate', icon: 'ti-rotate', label: 'Повернуть', desc: 'Повернуть страницы' },
]

function buildPython(tool: Tool, params: ToolParams, b64: string): string {
  const base = `
import base64, os
os.makedirs('/tmp', exist_ok=True)
with open('/tmp/input.pdf', 'wb') as f:
    f.write(base64.b64decode("""${b64}"""))
from pypdf import PdfReader, PdfWriter
`
  const scripts: Record<Tool, string> = {
    replace_text: `
\${base}
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
import io

find_text = '''${params.replace_text.find}'''
replace_text_val = '''${params.replace_text.replace}'''

reader = PdfReader('/tmp/input.pdf')
writer = PdfWriter()
replaced_count = 0

for page in reader.pages:
    page_text = page.extract_text() or ''
    if find_text in page_text:
        w = float(page.mediabox.width)
        h = float(page.mediabox.height)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(w, h))
        lines = page_text.split('\n')
        y = h - 40
        for line in lines:
            new_line = line.replace(find_text, replace_text_val)
            if new_line != line:
                replaced_count += 1
            c.setFont('Helvetica', 10)
            c.setFillColor(HexColor('#FFFFFF'))
            c.rect(0, y - 2, w, 14, fill=1, stroke=0)
            c.setFillColor(HexColor('#000000'))
            c.drawString(40, y, new_line[:120])
            y -= 14
            if y < 40:
                break
        c.save()
        buf.seek(0)
        overlay = PdfReader(buf).pages[0]
        page.merge_page(overlay)
    writer.add_page(page)

with open('/tmp/output.pdf', 'wb') as f:
    writer.write(f)
print(f"Replaced in {replaced_count} lines")
`,
    watermark: `
${base}
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor
import io

reader = PdfReader('/tmp/input.pdf')
writer = PdfWriter()

color_map = {'gray': '#888888', 'red': '#cc0000', 'blue': '#0044cc'}
hex_color = color_map.get('${params.watermark.color}', '#888888')
opacity = float('${params.watermark.opacity}') / 100

for page in reader.pages:
    w = float(page.mediabox.width)
    h = float(page.mediabox.height)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w, h))
    c.setFillColor(HexColor(hex_color), alpha=opacity)
    c.setFont('Helvetica-Bold', min(w, h) // 8)
    c.saveState()
    c.translate(w/2, h/2)
    c.rotate(45)
    text = '${params.watermark.text}'
    c.drawCentredString(0, 0, text)
    c.restoreState()
    c.save()
    buf.seek(0)
    wm_page = PdfReader(buf).pages[0]
    page.merge_page(wm_page)
    writer.add_page(page)

with open('/tmp/output.pdf', 'wb') as f:
    writer.write(f)
`,
    delete_pages: `
${base}
def parse_pages(s, total):
    result = set()
    for part in s.split(','):
        part = part.strip()
        if '-' in part:
            a, b = part.split('-')
            result.update(range(int(a)-1, int(b)))
        elif part:
            result.add(int(part)-1)
    return result

reader = PdfReader('/tmp/input.pdf')
writer = PdfWriter()
to_delete = parse_pages('${params.delete_pages.pages}', len(reader.pages))
for i, page in enumerate(reader.pages):
    if i not in to_delete:
        writer.add_page(page)
with open('/tmp/output.pdf', 'wb') as f:
    writer.write(f)
`,
    extract_pages: `
${base}
def parse_pages(s, total):
    result = set()
    for part in s.split(','):
        part = part.strip()
        if '-' in part:
            a, b = part.split('-')
            result.update(range(int(a)-1, int(b)))
        elif part:
            result.add(int(part)-1)
    return result

reader = PdfReader('/tmp/input.pdf')
writer = PdfWriter()
to_keep = parse_pages('${params.extract_pages.pages}', len(reader.pages))
for i in sorted(to_keep):
    if i < len(reader.pages):
        writer.add_page(reader.pages[i])
with open('/tmp/output.pdf', 'wb') as f:
    writer.write(f)
`,
    page_numbers: `
${base}
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
import io

reader = PdfReader('/tmp/input.pdf')
writer = PdfWriter()
pos = '${params.page_numbers.position}'
font_size = int('${params.page_numbers.size}')
total = len(reader.pages)

for i, page in enumerate(reader.pages):
    w = float(page.mediabox.width)
    h = float(page.mediabox.height)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w, h))
    c.setFillColor(HexColor('#333333'))
    c.setFont('Helvetica', font_size)
    text = f'{i+1} / {total}'
    margin = 30
    if pos == 'bottom_center':
        c.drawCentredString(w/2, margin, text)
    elif pos == 'bottom_right':
        c.drawRightString(w - margin, margin, text)
    elif pos == 'bottom_left':
        c.drawString(margin, margin, text)
    elif pos == 'top_center':
        c.drawCentredString(w/2, h - margin - font_size, text)
    c.save()
    buf.seek(0)
    num_page = PdfReader(buf).pages[0]
    page.merge_page(num_page)
    writer.add_page(page)

with open('/tmp/output.pdf', 'wb') as f:
    writer.write(f)
`,
    rotate: `
${base}
def parse_pages(s, total):
    if s.strip().lower() == 'all':
        return set(range(total))
    result = set()
    for part in s.split(','):
        part = part.strip()
        if '-' in part:
            a, b = part.split('-')
            result.update(range(int(a)-1, int(b)))
        elif part:
            result.add(int(part)-1)
    return result

reader = PdfReader('/tmp/input.pdf')
writer = PdfWriter()
angle = int('${params.rotate.angle}')
to_rotate = parse_pages('${params.rotate.pages}', len(reader.pages))
for i, page in enumerate(reader.pages):
    if i in to_rotate:
        page.rotate(angle)
    writer.add_page(page)
with open('/tmp/output.pdf', 'wb') as f:
    writer.write(f)
`,
  }
  return scripts[tool] + `
import base64 as _b64
with open('/tmp/output.pdf','rb') as _f:
    print("OUTPUT_B64:" + _b64.b64encode(_f.read()).decode())
`
}

export default function PDFEditor() {
  const [pdfBase64, setPdfBase64] = useState<string | null>(null)
  const [pdfFilename, setPdfFilename] = useState('')
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null)
  const [activeTool, setActiveTool] = useState<Tool | null>(null)
  const [params, setParams] = useState<ToolParams>({
    replace_text: { find: '', replace: '' },
    watermark: { text: 'КОНФИДЕНЦИАЛЬНО', opacity: '25', color: 'gray' },
    delete_pages: { pages: '' },
    extract_pages: { pages: '' },
    page_numbers: { position: 'bottom_center', size: '10' },
    rotate: { pages: 'all', angle: '90' },
  })
  const [status, setStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; msg: string }>({ type: 'idle', msg: '' })
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadFile = useCallback((file: File) => {
    if (file.type !== 'application/pdf') return
    setPdfFilename(file.name)
    setResultBlob(null)
    setStatus({ type: 'idle', msg: '' })
    const reader = new FileReader()
    reader.onload = () => {
      const b64 = (reader.result as string).split(',')[1]
      setPdfBase64(b64)
    }
    reader.readAsDataURL(file)
  }, [])

  const setParam = (tool: Tool, key: string, value: string) => {
    setParams(prev => ({ ...prev, [tool]: { ...prev[tool], [key]: value } }))
  }

  const runTool = async () => {
    if (!pdfBase64 || !activeTool) return
    setStatus({ type: 'loading', msg: 'Обработка...' })
    setResultBlob(null)

    try {
      if (!window._pyodide) {
        setStatus({ type: 'loading', msg: 'Загружаю Python (~10 сек)...' })
        await new Promise<void>(resolve => {
          const s = document.createElement('script')
          s.src = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js'
          s.onload = () => resolve()
          document.head.appendChild(s)
        })
        const py = await window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/' })
        await py.loadPackage(['micropip'])
        const micropip = py.pyimport('micropip')
        await micropip.install(['pypdf', 'reportlab'])
        window._pyodide = py
      }

      const py = window._pyodide
      let stdout = ''
      py.setStdout({ batched: (s: string) => { stdout += s + '\n' } })
      py.setStderr({ batched: (s: string) => { stdout += s + '\n' } })

      const code = buildPython(activeTool, params, pdfBase64)
      await py.runPythonAsync(code)

      const marker = stdout.indexOf('OUTPUT_B64:')
      if (marker === -1) throw new Error(stdout.slice(0, 200))

      const b64 = stdout.slice(marker + 11).split('\n')[0].trim()
      const bytes = atob(b64)
      const arr = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
      const blob = new Blob([arr], { type: 'application/pdf' })
      setResultBlob(blob)
      setStatus({ type: 'success', msg: 'Готово! Файл обработан.' })
    } catch (e: unknown) {
      setStatus({ type: 'error', msg: e instanceof Error ? e.message : 'Ошибка' })
    }
  }

  const download = () => {
    if (!resultBlob) return
    const url = URL.createObjectURL(resultBlob)
    const a = document.createElement('a')
    const toolLabel = TOOLS.find(t => t.id === activeTool)?.label.toLowerCase().replace(/ /g, '_') || 'edited'
    a.href = url
    a.download = pdfFilename.replace('.pdf', `_${toolLabel}.pdf`)
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>

        <header className={styles.header}>
          <div className={styles.headerIcon}><i className="ti ti-file-text" /></div>
          <div>
            <h1 className={styles.title}>PDF Editor</h1>
            <p className={styles.subtitle}>Редактирование PDF прямо в браузере — без серверов</p>
          </div>
        </header>

        {/* Upload */}
        <div
          className={`${styles.uploadZone} ${pdfBase64 ? styles.hasFile : ''} ${isDragging ? styles.dragging : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]) }}
          role="button" tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
        >
          <i className={`ti ${pdfBase64 ? 'ti-circle-check' : 'ti-upload'}`} style={{ fontSize: 30, display: 'block', marginBottom: 8 }} />
          <span className={styles.uploadLabel}>{pdfBase64 ? pdfFilename : 'Нажмите или перетащите PDF-файл'}</span>
          {pdfBase64 && <span className={styles.uploadSub}>Нажмите чтобы заменить</span>}
        </div>
        <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) loadFile(e.target.files[0]) }} />

        {/* Tools */}
        {pdfBase64 && (
          <>
            <div className={styles.sectionLabel}>Выберите операцию</div>
            <div className={styles.toolGrid}>
              {TOOLS.map(t => (
                <button
                  key={t.id}
                  className={`${styles.toolCard} ${activeTool === t.id ? styles.toolCardActive : ''}`}
                  onClick={() => { setActiveTool(t.id); setResultBlob(null); setStatus({ type: 'idle', msg: '' }) }}
                >
                  <i className={`ti ${t.icon}`} style={{ fontSize: 22, marginBottom: 6, display: 'block' }} />
                  <span className={styles.toolLabel}>{t.label}</span>
                  <span className={styles.toolDesc}>{t.desc}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Params */}
        {activeTool && pdfBase64 && (
          <div className={styles.paramsBox}>
            {activeTool === 'replace_text' && (
              <div className={styles.paramGroup}>
                <label className={styles.paramLabel}>Найти текст</label>
                <input className={styles.paramInput} value={params.replace_text.find} onChange={e => setParam('replace_text', 'find', e.target.value)} placeholder="Текст для поиска..." />
                <label className={styles.paramLabel}>Заменить на</label>
                <input className={styles.paramInput} value={params.replace_text.replace} onChange={e => setParam('replace_text', 'replace', e.target.value)} placeholder="Новый текст..." />
                <p className={styles.paramHint}>Работает только для текстовых PDF (не сканов). Регистр учитывается.</p>
              </div>
            )}
            {activeTool === 'watermark' && (
              <div className={styles.paramGroup}>
                <label className={styles.paramLabel}>Текст водяного знака</label>
                <input className={styles.paramInput} value={params.watermark.text} onChange={e => setParam('watermark', 'text', e.target.value)} placeholder="КОНФИДЕНЦИАЛЬНО" />
                <label className={styles.paramLabel}>Прозрачность: {params.watermark.opacity}%</label>
                <input type="range" min="5" max="80" value={params.watermark.opacity} onChange={e => setParam('watermark', 'opacity', e.target.value)} className={styles.paramRange} />
                <label className={styles.paramLabel}>Цвет</label>
                <div className={styles.radioGroup}>
                  {[['gray','Серый'],['red','Красный'],['blue','Синий']].map(([v,l]) => (
                    <label key={v} className={styles.radioLabel}>
                      <input type="radio" name="wmcolor" value={v} checked={params.watermark.color === v} onChange={() => setParam('watermark', 'color', v)} /> {l}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {activeTool === 'delete_pages' && (
              <div className={styles.paramGroup}>
                <label className={styles.paramLabel}>Страницы для удаления</label>
                <input className={styles.paramInput} value={params.delete_pages.pages} onChange={e => setParam('delete_pages', 'pages', e.target.value)} placeholder="Например: 1, 3, 5-7" />
                <p className={styles.paramHint}>Формат: 1, 3, 5-7 (страницы нумеруются с 1)</p>
              </div>
            )}
            {activeTool === 'extract_pages' && (
              <div className={styles.paramGroup}>
                <label className={styles.paramLabel}>Страницы для извлечения</label>
                <input className={styles.paramInput} value={params.extract_pages.pages} onChange={e => setParam('extract_pages', 'pages', e.target.value)} placeholder="Например: 1-3, 5" />
                <p className={styles.paramHint}>Формат: 1-3, 5 (страницы нумеруются с 1)</p>
              </div>
            )}
            {activeTool === 'page_numbers' && (
              <div className={styles.paramGroup}>
                <label className={styles.paramLabel}>Расположение</label>
                <div className={styles.radioGroup}>
                  {[['bottom_center','Снизу по центру'],['bottom_right','Снизу справа'],['bottom_left','Снизу слева'],['top_center','Сверху по центру']].map(([v,l]) => (
                    <label key={v} className={styles.radioLabel}>
                      <input type="radio" name="numpos" value={v} checked={params.page_numbers.position === v} onChange={() => setParam('page_numbers', 'position', v)} /> {l}
                    </label>
                  ))}
                </div>
                <label className={styles.paramLabel}>Размер шрифта: {params.page_numbers.size}px</label>
                <input type="range" min="8" max="18" value={params.page_numbers.size} onChange={e => setParam('page_numbers', 'size', e.target.value)} className={styles.paramRange} />
              </div>
            )}
            {activeTool === 'rotate' && (
              <div className={styles.paramGroup}>
                <label className={styles.paramLabel}>Страницы для поворота</label>
                <input className={styles.paramInput} value={params.rotate.pages} onChange={e => setParam('rotate', 'pages', e.target.value)} placeholder="all или 1, 2-4" />
                <p className={styles.paramHint}>Введите all для всех страниц или номера: 1, 3-5</p>
                <label className={styles.paramLabel}>Угол поворота</label>
                <div className={styles.radioGroup}>
                  {[['90','90° →'],['180','180°'],['270','270° ←']].map(([v,l]) => (
                    <label key={v} className={styles.radioLabel}>
                      <input type="radio" name="angle" value={v} checked={params.rotate.angle === v} onChange={() => setParam('rotate', 'angle', v)} /> {l}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <button
              className={styles.runBtn}
              onClick={runTool}
              disabled={status.type === 'loading'}
            >
              {status.type === 'loading'
                ? <><span className={styles.spinner} /> {status.msg}</>
                : <><i className="ti ti-player-play" /> Выполнить</>
              }
            </button>
          </div>
        )}

        {/* Status */}
        {status.type === 'success' && resultBlob && (
          <div className={styles.downloadBar}>
            <i className="ti ti-circle-check" style={{ fontSize: 20, color: '#3B6D11' }} />
            <span>{status.msg}</span>
            <button className={styles.downloadBtn} onClick={download}>
              <i className="ti ti-download" /> Скачать PDF
            </button>
          </div>
        )}
        {status.type === 'error' && (
          <div className={styles.errorBar}>
            <i className="ti ti-alert-circle" style={{ fontSize: 18 }} />
            <span>{status.msg}</span>
          </div>
        )}

        <p className={styles.note}>Файлы обрабатываются локально в браузере · Ничего не отправляется на сервер</p>
      </div>
    </div>
  )
}
