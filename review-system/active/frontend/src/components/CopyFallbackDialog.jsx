import { useEffect, useId, useRef, useState } from 'react'
import { X } from '../lib/lucide.js'
import { copyText } from '../lib/clipboard'

export default function CopyFallbackDialog({ open, title, description, content, onClose }) {
  const dialogRef = useRef(null)
  const textareaRef = useRef(null)
  const previouslyFocusedRef = useRef(null)
  const dialogId = useId()
  const [copyState, setCopyState] = useState('')
  const titleId = `${dialogId}-title`
  const descriptionId = `${dialogId}-description`
  const closeLabel = `关闭${title || '复制内容'}弹窗`
  const textareaLabel = `${title || '复制内容'}，可手动全选复制`
  const copyLabel = `复制${title || '弹窗'}文本到剪贴板`

  useEffect(() => {
    if (!open) return
    setCopyState('')
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    textareaRef.current?.focus()
    textareaRef.current?.select()

    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
      if (event.key !== 'Tab') return

      const focusableElements = Array.from(
        dialogRef.current?.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ) || []
      ).filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true')

      if (focusableElements.length === 0) return
      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault()
        lastElement.focus()
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault()
        firstElement.focus()
      }
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      previouslyFocusedRef.current?.focus?.()
      previouslyFocusedRef.current = null
    }
  }, [onClose, open])

  const retryCopy = async () => {
    setCopyState('正在复制...')
    try {
      await copyText(content)
      setCopyState('已复制到剪贴板')
    } catch {
      textareaRef.current?.focus()
      textareaRef.current?.select()
      setCopyState('自动复制仍被浏览器拦截，请手动复制文本框内容')
    }
  }

  const closeFromBackdrop = (event) => {
    if (event.target === event.currentTarget) onClose?.()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm lg:p-6"
      onMouseDown={closeFromBackdrop}
      title={closeLabel}
      aria-label={`${closeLabel}，也可按 Escape`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={event => event.stopPropagation()}
        className="mx-auto flex max-h-[calc(100vh-2rem)] max-w-2xl flex-col rounded-2xl border border-blue-500/20 bg-slate-950/95 shadow-2xl lg:max-h-[calc(100vh-3rem)]"
      >
        <div className="shrink-0 flex items-start justify-between gap-4 border-b border-blue-500/10 px-5 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-blue-100">{title}</h2>
            <p id={descriptionId} className="mt-1 text-sm text-slate-400">{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={closeLabel}
            className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:text-white"
            aria-label={closeLabel}
          >
            <X size={18} />
          </button>
        </div>

        {copyState && (
          <div role="status" aria-live="polite" className="mx-5 mt-4 shrink-0 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-sm text-blue-100">
            {copyState}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <textarea
            ref={textareaRef}
            readOnly
            value={content}
            rows={8}
            aria-label={textareaLabel}
            className="min-h-48 w-full rounded-xl border border-blue-500/20 bg-slate-900/75 px-3 py-3 text-sm text-white outline-none focus:border-blue-400/60"
          />
        </div>

        <div className="shrink-0 flex flex-col-reverse gap-3 border-t border-blue-500/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={retryCopy}
            title={copyLabel}
            aria-label={copyLabel}
            className="px-4 py-2 rounded-lg border border-emerald-400/35 bg-emerald-500/10 text-sm text-emerald-100 hover:bg-emerald-500/20"
          >
            复制文本
          </button>
          <button
            type="button"
            onClick={onClose}
            title={closeLabel}
            aria-label={closeLabel}
            className="px-4 py-2 rounded-lg border border-blue-400/35 bg-blue-600/15 text-sm text-blue-100 hover:bg-blue-600/25"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
