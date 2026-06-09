import { NextRequest, NextResponse } from 'next/server'

const SYSTEM_PROMPT = `You are a PDF editing expert. The user uploads a PDF and describes edits in Russian.
You must respond ONLY with a JSON object (no markdown, no extra text):
{
  "message": "Human-readable response in Russian describing what you will do or explaining a limitation",
  "code": "Complete Python 3 script that reads /tmp/input.pdf and writes /tmp/output.pdf. Use only pypdf and reportlab. Never use PyMuPDF/fitz. The script must be fully self-contained.",
  "filename": "suggested output filename in Latin chars, no spaces, .pdf extension"
}

Rules:
- If no PDF is loaded, set "code" to null and ask user to upload a file.
- For text replacement: use pypdf + reportlab overlay approach (add text box over old text).
- For watermarks: create watermark PDF with reportlab canvas then merge pages using pypdf.
- For page deletion/extraction: use pypdf PdfWriter, select pages by index (0-based).
- For page numbers: use reportlab canvas to draw numbers, overlay on each page with pypdf.
- For scanned/image PDFs: set code to null, explain the limitation in message.
- Always start imports with: from pypdf import PdfReader, PdfWriter
- Always write output to /tmp/output.pdf`

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { messages } = body

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return NextResponse.json({ error: err }, { status: response.status })
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
