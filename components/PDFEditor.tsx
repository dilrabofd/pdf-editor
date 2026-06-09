'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import styles from './PDFEditor.module.css'

interface Message {
  role: 'user' | 'assistant'
  text: string
  isError?: boolean
}

interface ApiMessage {
  role: 'user' | 'assistant'
  content: string | ApiContent[]
}

interface ApiContent {
  type: string
  source?: { type: string; media_type: string; data: string }
  text?: string
}

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

const QUICK_CMDS = [
  { label: 'Заменить текст', cmd: 'Замени все вхождения слова ___ на ___' },
  { label: 'Водяной знак', cmd: 'Добавь водяной знак "КОНФИДЕНЦИАЛЬНО" на все страницы' },
  { label: 'Удалить страницы', cmd: 'Удали страницы с ___ по ___' },
  { label: 'Номера страниц', cmd: 'Добавь номера страниц снизу по центру' },
  { label: 'Разбить PDF', cmd: 'Извлеки страницы с ___ по ___ в отдельный файл' },
  { label: 'Повернуть страницу', cmd: 'Поверни страницу ___ на 90 градусов' },
]

export default function PDFEditor() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', text: 'Привет! Загрузи PDF-файл, затем напиши что нужно сделать — заменить текст, добавить водяной знак, удалить страницы, и т.д.' },
  ])
  const [input, setInput] = useState('')
  const [pdfBase64, setPdfBase64] = useState<string | null>(null)
  const [pdfFilename, setPdfFilename] = useState('')
  const [loading, setLoading] = useState(false)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultFilename, setResultFilename] = useState('')
  const [pyodideReady, setPyodideReady] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef<ApiMessage[]>([])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const addMsg = (msg: Message) => setMessages(prev => [...prev, msg])

  const loadFile = useCallback((file: File) => {
    if (file.type !== 'application/pdf') return
    setPdfFilename(file.name)
    setResultBlob(null)
    const reader = new FileReader()
    reader.onload = () => {
      const b64 = (reader.result as string).split(',')[1]
      setPdfBase64(b64)
      addMsg({ role: 'assistant', text: `Файл «${file.name}» загружен (${(file.size / 1024).toFixed(0)} KB). Что нужно изменить?` })
    }
    reader.readAsDataURL(file)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) loadFile(file)
  }, [loadFile])

  const loadPyodideEnv = async (): Promise<PyodideInterface> => {
    if (window._pyodide) return window._pyodide
    addMsg({ role: 'assistant', text: 'Загружаю Python-среду в браузере (~10 сек, только первый раз)...' })
    await new Promise<void>((resolve) => {
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
    setPyodideReady(true)
    return py
  }

  const executePython = async (code: string, outFilename: string, b64: string) => {
    const py = await loadPyodideEnv()
    const initCode = `
import sys, os, base64
os.makedirs('/tmp', exist_ok=True)
_pdf_b64 = """${b64}"""
with open('/tmp/input.pdf', 'wb') as _f:
    _f.write(base64.b64decode(_pdf_b64))
`
    const checkCode = `
import base64 as _b64, os as _os
if _os.path.exists('/tmp/output.pdf'):
    with open('/tmp/output.pdf','rb') as _rf:
        print("OUTPUT_B64:" + _b64.b64encode(_rf.read()).decode())
else:
    print("ERROR:output.pdf not created")
`
    let stdout = ''
    py.setStdout({ batched: (s: string) => { stdout += s + '\n' } })
    py.setStderr({ batched: (s: string) => { stdout += 'ERR:' + s + '\n' } })
    await py.runPythonAsync(initCode + '\n' + code + '\n' + checkCode)

    const marker = stdout.indexOf('OUTPUT_B64:')
    if (marker === -1) {
      addMsg({ role: 'assistant', text: `Ошибка выполнения: ${stdout.slice(0, 300)}`, isError: true })
      return
    }
    const resultB64 = stdout.slice(marker + 11).split('\n')[0].trim()
    const bytes = atob(resultB64)
    const arr = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    const blob = new Blob([arr], { type: 'application/pdf' })
    setResultBlob(blob)
    setResultFilename(outFilename)
    addMsg({ role: 'assistant', text: `Готово! PDF обработан. Нажми кнопку «Скачать» ниже.` })
  }

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setLoading(true)
    setResultBlob(null)
    addMsg({ role: 'user', text })

    const userContent: ApiContent[] = []
    if (pdfBase64) {
      userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } })
    }
    userContent.push({ type: 'text', text })
    historyRef.current.push({ role: 'user', content: userContent })

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: historyRef.current }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'API error')

      const raw = data.content?.filter((c: ApiContent) => c.type === 'text').map((c: ApiContent) => c.text).join('') || ''
      historyRef.current.push({ role: 'assistant', content: raw })

      let parsed: { message: string; code: string | null; filename?: string }
      try {
        const cleaned = raw.replace(/```json|```/g, '').trim()
        parsed = JSON.parse(cleaned)
      } catch {
        parsed = { message: raw, code: null }
      }

      addMsg({ role: 'assistant', text: parsed.message || 'Готово.' })

      if (parsed.code && pdfBase64) {
        await executePython(parsed.code, parsed.filename || 'edited.pdf', pdfBase64)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Неизвестная ошибка'
      addMsg({ role: 'assistant', text: `Ошибка: ${msg}`, isError: true })
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const downloadResult = () => {
    if (!resultBlob) return
    const url = URL.createObjectURL(resultBlob)
    const a = document.createElement('a')
    a.href = url; a.download = resultFilename; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.headerIcon}><i className="ti ti-file-text" aria-hidden="true" /></div>
          <div>
            <h1 className={styles.title}>PDF Editor</h1>
            <p className={styles.subtitle}>Загрузите PDF и опишите изменения на русском</p>
          </div>
        </header>

        {/* Upload zone */}
        <div
          className={`${styles.uploadZone} ${pdfBase64 ? styles.hasFile : ''} ${isDragging ? styles.dragging : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          aria-label="Загрузить PDF файл"
          onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
        >
          <i className={`ti ${pdfBase64 ? 'ti-circle-check' : 'ti-upload'}`} aria-hidden="true" style={{ fontSize: 28, display: 'block', marginBottom: 6 }} />
          <span className={styles.uploadLabel}>
            {pdfBase64 ? pdfFilename : 'Нажмите или перетащите PDF-файл'}
          </span>
          {pdfBase64 && <span className={styles.uploadSub}>Нажмите чтобы заменить</span>}
        </div>
        <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.[0]) loadFile(e.target.files[0]) }} />

        {/* Quick commands */}
        <div className={styles.sectionLabel}>Быстрые команды</div>
        <div className={styles.chips}>
          {QUICK_CMDS.map((c) => (
            <button key={c.label} className={styles.chip} onClick={() => setInput(c.cmd)}>{c.label}</button>
          ))}
        </div>

        {/* Chat */}
        <div className={styles.chatBox}>
          <div className={styles.messages}>
            {messages.map((m, i) => (
              <div key={i} className={`${styles.msgRow} ${m.role === 'user' ? styles.userRow : ''}`}>
                <div className={`${styles.avatar} ${m.role === 'user' ? styles.userAvatar : styles.aiAvatar}`}>
                  {m.role === 'user' ? <i className="ti ti-user" aria-hidden="true" style={{ fontSize: 13 }} /> : 'AI'}
                </div>
                <div className={`${styles.bubble} ${m.role === 'user' ? styles.userBubble : styles.aiBubble} ${m.isError ? styles.errorBubble : ''}`}>
                  {m.text}
                </div>
              </div>
            ))}
            {loading && (
              <div className={styles.msgRow}>
                <div className={`${styles.avatar} ${styles.aiAvatar}`}>AI</div>
                <div className={`${styles.bubble} ${styles.aiBubble}`}>
                  <span className={styles.dots}><span /><span /><span /></span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          <div className={styles.inputRow}>
            <textarea
              className={styles.textarea}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Опишите изменения..."
              rows={1}
              disabled={loading}
            />
            <button
              className={styles.sendBtn}
              onClick={sendMessage}
              disabled={!input.trim() || loading}
              aria-label="Отправить"
            >
              <i className="ti ti-arrow-up" aria-hidden="true" style={{ fontSize: 16 }} />
            </button>
          </div>
        </div>

        {/* Download bar */}
        {resultBlob && (
          <div className={styles.downloadBar}>
            <i className="ti ti-circle-check" aria-hidden="true" style={{ fontSize: 20, color: '#3B6D11' }} />
            <span>{resultFilename} — обработка завершена</span>
            <button className={styles.downloadBtn} onClick={downloadResult}>
              <i className="ti ti-download" aria-hidden="true" style={{ fontSize: 14 }} />
              Скачать
            </button>
          </div>
        )}

        <p className={styles.note}>
          {pyodideReady ? '✓ Python-среда готова' : 'Python загружается в браузере при первом запросе'} · Файлы не покидают ваш браузер
        </p>
      </div>
    </div>
  )
}
