/**
 * Minimal, faithful type surface for the parts of DeepSeek Harness this plugin
 * touches. The built artifacts never import @deepseek-ai packages at runtime:
 * the host half is loaded by the dsh composition loader as a plain Cordis
 * plugin, and the browser half receives its context through the plugin entry.
 * Vendoring the types here keeps the build free of restricted-access packages;
 * shapes follow @deepseek-ai/dsh-host-webserver and
 * @deepseek-ai/dsh-client-runtime (0.0.1-rc.1) declarations.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebRoute {
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebServer {
  register(route: WebRoute): () => void
  /** Port the server actually bound (0 = OS-assigned). */
  readonly port?: number
}

export interface PromptTextPart {
  type: 'text'
  text: string
}

export interface ISession {
  readonly sessionId: string
  prompt(content: PromptTextPart[], mode: 'queue' | 'steer'): Promise<unknown>
}

/** Opaque Agent-scoped context handle (opaque: only passed back to scope/sessionOf). */
export interface AgentScopeContext {
  readonly __agentScope: unique symbol
}

export interface SessionListState {
  ids: string[]
  current: string | undefined
}

export interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

export interface ISessions {
  readonly list: ObservableSnapshot<SessionListState>
  /** Resolve an Agent-scoped context view, or undefined when not listed. */
  scope(id: string): AgentScopeContext | undefined
  /** Resolve the session face behind an Agent-scoped context. */
  sessionOf(ctx: AgentScopeContext): ISession | undefined
}

/** Client-side Cordis context after declaration merging (host services + sessions). */
export interface Context {
  effect(setup: () => (() => void) | void): void
  webServer: WebServer
  sessions: ISessions
}

export type ClientContext = Context
