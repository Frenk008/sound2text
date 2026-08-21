/**
 * dsh-sound2text — browser half.
 *
 * A floating right-docked panel (React portal-free: a plain fixed-position
 * element on document.body). It renders live captions streamed from the host
 * half over SSE, controls the capture helper via HTTP, and turns any text
 * selection inside the transcript into a queued DeepSeek prompt through the
 * runtime's sessions service — the answer streams into the main conversation.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientContext } from '../types.ts'
import { Sound2TextPanel, css } from './panel.tsx'

// Wait for the runtime sessions service so ctx.sessions exists in apply().
export const inject = ['sessions']

export function apply(ctx: ClientContext) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)

    const host = document.createElement('div')
    host.dataset.s2tRoot = ''
    document.body.append(host)

    const root = createRoot(host)
    root.render(createElement(Sound2TextPanel, { ctx }))

    return () => {
      root.unmount()
      host.remove()
      style.remove()
    }
  })
}
